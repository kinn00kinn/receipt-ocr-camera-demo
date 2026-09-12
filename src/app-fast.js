import { PaddleOCR } from '@paddleocr/paddleocr-js';

// Stable browser-first bootstrap for the existing v2 UI.
// Default: PP-OCRv6 tiny detection + tiny recognition on WebGPU.
// ?accurate=1 enables the heavier v5 recognition model for experiments only.
// ?backend=wasm forces WASM. ?ocrSide=640..960 changes inference resolution.

const params = new URLSearchParams(location.search);
const FAST_SIDE = Math.max(480, Math.min(960, Number(params.get('ocrSide')) || 720));
const forceWasm = params.get('backend') === 'wasm';
const disableFastResize = params.get('hq') === '1';
const accurateMode = params.get('accurate') === '1';
const detectionModel = 'PP-OCRv6_tiny_det';
const recognitionModel = accurateMode ? 'PP-OCRv5_mobile_rec' : 'PP-OCRv6_tiny_rec';
const modelLabel = accurateMode ? 'v6 tiny det + v5 rec (experimental)' : 'PP-OCRv6 tiny';
const recognitionBatchSize = accurateMode ? 2 : 8;
const OCR_TIMEOUT_MS = accurateMode ? 35000 : 20000;
const originalCreate = PaddleOCR.create.bind(PaddleOCR);

function getWasmThreads() {
  if (!globalThis.crossOriginIsolated) return 1;
  return Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
}

function isCanvas(value) {
  return typeof HTMLCanvasElement !== 'undefined' && value instanceof HTMLCanvasElement;
}

function resizeCanvas(source, maxSide) {
  if (!isCanvas(source)) return { input: source, scaleX: 1, scaleY: 1, original: null };
  const max = Math.max(source.width, source.height);
  if (disableFastResize || max <= maxSide) {
    return { input: source, scaleX: 1, scaleY: 1, original: { width: source.width, height: source.height } };
  }

  const scale = maxSide / max;
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d', { alpha: false }).drawImage(source, 0, 0, width, height);

  return {
    input: canvas,
    scaleX: source.width / width,
    scaleY: source.height / height,
    original: { width: source.width, height: source.height },
  };
}

function rescalePoly(poly, scaleX, scaleY) {
  if (!Array.isArray(poly) || (scaleX === 1 && scaleY === 1)) return poly;
  return poly.map((point) => {
    if (Array.isArray(point) && point.length >= 2) return [Number(point[0]) * scaleX, Number(point[1]) * scaleY];
    if (point && typeof point === 'object' && 'x' in point && 'y' in point) {
      return { ...point, x: Number(point.x) * scaleX, y: Number(point.y) * scaleY };
    }
    return point;
  });
}

function remapResult(result, transform) {
  if (!transform.original || (transform.scaleX === 1 && transform.scaleY === 1)) return result;
  return {
    ...result,
    image: { width: transform.original.width, height: transform.original.height },
    items: (result.items || []).map((item) => ({
      ...item,
      poly: rescalePoly(item.poly, transform.scaleX, transform.scaleY),
    })),
  };
}

function setRuntimeBadge(result) {
  const badge = document.getElementById('runtimeBadge');
  if (!badge) return;
  const provider = result?.runtime?.recProvider || result?.runtime?.detProvider || (forceWasm ? 'wasm' : 'auto');
  badge.textContent = `${modelLabel} / ${String(provider).toUpperCase()} · ${FAST_SIDE}px`;
}

function showTimeoutState() {
  const title = document.getElementById('statusTitle');
  const text = document.getElementById('statusText');
  const spinner = document.getElementById('spinner');
  const notice = document.getElementById('captureNotice');
  if (title) title.textContent = 'OCRを中断しました';
  if (text) text.textContent = `OCRが${Math.round(OCR_TIMEOUT_MS / 1000)}秒以内に完了しませんでした。ページを再読み込みして再試行してください。`;
  if (spinner) spinner.hidden = true;
  if (notice) {
    notice.hidden = false;
    notice.textContent = 'OCRタイムアウト — 再読み込みしてください';
  }
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        showTimeoutState();
        reject(new Error(`OCR timeout after ${ms} ms`));
      }, ms);
    }),
  ]);
}

PaddleOCR.create = async function fastCreate(options = {}) {
  const { lang, ocrVersion, ...rest } = options;
  const engine = await originalCreate({
    ...rest,
    textDetectionModelName: detectionModel,
    textRecognitionModelName: recognitionModel,
    textDetectionBatchSize: 1,
    textRecognitionBatchSize: recognitionBatchSize,
    ortOptions: {
      ...(rest.ortOptions || {}),
      backend: forceWasm ? 'wasm' : 'auto',
      wasmPaths: 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/',
      numThreads: getWasmThreads(),
      simd: true,
    },
  });

  const originalPredict = engine.predict.bind(engine);
  engine.predict = async (input, predictOptions = {}) => {
    if (Array.isArray(input) || !isCanvas(input)) {
      const results = await withTimeout(originalPredict(input, predictOptions), OCR_TIMEOUT_MS);
      setRuntimeBadge(results?.[0]);
      return results;
    }

    const transform = resizeCanvas(input, FAST_SIDE);
    const effectiveLimit = disableFastResize
      ? predictOptions.textDetLimitSideLen
      : Math.min(Number(predictOptions.textDetLimitSideLen) || FAST_SIDE, FAST_SIDE);

    const results = await withTimeout(originalPredict(transform.input, {
      ...predictOptions,
      textDetLimitSideLen: effectiveLimit,
      textDetBoxThresh: Math.max(Number(predictOptions.textDetBoxThresh) || 0, 0.6),
    }), OCR_TIMEOUT_MS);

    const remapped = results.map((result) => remapResult(result, transform));
    const first = remapped[0];
    if (first) {
      first.runtime = {
        ...(first.runtime || {}),
        fastPath: {
          model: modelLabel,
          detectionModel,
          recognitionModel,
          recognitionBatchSize,
          inputSide: Math.max(transform.input.width || 0, transform.input.height || 0),
          displaySide: transform.original ? Math.max(transform.original.width, transform.original.height) : null,
          forcedWasm: forceWasm,
          hq: disableFastResize,
          accurateMode,
          timeoutMs: OCR_TIMEOUT_MS,
        },
      };
    }
    setRuntimeBadge(first);
    return remapped;
  };

  return engine;
};

const badge = document.getElementById('runtimeBadge');
if (badge) badge.textContent = `${modelLabel} / WebGPU preferred · ${FAST_SIDE}px`;

await import('./app-v2.js');
await import('./ui-extras.js');

if (badge && !badge.textContent.includes('v6')) {
  badge.textContent = `${modelLabel} / WebGPU preferred · ${FAST_SIDE}px`;
}
