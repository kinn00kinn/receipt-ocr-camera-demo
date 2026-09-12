import './style.css';
import { PaddleOCR } from '@paddleocr/paddleocr-js';

const $ = (id) => document.getElementById(id);

const camera = $('camera');
const captureCanvas = $('captureCanvas');
const resultCanvas = $('resultCanvas');
const startCameraButton = $('startCameraButton');
const captureButton = $('captureButton');
const fileInput = $('fileInput');
const retryButton = $('retryButton');
const cameraPlaceholder = $('cameraPlaceholder');
const resultSection = $('resultSection');
const ocrItems = $('ocrItems');
const rawJson = $('rawJson');
const totalCandidate = $('totalCandidate');
const dateCandidate = $('dateCandidate');
const ocrTime = $('ocrTime');
const lineCount = $('lineCount');
const statusTitle = $('statusTitle');
const statusText = $('statusText');
const statusDot = $('statusDot');
const spinner = $('spinner');

let stream = null;
let ocr = null;
let ocrPromise = null;

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

  setStatus(
    'OCRモデルを読み込み中',
    '初回のみ PP-OCRv5 と実行環境を取得します。端末や回線によって少し時間がかかります。',
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
      ocr = instance;
      setStatus('OCR準備完了', '撮影すると端末内で文字認識します。', { success: true });
      return instance;
    })
    .catch((error) => {
      ocrPromise = null;
      setStatus('OCRの準備に失敗', friendlyError(error), { error: true });
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

    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });

    camera.srcObject = stream;
    await camera.play();
    cameraPlaceholder.hidden = true;
    captureButton.disabled = false;
    startCameraButton.textContent = 'カメラを再起動';
    setStatus('カメラ準備完了', 'レシートを枠に合わせて「撮影して OCR」を押してください。', { success: true });

    prepareOcr().catch(() => {});
  } catch (error) {
    setStatus('カメラを起動できません', cameraErrorMessage(error), { error: true });
  } finally {
    startCameraButton.disabled = false;
  }
}

function stopCamera() {
  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
  stream = null;
  camera.srcObject = null;
}

async function captureFromCamera() {
  if (!camera.videoWidth || !camera.videoHeight) return;

  const maxSide = 1800;
  const scale = Math.min(1, maxSide / Math.max(camera.videoWidth, camera.videoHeight));
  const width = Math.round(camera.videoWidth * scale);
  const height = Math.round(camera.videoHeight * scale);

  captureCanvas.width = width;
  captureCanvas.height = height;
  captureCanvas.getContext('2d', { alpha: false }).drawImage(camera, 0, 0, width, height);

  await runOcr(captureCanvas);
}

async function loadFile(file) {
  if (!file) return;

  try {
    const image = await fileToImage(file);
    const { canvas } = imageToCanvas(image, 1800);
    await runOcr(canvas);
  } catch (error) {
    setStatus('画像を読み込めませんでした', friendlyError(error), { error: true });
  } finally {
    fileInput.value = '';
  }
}

async function runOcr(source) {
  captureButton.disabled = true;
  startCameraButton.disabled = true;
  setStatus('OCR実行中', '文字領域を検出し、日本語を認識しています。', { busy: true });

  try {
    const engine = await prepareOcr();
    const startedAt = performance.now();
    const [result] = await engine.predict(source, {
      textRecScoreThresh: 0.35,
      textDetBoxThresh: 0.45,
    });
    const elapsed = performance.now() - startedAt;

    renderResult(source, result, elapsed);
    setStatus(
      'OCR完了',
      `${result.items?.length ?? 0} 行を認識しました。枠・文字・confidence を確認できます。`,
      { success: true },
    );
    resultSection.hidden = false;
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    console.error(error);
    setStatus('OCRに失敗しました', friendlyError(error), { error: true });
  } finally {
    captureButton.disabled = !stream;
    startCameraButton.disabled = false;
  }
}

function renderResult(source, result, elapsed) {
  drawOcrOverlay(source, result.items ?? []);
  renderItems(result.items ?? []);

  const textLines = (result.items ?? []).map((item) => item.text).filter(Boolean);
  totalCandidate.textContent = findTotalCandidate(textLines) ?? '—';
  dateCandidate.textContent = findDateCandidate(textLines) ?? '—';

  const metricMs = result.metrics?.totalMs;
  const shownMs = Number.isFinite(metricMs) ? metricMs : elapsed;
  ocrTime.textContent = shownMs >= 1000 ? `${(shownMs / 1000).toFixed(2)} s` : `${Math.round(shownMs)} ms`;
  lineCount.textContent = `${result.items?.length ?? 0} lines`;

  rawJson.textContent = JSON.stringify(
    {
      image: result.image,
      metrics: result.metrics,
      runtime: result.runtime,
      items: result.items,
    },
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

  const lineWidth = Math.max(2, width / 500);
  ctx.lineWidth = lineWidth;
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

function findTotalCandidate(lines) {
  const keywords = /(合計|総合計|お支払|お買上|税込|現計|TOTAL|合\s*計)/i;
  const money = /(?:¥|￥)?\s*([0-9０-９][0-9０-９,，\.．]*)\s*(?:円)?/g;

  const candidates = lines
    .map((line, index) => ({ line: normalizeDigits(line), index }))
    .filter(({ line }) => keywords.test(line))
    .map(({ line, index }) => {
      const matches = [...line.matchAll(money)];
      const values = matches
        .map((match) => Number(match[1].replace(/[，,]/g, '').replace('．', '.')))
        .filter(Number.isFinite);
      return { value: values.at(-1), index, line };
    })
    .filter(({ value }) => Number.isFinite(value));

  const best = candidates.at(-1);
  if (!best) return null;
  return `¥${Math.round(best.value).toLocaleString('ja-JP')}`;
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

function normalizeDigits(text) {
  return String(text)
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/：/g, ':')
    .replace(/／/g, '/')
    .replace(/－/g, '-');
}

function validDateParts(year, month, day) {
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
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
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.round(image.naturalWidth * scale);
  const height = Math.round(image.naturalHeight * scale);
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

startCameraButton.addEventListener('click', startCamera);
captureButton.addEventListener('click', captureFromCamera);
fileInput.addEventListener('change', () => loadFile(fileInput.files?.[0]));
retryButton.addEventListener('click', () => {
  resultSection.hidden = true;
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

window.addEventListener('pagehide', stopCamera);
