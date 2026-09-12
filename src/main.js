import './style.css';
import { PaddleOCR } from '@paddleocr/paddleocr-js';

const MAX_OCR_SIDE = 1280;
const LIVE_OCR_SIDE = 720;
const LIVE_INTERVAL_MS = 2500;
const $ = (id) => document.getElementById(id);

const camera = $('camera');
const captureCanvas = $('captureCanvas');
const resultCanvas = $('resultCanvas');
const startCameraButton = $('startCameraButton');
const captureButton = $('captureButton');
const liveToggleButton = $('liveToggleButton');
const fileInput = $('fileInput');
const retryButton = $('retryButton');
const cameraPlaceholder = $('cameraPlaceholder');
const resultSection = $('resultSection');
const ocrItems = $('ocrItems');
const rawJson = $('rawJson');
const structuredJson = $('structuredJson');
const debugJson = $('debugJson');
const timingRows = $('timingRows');
const receiptItems = $('receiptItems');
const merchantCandidate = $('merchantCandidate');
const totalCandidate = $('totalCandidate');
const subtotalCandidate = $('subtotalCandidate');
const taxCandidate = $('taxCandidate');
const dateCandidate = $('dateCandidate');
const ocrTime = $('ocrTime');
const itemCount = $('itemCount');
const lineCount = $('lineCount');
const statusTitle = $('statusTitle');
const statusText = $('statusText');
const statusDot = $('statusDot');
const spinner = $('spinner');
const liveState = $('liveState');
const liveTiming = $('liveTiming');
const livePassCount = $('livePassCount');
const liveText = $('liveText');

let stream = null;
let ocr = null;
let ocrPromise = null;
let modelInitMs = null;
let modelInitStartedAt = null;
let stillOcrBusy = false;
let liveActive = false;
let liveBusy = false;
let liveTimer = null;
let livePasses = 0;

function setStatus(title, text, { busy = false, error = false, success = false } = {}) {
  statusTitle.textContent = title;
  statusText.textContent = text;
  spinner.hidden = !busy;
  statusDot.className = 'status-dot';
  if (busy) statusDot.classList.add('is-busy');
  if (error) statusDot.classList.add('is-error');
  if (success) statusDot.classList.add('is-success');
}

async function prepareOcr() {
  if (ocr) return ocr;
  if (ocrPromise) return ocrPromise;

  modelInitStartedAt = performance.now();
  setStatus(
    'OCRモデルを読み込み中',
    'PP-OCRv5 と WASM 実行環境を先読みしています。初回のみ時間がかかります。',
    { busy: true },
  );

  ocrPromise = PaddleOCR.create({
    lang: 'japan',
    ocrVersion: 'PP-OCRv5',
    worker: false,
    ortOptions: {
      backend: 'wasm',
      wasmPaths: 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/',
      numThreads: 1,
      simd: true,
    },
  })
    .then((instance) => {
      modelInitMs = performance.now() - modelInitStartedAt;
      ocr = instance;
      setStatus('OCR準備完了', `モデル初期化 ${formatDuration(modelInitMs)}。撮影すると端末内で文字認識します。`, { success: true });
      console.debug('[Receipt OCR] model ready', { modelInitMs });
      return instance;
    })
    .catch((error) => {
      modelInitMs = performance.now() - modelInitStartedAt;
      ocrPromise = null;
      setStatus('OCRの準備に失敗', friendlyError(error), { error: true });
      console.error('[Receipt OCR] model init failed', error);
      throw error;
    });

  return ocrPromise;
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('カメラAPIを利用できません', '下の「写真を選択 / 撮影」を使ってください。', { error: true });
    return;
  }

  try {
    startCameraButton.disabled = true;
    setStatus('カメラを起動中', 'ブラウザのカメラ許可を承認してください。', { busy: true });

    if (stream) stopCamera();

    const startedAt = performance.now();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 1920 },
      },
    });

    camera.srcObject = stream;
    await camera.play();
    const cameraStartMs = performance.now() - startedAt;

    cameraPlaceholder.hidden = true;
    captureButton.disabled = false;
    liveToggleButton.disabled = false;
    startCameraButton.textContent = 'カメラを再起動';

    if (ocr) {
      setStatus('カメラ・OCR準備完了', `カメラ起動 ${formatDuration(cameraStartMs)}。撮影またはリアルタイムOCRを開始できます。`, { success: true });
    } else {
      setStatus('カメラ準備完了', `カメラ起動 ${formatDuration(cameraStartMs)}。OCRモデルは先読み中です。`, { success: true });
      prepareOcr().catch(() => {});
    }
  } catch (error) {
    setStatus('カメラを起動できません', cameraErrorMessage(error), { error: true });
  } finally {
    startCameraButton.disabled = false;
  }
}

function stopCamera() {
  stopLiveOcr();
  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
  stream = null;
  camera.srcObject = null;
  liveToggleButton.disabled = true;
}

async function captureFromCamera() {
  if (!camera.videoWidth || !camera.videoHeight || stillOcrBusy) return;

  const totalStartedAt = performance.now();
  const sourceSize = { width: camera.videoWidth, height: camera.videoHeight };
  const { width, height } = scaledSize(camera.videoWidth, camera.videoHeight, MAX_OCR_SIDE);

  const preprocessStartedAt = performance.now();
  captureCanvas.width = width;
  captureCanvas.height = height;
  captureCanvas.getContext('2d', { alpha: false }).drawImage(camera, 0, 0, width, height);
  const preprocessMs = performance.now() - preprocessStartedAt;

  await runStillOcr(captureCanvas, {
    sourceType: 'camera',
    sourceSize,
    processedSize: { width, height },
    preprocessMs,
    totalStartedAt,
  });
}

async function loadFile(file) {
  if (!file || stillOcrBusy) return;

  const totalStartedAt = performance.now();
  try {
    const decodeStartedAt = performance.now();
    const image = await fileToImage(file);
    const decodeMs = performance.now() - decodeStartedAt;

    const preprocessStartedAt = performance.now();
    const { canvas, width, height } = imageToCanvas(image, MAX_OCR_SIDE);
    const preprocessMs = performance.now() - preprocessStartedAt;

    await runStillOcr(canvas, {
      sourceType: 'file',
      file: { name: file.name, type: file.type, size: file.size },
      sourceSize: { width: image.naturalWidth, height: image.naturalHeight },
      processedSize: { width, height },
      decodeMs,
      preprocessMs,
      totalStartedAt,
    });
  } catch (error) {
    setStatus('画像を読み込めませんでした', friendlyError(error), { error: true });
  } finally {
    fileInput.value = '';
  }
}

async function runStillOcr(source, meta = {}) {
  stillOcrBusy = true;
  captureButton.disabled = true;
  startCameraButton.disabled = true;
  setStatus('OCR実行中', '文字領域を検出し、日本語を認識しています。', { busy: true });

  const totalStartedAt = meta.totalStartedAt ?? performance.now();
  const timing = {
    decodeMs: meta.decodeMs ?? null,
    preprocessMs: meta.preprocessMs ?? null,
    modelInitMs,
    modelWaitMs: null,
    predictMs: null,
    rowBuildMs: null,
    parseMs: null,
    renderMs: null,
    totalMs: null,
  };
  const modelWasReadyBeforeRun = Boolean(ocr);

  try {
    const modelWaitStartedAt = performance.now();
    const engine = await prepareOcr();
    timing.modelWaitMs = performance.now() - modelWaitStartedAt;
    timing.modelInitMs = modelInitMs;

    while (liveBusy) {
      await delay(50);
    }

    const predictStartedAt = performance.now();
    const [result] = await engine.predict(source, {
      textRecScoreThresh: 0.35,
      textDetBoxThresh: 0.45,
    });
    timing.predictMs = performance.now() - predictStartedAt;

    const rowBuildStartedAt = performance.now();
    const rows = groupItemsIntoRows(result.items ?? []);
    timing.rowBuildMs = performance.now() - rowBuildStartedAt;

    const parseStartedAt = performance.now();
    const receipt = parseReceipt(rows);
    timing.parseMs = performance.now() - parseStartedAt;

    const renderStartedAt = performance.now();
    renderResult(source, result, rows, receipt);
    timing.renderMs = performance.now() - renderStartedAt;
    timing.totalMs = performance.now() - totalStartedAt;

    ocrTime.textContent = formatDuration(timing.totalMs);
    renderTimings(timing);

    const debug = buildDebugPayload({ meta, timing, modelWasReadyBeforeRun, result, rows, receipt });
    debugJson.textContent = JSON.stringify(debug, null, 2);
    console.debug('[Receipt OCR] still run debug', debug);

    setStatus(
      'OCR完了',
      `${result.items?.length ?? 0} boxes → ${rows.length} 行 → ${receipt.items.length} 商品候補。総処理 ${formatDuration(timing.totalMs)}。`,
      { success: true },
    );
    resultSection.hidden = false;
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    console.error('[Receipt OCR] still OCR error', error);
    setStatus('OCRに失敗しました', friendlyError(error), { error: true });
  } finally {
    stillOcrBusy = false;
    captureButton.disabled = !stream;
    startCameraButton.disabled = false;
  }
}

function toggleLiveOcr() {
  if (liveActive) stopLiveOcr();
  else startLiveOcr();
}

async function startLiveOcr() {
  if (!stream || !camera.videoWidth || liveActive) return;
  liveActive = true;
  livePasses = 0;
  liveToggleButton.textContent = '停止';
  liveToggleButton.classList.add('is-live');
  liveState.textContent = '実行中';
  liveText.textContent = 'OCRモデルを準備しています…';

  try {
    await prepareOcr();
  } catch {
    stopLiveOcr();
    return;
  }

  scheduleLivePass(0);
}

function stopLiveOcr() {
  liveActive = false;
  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = null;
  liveToggleButton.textContent = '開始';
  liveToggleButton.classList.remove('is-live');
  liveState.textContent = '停止中';
}

function scheduleLivePass(delayMs = LIVE_INTERVAL_MS) {
  if (!liveActive) return;
  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = setTimeout(runLivePass, delayMs);
}

async function runLivePass() {
  if (!liveActive) return;
  if (!stream || !camera.videoWidth) {
    stopLiveOcr();
    return;
  }

  if (liveBusy || stillOcrBusy) {
    scheduleLivePass(400);
    return;
  }

  liveBusy = true;
  const passStartedAt = performance.now();
  const canvas = document.createElement('canvas');

  try {
    const preprocessStartedAt = performance.now();
    drawLiveCrop(camera, canvas, LIVE_OCR_SIDE);
    const preprocessMs = performance.now() - preprocessStartedAt;

    const predictStartedAt = performance.now();
    const [result] = await ocr.predict(canvas, {
      textRecScoreThresh: 0.42,
      textDetBoxThresh: 0.5,
    });
    const predictMs = performance.now() - predictStartedAt;

    const rowsStartedAt = performance.now();
    const rows = groupItemsIntoRows(result.items ?? []);
    const rowBuildMs = performance.now() - rowsStartedAt;

    const parseStartedAt = performance.now();
    const receipt = parseReceipt(rows);
    const parseMs = performance.now() - parseStartedAt;

    const totalMs = performance.now() - passStartedAt;
    livePasses += 1;
    liveTiming.textContent = `${formatDuration(totalMs)} / infer ${formatDuration(predictMs)}`;
    livePassCount.textContent = `${livePasses} passes`;
    liveText.textContent = formatLiveText(rows, receipt);

    const debug = {
      pass: livePasses,
      processedSize: { width: canvas.width, height: canvas.height },
      timing: { preprocessMs, predictMs, rowBuildMs, parseMs, totalMs },
      boxes: result.items?.length ?? 0,
      rows: rows.length,
      receipt,
    };
    console.debug('[Receipt OCR] live pass', debug);
  } catch (error) {
    console.error('[Receipt OCR] live OCR error', error);
    liveText.textContent = `リアルタイムOCRエラー: ${friendlyError(error)}`;
  } finally {
    liveBusy = false;
    scheduleLivePass(LIVE_INTERVAL_MS);
  }
}

function drawLiveCrop(video, canvas, maxSide) {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  const cropWidth = Math.round(sourceWidth * 0.78);
  const cropHeight = Math.round(sourceHeight * 0.86);
  const sx = Math.round((sourceWidth - cropWidth) / 2);
  const sy = Math.round((sourceHeight - cropHeight) / 2);
  const { width, height } = scaledSize(cropWidth, cropHeight, maxSide);
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d', { alpha: false }).drawImage(video, sx, sy, cropWidth, cropHeight, 0, 0, width, height);
}

function formatLiveText(rows, receipt) {
  const summary = [];
  if (receipt.merchant) summary.push(`店名: ${receipt.merchant}`);
  if (receipt.date) summary.push(`日付: ${receipt.date}`);
  if (Number.isFinite(receipt.total)) summary.push(`合計: ${formatMoney(receipt.total)}`);
  const body = rows.slice(0, 10).map((row) => row.text).join('\n');
  return [...summary, body].filter(Boolean).join('\n');
}

function renderResult(source, result, rows, receipt) {
  drawOcrOverlay(source, result.items ?? []);
  renderItems(result.items ?? []);
  renderReceipt(receipt);

  merchantCandidate.textContent = receipt.merchant ?? '—';
  totalCandidate.textContent = formatMoney(receipt.total) ?? '—';
  subtotalCandidate.textContent = formatMoney(receipt.subtotal) ?? '—';
  taxCandidate.textContent = formatMoney(receipt.tax) ?? '—';
  dateCandidate.textContent = receipt.date ?? '—';
  itemCount.textContent = `${receipt.items.length} items`;
  lineCount.textContent = `${result.items?.length ?? 0} boxes / ${rows.length} rows`;

  structuredJson.textContent = JSON.stringify(receipt, null, 2);
  rawJson.textContent = JSON.stringify(
    { image: result.image, metrics: result.metrics, runtime: result.runtime, items: result.items },
    null,
    2,
  );
}

function drawOcrOverlay(source, items) {
  const width = source.width ?? source.videoWidth ?? source.naturalWidth;
  const height = source.height ?? source.videoHeight ?? source.naturalHeight;
  resultCanvas.width = width;
  resultCanvas.height = height;

  const ctx = resultCanvas.getContext('2d');
  ctx.drawImage(source, 0, 0, width, height);
  ctx.lineWidth = Math.max(2, width / 500);
  ctx.strokeStyle = '#0b7a75';
  ctx.fillStyle = 'rgba(11, 122, 117, 0.10)';

  items.forEach((item) => {
    const points = normalizePoly(item.poly);
    if (points.length < 3) return;
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    points.slice(1).forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  });
}

function renderItems(items) {
  ocrItems.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '文字を認識できませんでした。明るい場所で、レシートを正面から大きく撮って再度試してください。';
    ocrItems.append(empty);
    return;
  }

  items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'ocr-row';
    const num = document.createElement('span');
    num.className = 'ocr-index';
    num.textContent = String(index + 1).padStart(2, '0');
    const text = document.createElement('span');
    text.className = 'ocr-text';
    text.textContent = item.text || '(empty)';
    const score = document.createElement('span');
    score.className = `ocr-score ${scoreClass(item.score)}`;
    score.textContent = Number.isFinite(item.score) ? `${Math.round(item.score * 100)}%` : '—';
    row.append(num, text, score);
    ocrItems.append(row);
  });
}

function renderReceipt(receipt) {
  receiptItems.replaceChildren();
  if (!receipt.items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '商品行を特定できませんでした。Structured JSON で推定結果を確認できます。';
    receiptItems.append(empty);
    return;
  }

  receipt.items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'receipt-item-row';
    const name = document.createElement('span');
    name.className = 'receipt-item-name';
    name.textContent = item.name;
    const amount = document.createElement('strong');
    amount.textContent = formatMoney(item.amount) ?? '—';
    row.append(name, amount);
    receiptItems.append(row);
  });
}

function renderTimings(timing) {
  const labels = {
    decodeMs: '画像デコード',
    preprocessMs: '画像縮小 / 前処理',
    modelInitMs: 'モデル初期化（初回）',
    modelWaitMs: 'モデル待機（今回）',
    predictMs: 'OCR推論',
    rowBuildMs: '行再構成',
    parseMs: 'レシート解析',
    renderMs: '画面描画',
    totalMs: '総処理',
  };
  timingRows.replaceChildren();
  Object.entries(labels).forEach(([key, label]) => {
    const value = timing[key];
    if (!Number.isFinite(value)) return;
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    const td = document.createElement('td');
    th.textContent = label;
    td.textContent = value.toFixed(1);
    tr.append(th, td);
    timingRows.append(tr);
  });
}

function buildDebugPayload({ meta, timing, modelWasReadyBeforeRun, result, rows, receipt }) {
  return {
    timestamp: new Date().toISOString(),
    browser: {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      deviceMemoryGB: navigator.deviceMemory ?? null,
      secureContext: window.isSecureContext,
    },
    config: {
      maxOcrSide: MAX_OCR_SIDE,
      liveOcrSide: LIVE_OCR_SIDE,
      liveIntervalMs: LIVE_INTERVAL_MS,
      backend: 'wasm',
      numThreads: 1,
      simd: true,
      lang: 'japan',
      ocrVersion: 'PP-OCRv5',
    },
    input: {
      sourceType: meta.sourceType ?? 'unknown',
      sourceSize: meta.sourceSize ?? null,
      processedSize: meta.processedSize ?? null,
      file: meta.file ?? null,
    },
    model: {
      wasReadyBeforeRun: modelWasReadyBeforeRun,
      modelInitMs,
    },
    timing,
    paddle: {
      metrics: result.metrics ?? null,
      runtime: result.runtime ?? null,
      boxes: result.items?.length ?? 0,
    },
    rows: rows.map((row) => ({ text: row.text, score: row.score, y: row.y, height: row.height })),
    receipt,
  };
}

function groupItemsIntoRows(items) {
  const boxes = items
    .map((item, index) => {
      const points = normalizePoly(item.poly);
      if (!item.text || points.length < 3) return null;
      const xs = points.map(([x]) => x);
      const ys = points.map(([, y]) => y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      return {
        index,
        text: String(item.text).trim(),
        score: Number.isFinite(item.score) ? item.score : null,
        minX,
        maxX,
        minY,
        maxY,
        centerY: (minY + maxY) / 2,
        height: Math.max(1, maxY - minY),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.centerY - b.centerY || a.minX - b.minX);

  if (!boxes.length) return [];
  const heights = boxes.map((box) => box.height).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 16;
  const tolerance = Math.max(8, medianHeight * 0.7);
  const rows = [];

  boxes.forEach((box) => {
    let bestRow = null;
    let bestDistance = Infinity;
    rows.forEach((row) => {
      const distance = Math.abs(box.centerY - row.centerY);
      if (distance <= Math.max(tolerance, box.height * 0.65) && distance < bestDistance) {
        bestRow = row;
        bestDistance = distance;
      }
    });

    if (!bestRow) {
      rows.push({ items: [box], centerY: box.centerY });
    } else {
      bestRow.items.push(box);
      bestRow.centerY = bestRow.items.reduce((sum, item) => sum + item.centerY, 0) / bestRow.items.length;
    }
  });

  return rows
    .map((row) => {
      row.items.sort((a, b) => a.minX - b.minX);
      const scores = row.items.map((item) => item.score).filter(Number.isFinite);
      const minY = Math.min(...row.items.map((item) => item.minY));
      const maxY = Math.max(...row.items.map((item) => item.maxY));
      return {
        text: row.items.map((item) => item.text).join(' ').replace(/\s+/g, ' ').trim(),
        score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
        x: Math.min(...row.items.map((item) => item.minX)),
        y: row.centerY,
        height: maxY - minY,
        sourceIndexes: row.items.map((item) => item.index),
      };
    })
    .sort((a, b) => a.y - b.y);
}

function parseReceipt(rows) {
  const normalizedRows = rows.map((row, index) => ({
    ...row,
    index,
    normalized: normalizeText(row.text),
    amounts: extractAmounts(row.text),
  }));

  const date = findDateCandidate(normalizedRows.map((row) => row.text));
  const totalHit = findTaggedAmount(normalizedRows, /(総合計|合計|お支払|お買上|現計|TOTAL|税込合計)/i, /(小計|税)/i);
  const subtotalHit = findTaggedAmount(normalizedRows, /(小計|SUBTOTAL)/i);
  const taxHit = findTaggedAmount(normalizedRows, /(消費税|内税|外税|税額|TAX)/i);
  const totalIndex = totalHit?.index ?? normalizedRows.length;
  const merchant = findMerchant(normalizedRows);
  const items = [];

  normalizedRows.forEach((row) => {
    if (row.index >= totalIndex) return;
    if (!row.amounts.length) return;
    if (isMetadataRow(row.normalized)) return;

    const amount = row.amounts.at(-1);
    if (!Number.isFinite(amount) || amount <= 0) return;

    let name = stripTrailingAmount(row.text);
    name = name.replace(/^[*＊・\-–—\s]+/, '').trim();
    if (!name || name.length < 2) return;
    if (/^(小計|合計|消費税|内税|外税|お預り|お釣り|釣銭|現金|クレジット|電子マネー)/i.test(normalizeText(name))) return;

    items.push({
      name,
      amount: Math.round(amount),
      confidence: Number.isFinite(row.score) ? Number(row.score.toFixed(3)) : null,
      sourceText: row.text,
    });
  });

  return {
    merchant,
    date,
    total: totalHit?.amount ?? null,
    subtotal: subtotalHit?.amount ?? null,
    tax: taxHit?.amount ?? null,
    items,
    parser: {
      rows: normalizedRows.length,
      totalRow: totalHit?.text ?? null,
      subtotalRow: subtotalHit?.text ?? null,
      taxRow: taxHit?.text ?? null,
    },
  };
}

function findTaggedAmount(rows, includePattern, excludePattern = null) {
  const candidates = rows
    .filter((row) => includePattern.test(row.normalized))
    .filter((row) => !excludePattern || !excludePattern.test(row.normalized))
    .filter((row) => row.amounts.length)
    .map((row) => ({ index: row.index, text: row.text, amount: Math.round(row.amounts.at(-1)) }));
  return candidates.at(-1) ?? null;
}

function findMerchant(rows) {
  const top = rows.slice(0, Math.min(8, rows.length));
  const scored = top
    .filter((row) => !isMetadataRow(row.normalized))
    .filter((row) => !row.amounts.length || /店|ストア|STORE|SHOP|マート|mart/i.test(row.normalized))
    .map((row) => {
      const letters = (row.text.match(/[A-Za-zぁ-んァ-ヶ一-龠]/g) ?? []).length;
      const digits = (row.text.match(/[0-9０-９]/g) ?? []).length;
      const bonus = /(店|ストア|STORE|SHOP|マート|スーパー|コンビニ|market|mart|drug|薬局|食堂|restaurant|cafe|coffee)/i.test(row.text) ? 10 : 0;
      return { row, score: letters * 2 - digits + bonus - row.index * 0.5 };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.row.text ?? null;
}

function isMetadataRow(text) {
  return /(TEL|電話|〒|住所|レシート|領収書|領収証|日時|年月日|担当|レジ|NO\.?|店No|取引|伝票|カード|会員|ポイント|お預り|お釣り|釣銭|現金|クレジット|電子マネー|QR|税率|対象額|小計|合計|消費税|内税|外税|TAX)/i.test(text)
    || Boolean(findDateCandidate([text]))
    || /^\s*\d{1,2}:\d{2}/.test(text);
}

function extractAmounts(text) {
  const normalized = normalizeDigits(text).replace(/[¥￥]/g, '');
  const matches = [...normalized.matchAll(/(?:^|\s)([0-9]{1,3}(?:[,，][0-9]{3})+|[0-9]{1,7})(?:\.\d{1,2})?(?=\s*円?\s*$|\s)/g)];
  return matches
    .map((match) => Number(match[1].replace(/[,，]/g, '')))
    .filter((value) => Number.isFinite(value));
}

function stripTrailingAmount(text) {
  return normalizeDigits(text)
    .replace(/\s*[¥￥]?\s*[0-9]{1,3}(?:[,，][0-9]{3})*(?:\.\d{1,2})?\s*円?\s*$/, '')
    .trim();
}

function findDateCandidate(lines) {
  const normalized = lines.map(normalizeDigits).join(' ');
  const patterns = [
    /(20\d{2})\s*[\/\.\-年]\s*(\d{1,2})\s*[\/\.\-月]\s*(\d{1,2})\s*日?/,
    /(\d{2})\s*[\/\.\-]\s*(\d{1,2})\s*[\/\.\-]\s*(\d{1,2})/,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    let year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 100) year += 2000;
    if (!validDateParts(year, month, day)) continue;
    return `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
  }
  return null;
}

function normalizePoly(poly) {
  if (!Array.isArray(poly)) return [];
  return poly
    .map((point) => {
      if (Array.isArray(point) && point.length >= 2) return [Number(point[0]), Number(point[1])];
      if (point && typeof point === 'object' && 'x' in point && 'y' in point) return [Number(point.x), Number(point.y)];
      return null;
    })
    .filter((point) => point && point.every(Number.isFinite));
}

function normalizeText(text) {
  return normalizeDigits(String(text)).replace(/\s+/g, ' ').trim();
}

function normalizeDigits(text) {
  return String(text)
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/：/g, ':')
    .replace(/／/g, '/')
    .replace(/－/g, '-')
    .replace(/，/g, ',')
    .replace(/．/g, '.');
}

function scaledSize(width, height, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function validDateParts(year, month, day) {
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return null;
  return `¥${Math.round(value).toLocaleString('ja-JP')}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function scoreClass(score) {
  if (!Number.isFinite(score)) return '';
  if (score >= 0.9) return 'score-high';
  if (score >= 0.7) return 'score-mid';
  return 'score-low';
}

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image decode failed'));
    };
    image.src = url;
  });
}

function imageToCanvas(image, maxSide) {
  const { width, height } = scaledSize(image.naturalWidth, image.naturalHeight, maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d', { alpha: false }).drawImage(image, 0, 0, width, height);
  return { canvas, width, height };
}

function cameraErrorMessage(error) {
  if (error?.name === 'NotAllowedError') return 'カメラへのアクセスが拒否されています。ブラウザのサイト設定からカメラを許可してください。';
  if (error?.name === 'NotFoundError') return '利用できるカメラが見つかりませんでした。';
  if (error?.name === 'NotReadableError') return '別のアプリがカメラを使用している可能性があります。';
  return friendlyError(error);
}

function friendlyError(error) {
  return error?.message ? `${error.message}` : '不明なエラーが発生しました。';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

startCameraButton.addEventListener('click', startCamera);
captureButton.addEventListener('click', captureFromCamera);
liveToggleButton.addEventListener('click', toggleLiveOcr);
fileInput.addEventListener('change', () => loadFile(fileInput.files?.[0]));
retryButton.addEventListener('click', () => {
  resultSection.hidden = true;
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
window.addEventListener('pagehide', stopCamera);

prepareOcr().catch(() => {});
