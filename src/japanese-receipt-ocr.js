import * as ort from 'onnxruntime-web/webgpu';
import { Image as PaddleImage, RecognitionService, getTextRecognitionPresetOptions } from 'paddleocr';

const MODEL_BASE = 'https://huggingface.co/x3zvawq/paddleocr-js-onnx/resolve/main/ppocr_v5_mobile';
const MODEL_URL = `${MODEL_BASE}/PP-OCRv5_mobile_rec_infer.onnx`;
const DICT_URL = `${MODEL_BASE}/ppocrv5_dict.txt`;
const CACHE_NAME = 'receipt-ocr-models-v2';
const WASM_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/';

ort.env.wasm.wasmPaths = WASM_CDN;
ort.env.wasm.numThreads = 1;

function now() { return performance.now(); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchCached(url) {
  if ('caches' in globalThis) {
    try {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(url);
      if (hit) return hit;
      const response = await fetch(url, { mode: 'cors', cache: 'force-cache' });
      if (!response.ok) throw new Error(`asset fetch failed: ${response.status}`);
      await cache.put(url, response.clone());
      return response;
    } catch (error) {
      console.warn('[Japanese receipt OCR] CacheStorage fallback', error);
    }
  }
  const response = await fetch(url, { mode: 'cors', cache: 'force-cache' });
  if (!response.ok) throw new Error(`asset fetch failed: ${response.status}`);
  return response;
}

function canvasToPaddleImage(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const bytes = new Uint8Array(imageData.data.length);
  bytes.set(imageData.data);
  return new PaddleImage(canvas.width, canvas.height, 4, bytes);
}

function resizeForSegmentation(source, maxSide = 720) {
  const max = Math.max(source.width, source.height);
  if (max <= maxSide) return { canvas: source, scaleX: 1, scaleY: 1, temporary: false };
  const scale = maxSide / max;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return { canvas, scaleX: source.width / canvas.width, scaleY: source.height / canvas.height, temporary: true };
}

function otsuThreshold(gray, histogram) {
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i];
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let maxVariance = 0;
  let threshold = 180;
  for (let t = 0; t < 256; t += 1) {
    backgroundWeight += histogram[t];
    if (!backgroundWeight) continue;
    const foregroundWeight = total - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += t * histogram[t];
    const meanBackground = backgroundSum / backgroundWeight;
    const meanForeground = (sum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (meanBackground - meanForeground) ** 2;
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = t;
    }
  }
  return clamp(threshold, 95, 215);
}

function mergeRuns(runs, maxGap) {
  if (!runs.length) return [];
  const merged = [{ ...runs[0] }];
  for (let i = 1; i < runs.length; i += 1) {
    const prev = merged[merged.length - 1];
    const cur = runs[i];
    if (cur.start - prev.end - 1 <= maxGap) prev.end = cur.end;
    else merged.push({ ...cur });
  }
  return merged;
}

function runsFromMask(values, predicate) {
  const runs = [];
  let start = null;
  for (let i = 0; i < values.length; i += 1) {
    if (predicate(values[i], i)) {
      if (start == null) start = i;
    } else if (start != null) {
      runs.push({ start, end: i - 1 });
      start = null;
    }
  }
  if (start != null) runs.push({ start, end: values.length - 1 });
  return runs;
}

function segmentReceiptLines(source) {
  const t0 = now();
  const scaled = resizeForSegmentation(source, 720);
  const canvas = scaled.canvas;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = canvas;
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const gray = new Uint8Array(width * height);
  const histogram = new Uint32Array(256);

  for (let i = 0, p = 0; i < rgba.length; i += 4, p += 1) {
    const g = Math.round(rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114);
    gray[p] = g;
    histogram[g] += 1;
  }

  const otsu = otsuThreshold(gray, histogram);
  const darkThreshold = Math.min(205, otsu + 18);
  const rowInk = new Uint32Array(height);
  const leftMargin = Math.round(width * 0.025);
  const rightMargin = Math.round(width * 0.975);

  for (let y = 0; y < height; y += 1) {
    let count = 0;
    const offset = y * width;
    for (let x = leftMargin; x < rightMargin; x += 1) {
      if (gray[offset + x] < darkThreshold) count += 1;
    }
    rowInk[y] = count;
  }

  const smooth = new Float32Array(height);
  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    let n = 0;
    for (let k = -2; k <= 2; k += 1) {
      const yy = y + k;
      if (yy >= 0 && yy < height) { sum += rowInk[yy]; n += 1; }
    }
    smooth[y] = sum / n;
  }

  const rowThreshold = Math.max(2.5, width * 0.010);
  let rowRuns = runsFromMask(smooth, (v) => v >= rowThreshold);
  rowRuns = mergeRuns(rowRuns, Math.max(2, Math.round(height * 0.005)));

  const rows = [];
  const boxes = [];
  let rowIndex = 0;
  for (const run of rowRuns) {
    const rawHeight = run.end - run.start + 1;
    if (rawHeight < 3 || rawHeight > Math.max(48, height * 0.10)) continue;
    let ink = 0;
    let spanPixels = 0;
    const colInk = new Uint16Array(width);
    for (let y = run.start; y <= run.end; y += 1) {
      const offset = y * width;
      for (let x = leftMargin; x < rightMargin; x += 1) {
        if (gray[offset + x] < darkThreshold) {
          ink += 1;
          colInk[x] += 1;
        }
        spanPixels += 1;
      }
    }
    const density = spanPixels ? ink / spanPixels : 0;
    if (density < 0.002 || density > 0.70) continue;

    let xRuns = runsFromMask(colInk, (v) => v > 0);
    const splitGap = Math.max(8, Math.round(rawHeight * 1.05));
    xRuns = mergeRuns(xRuns, splitGap);
    const rowBoxes = [];
    for (const xr of xRuns) {
      const w = xr.end - xr.start + 1;
      if (w < Math.max(3, rawHeight * 0.28)) continue;
      const padX = Math.max(2, Math.round(rawHeight * 0.20));
      const padY = Math.max(2, Math.round(rawHeight * 0.18));
      const x0 = clamp(xr.start - padX, 0, width - 1);
      const y0 = clamp(run.start - padY, 0, height - 1);
      const x1 = clamp(xr.end + padX, x0 + 1, width - 1);
      const y1 = clamp(run.end + padY, y0 + 1, height - 1);
      const box = {
        x: Math.round(x0 * scaled.scaleX),
        y: Math.round(y0 * scaled.scaleY),
        width: Math.max(1, Math.round((x1 - x0 + 1) * scaled.scaleX)),
        height: Math.max(1, Math.round((y1 - y0 + 1) * scaled.scaleY)),
        rowIndex,
      };
      box.centerY = box.y + box.height / 2;
      box.rightRatio = (box.x + box.width) / source.width;
      rowBoxes.push(box);
      boxes.push(box);
    }
    if (rowBoxes.length) {
      rows.push({ index: rowIndex, boxes: rowBoxes, y: rowBoxes.reduce((s, b) => s + b.centerY, 0) / rowBoxes.length });
      rowIndex += 1;
    }
  }

  if (scaled.temporary) {
    canvas.width = 1;
    canvas.height = 1;
  }
  return { boxes, rows, threshold: darkThreshold, otsu, ms: now() - t0 };
}

function rowText(results, rowIndex) {
  return results
    .filter((r) => r._rowIndex === rowIndex)
    .sort((a, b) => a.box.x - b.box.x)
    .map((r) => r.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasDate(text) {
  return /(?:20\d{2}|\d{2})\s*[\/\.\-年]\s*\d{1,2}\s*[\/\.\-月]\s*\d{1,2}/.test(text);
}

function hasTotal(text) {
  return /(総合計|合計|お支払|お買上|現計|TOTAL|税込合計)/i.test(text) && /[¥￥]?\s*\d{2,7}/.test(text);
}

function buildEssentialOrder(rows, sourceHeight) {
  const seen = new Set();
  const order = [];
  const add = (row) => {
    if (!row || seen.has(row.index)) return;
    seen.add(row.index);
    order.push(row);
  };

  rows.slice(0, 8).forEach(add);
  rows
    .filter((row) => row.y / sourceHeight >= 0.32 && row.y / sourceHeight <= 0.80)
    .sort((a, b) => b.y - a.y)
    .forEach(add);
  rows.forEach(add);
  return order;
}

function polyFromBox(box) {
  return [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x + box.width, box.y + box.height],
    [box.x, box.y + box.height],
  ];
}

export class JapaneseReceiptOcrEngine {
  constructor({ detail = false, onStatus = null } = {}) {
    this.detail = detail;
    this.onStatus = onStatus;
    this.session = null;
    this.recognizer = null;
    this.provider = null;
    this.initPromise = null;
    this.initMs = null;
    this.disposed = false;
  }

  async initialize() {
    if (this.disposed) throw new Error('Japanese OCR engine disposed');
    if (this.recognizer) return this;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._initialize();
    return this.initPromise;
  }

  async _initialize() {
    const t0 = now();
    this.onStatus?.('日本語モデルを準備中', '検出モデルなし。PP-OCRv5 recognitionのみ読み込みます。');
    const [modelResponse, dictResponse] = await Promise.all([fetchCached(MODEL_URL), fetchCached(DICT_URL)]);
    const [modelBuffer, dictText] = await Promise.all([modelResponse.arrayBuffer(), dictResponse.text()]);
    let dictionary = dictText.split(/\r?\n/);
    if (dictionary.at(-1) === '') dictionary.pop();
    if (!dictionary.includes(' ')) dictionary = [...dictionary, ' '];

    const createSession = async (executionProviders) => ort.InferenceSession.create(modelBuffer, {
      executionProviders,
      graphOptimizationLevel: 'all',
      enableMemPattern: true,
      enableCpuMemArena: true,
    });

    try {
      if (!navigator.gpu) throw new Error('WebGPU unavailable');
      this.session = await createSession(['webgpu', 'wasm']);
      this.provider = 'webgpu';
    } catch (error) {
      console.warn('[Japanese receipt OCR] WebGPU session failed; using WASM', error);
      this.session = await createSession(['wasm']);
      this.provider = 'wasm';
    }

    this.recognizer = new RecognitionService(ort, this.session, {
      ...getTextRecognitionPresetOptions('PP-OCRv5_mobile_rec'),
      charactersDictionary: dictionary,
      imageHeight: 48,
      imageWidth: 320,
    });
    this.initMs = now() - t0;
    this.onStatus?.('日本語モデル準備完了', `${this.provider.toUpperCase()} / recognition-only / ${Math.round(this.initMs)} ms`);
    return this;
  }

  async recognizeBox(image, box) {
    const [result] = await this.recognizer.run(image, [box], {
      ordering: { sortByReadingOrder: false },
      recognition: { imageHeight: 48, imageWidth: 320 },
    });
    if (!result || !result.text?.trim()) return null;
    result._rowIndex = box.rowIndex;
    return result;
  }

  async predict(source) {
    if (this.disposed) throw new Error('Japanese OCR engine disposed');
    if (!(source instanceof HTMLCanvasElement)) throw new Error('Japanese receipt mode requires a canvas input');
    const totalStarted = now();
    await this.initialize();

    const segmentation = segmentReceiptLines(source);
    const image = canvasToPaddleImage(source);
    const results = [];
    const processedRows = new Set();
    const rowOrder = this.detail ? segmentation.rows : buildEssentialOrder(segmentation.rows, source.height);
    const maxRows = this.detail ? Math.min(36, rowOrder.length) : Math.min(18, rowOrder.length);
    let foundDate = false;
    let foundTotal = false;
    let totalRowIndex = null;
    const recStarted = now();

    for (const row of rowOrder.slice(0, maxRows)) {
      for (const box of row.boxes.slice(0, 4)) {
        const result = await this.recognizeBox(image, box);
        if (result) results.push(result);
      }
      processedRows.add(row.index);
      const text = rowText(results, row.index);
      foundDate ||= hasDate(text);
      if (hasTotal(text)) {
        foundTotal = true;
        totalRowIndex = row.index;
      }

      if (!this.detail && foundDate && foundTotal) {
        const neighbors = segmentation.rows.filter((candidate) =>
          candidate.index >= totalRowIndex - 3 && candidate.index <= totalRowIndex + 1 && !processedRows.has(candidate.index));
        for (const neighbor of neighbors) {
          for (const box of neighbor.boxes.slice(0, 4)) {
            const result = await this.recognizeBox(image, box);
            if (result) results.push(result);
          }
          processedRows.add(neighbor.index);
        }
        break;
      }
      if (!this.detail) await sleep(0);
    }

    results.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    const recMs = now() - recStarted;
    const items = results.map((result) => ({
      text: result.text,
      score: result.confidence,
      poly: polyFromBox(result.box),
    }));

    const totalMs = now() - totalStarted;
    return [{
      image: { width: source.width, height: source.height },
      items,
      metrics: {
        detMs: segmentation.ms,
        recMs,
        totalMs,
        detectedBoxes: segmentation.boxes.length,
        recognizedCount: items.length,
      },
      runtime: {
        requestedBackend: 'webgpu-first',
        detProvider: 'projection-profile',
        recProvider: this.provider,
        receiptFastPath: {
          engine: 'paddleocr.js RecognitionService',
          model: 'PP-OCRv5_mobile_rec',
          detectorModel: null,
          detectorSkipped: true,
          segmentation: 'Otsu + horizontal/vertical projection',
          detail: this.detail,
          segmentedRows: segmentation.rows.length,
          segmentedBoxes: segmentation.boxes.length,
          processedRows: processedRows.size,
          recognizedBoxes: items.length,
          threshold: segmentation.threshold,
          otsu: segmentation.otsu,
          modelInitMs: this.initMs,
        },
      },
    }];
  }

  async dispose() {
    this.disposed = true;
    try { await this.session?.release?.(); } catch {}
    this.session = null;
    this.recognizer = null;
    this.initPromise = null;
  }
}
