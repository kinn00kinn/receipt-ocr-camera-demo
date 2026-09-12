import { PaddleOCR } from '@paddleocr/paddleocr-js';
import { JapaneseReceiptOcrEngine } from './japanese-receipt-ocr.js';

const MODE_KEY = 'receipt-ocr-mode-v5';
const originalCreate = PaddleOCR.create.bind(PaddleOCR);

const MODES = Object.freeze({
  japaneseFast: Object.freeze({
    id: 'japaneseFast',
    label: '日本語高速',
    short: '推奨',
    kind: 'japanese',
    detail: false,
    timeoutMs: 18000,
    description: 'PP-OCRv5 recognition-only。検出CNNを使わず、投影法で文字行を切り出し、店名・日付・合計を優先して読みます。',
  }),
  japaneseDetail: Object.freeze({
    id: 'japaneseDetail',
    label: '日本語詳細',
    short: '明細まで',
    kind: 'japanese',
    detail: true,
    timeoutMs: 35000,
    description: '日本語高速と同じrecognition-only構成で、検出した行を広く読みます。商品明細が必要な場合向け。',
  }),
  generic: Object.freeze({
    id: 'generic',
    label: '汎用比較',
    short: 'v6 tiny',
    kind: 'generic',
    timeoutMs: 18000,
    inputSide: 576,
    description: '従来系のPP-OCRv6 tiny det+rec。日本語精度は低めですが比較用に残しています。',
  }),
});

let activeModeId = sessionStorage.getItem(MODE_KEY);
if (!MODES[activeModeId]) activeModeId = 'japaneseFast';
let activeMode = MODES[activeModeId];
let underlying = null;
let underlyingModeId = null;
let underlyingPromise = null;
let predictInFlight = 0;
let modePanel = null;
let lastRuntime = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function status(title, text, busy = false) {
  const titleEl = document.getElementById('statusTitle');
  const textEl = document.getElementById('statusText');
  const spinner = document.getElementById('spinner');
  if (titleEl) titleEl.textContent = title;
  if (textEl) textEl.textContent = text;
  if (spinner) spinner.hidden = !busy;
}

function runtimeBadge(result = null) {
  const badge = document.getElementById('runtimeBadge');
  if (!badge) return;
  const runtime = result?.runtime || lastRuntime;
  if (activeMode.kind === 'japanese') {
    const provider = runtime?.recProvider ? String(runtime.recProvider).toUpperCase() : 'lazy';
    badge.textContent = `${activeMode.label} · PP-OCRv5 rec-only · ${provider}`;
  } else {
    const provider = runtime?.recProvider || runtime?.detProvider || 'lazy';
    badge.textContent = `${activeMode.label} · ${String(provider).toUpperCase()} · ${activeMode.inputSide}px`;
  }
}

async function disposeUnderlying() {
  const engine = underlying;
  underlying = null;
  underlyingPromise = null;
  underlyingModeId = null;
  lastRuntime = null;
  runtimeBadge();
  if (!engine?.dispose) return;
  try {
    await Promise.race([
      Promise.resolve(engine.dispose()),
      sleep(1800),
    ]);
  } catch (error) {
    console.warn('[Receipt OCR router] dispose failed', error);
  }
}

async function createUnderlying(mode) {
  if (mode.kind === 'japanese') {
    return new JapaneseReceiptOcrEngine({
      detail: mode.detail,
      onStatus: (title, text) => status(title, text, true),
    });
  }

  const engine = await originalCreate({
    textDetectionModelName: 'PP-OCRv6_tiny_det',
    textRecognitionModelName: 'PP-OCRv6_tiny_rec',
    textDetectionBatchSize: 1,
    textRecognitionBatchSize: 8,
    worker: true,
    ortOptions: {
      backend: 'auto',
      simd: true,
    },
  });
  const originalPredict = engine.predict.bind(engine);
  engine.predict = async (input, options = {}) => {
    let source = input;
    let temporary = null;
    if (input instanceof HTMLCanvasElement && Math.max(input.width, input.height) > mode.inputSide) {
      const scale = mode.inputSide / Math.max(input.width, input.height);
      temporary = document.createElement('canvas');
      temporary.width = Math.max(1, Math.round(input.width * scale));
      temporary.height = Math.max(1, Math.round(input.height * scale));
      temporary.getContext('2d', { alpha: false }).drawImage(input, 0, 0, temporary.width, temporary.height);
      source = temporary;
    }
    try {
      return await originalPredict(source, {
        ...options,
        textDetLimitSideLen: mode.inputSide,
        textDetBoxThresh: Math.max(Number(options.textDetBoxThresh) || 0, 0.62),
        textRecScoreThresh: Math.max(Number(options.textRecScoreThresh) || 0, 0.42),
      });
    } finally {
      if (temporary) { temporary.width = 1; temporary.height = 1; }
    }
  };
  return engine;
}

async function ensureUnderlying() {
  if (underlying && underlyingModeId === activeMode.id) return underlying;
  if (underlyingPromise && underlyingModeId === activeMode.id) return underlyingPromise;
  if (underlying || underlyingPromise) await disposeUnderlying();
  const modeAtStart = activeMode;
  underlyingModeId = modeAtStart.id;
  underlyingPromise = createUnderlying(modeAtStart).then((engine) => {
    if (activeMode.id !== modeAtStart.id) {
      void engine.dispose?.();
      throw new Error('OCR mode changed during initialization');
    }
    underlying = engine;
    renderModeUi();
    return engine;
  }).catch((error) => {
    underlying = null;
    underlyingPromise = null;
    underlyingModeId = null;
    renderModeUi();
    throw error;
  });
  return underlyingPromise;
}

async function predictWithTimeout(engine, input, options) {
  const modeAtStart = activeMode;
  let timer;
  try {
    return await Promise.race([
      engine.predict(input, options).finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`OCR timeout after ${modeAtStart.timeoutMs} ms`)), modeAtStart.timeoutMs);
      }),
    ]);
  } catch (error) {
    if (/OCR timeout/.test(String(error?.message || ''))) {
      status('OCRを停止しました', `${modeAtStart.label}が時間内に終わらなかったためエンジンを破棄しました。`, false);
      await disposeUnderlying();
    }
    throw error;
  }
}

async function routedPredict(input, options = {}) {
  predictInFlight += 1;
  renderModeUi();
  const started = performance.now();
  try {
    const engine = await ensureUnderlying();
    const results = await predictWithTimeout(engine, input, options);
    const first = results?.[0];
    if (first) {
      first.runtime = {
        ...(first.runtime || {}),
        appMode: activeMode.id,
        appModeLabel: activeMode.label,
        routerTotalMs: performance.now() - started,
      };
      lastRuntime = first.runtime;
      runtimeBadge(first);
    }
    return results;
  } finally {
    predictInFlight = Math.max(0, predictInFlight - 1);
    renderModeUi();
  }
}

PaddleOCR.create = async function createLazyReceiptProxy() {
  return {
    predict: routedPredict,
    dispose: disposeUnderlying,
    getInitializationSummary: () => null,
    getModelConfig: () => null,
  };
};

async function switchMode(id) {
  const next = MODES[id];
  if (!next || next.id === activeMode.id || predictInFlight) return;
  const previous = activeMode;
  activeMode = next;
  activeModeId = next.id;
  sessionStorage.setItem(MODE_KEY, next.id);
  status('OCRモードを変更中', `${previous.label} → ${next.label}`, true);
  renderModeUi();
  await disposeUnderlying();
  status('OCRモードを変更しました', next.description, false);
  renderModeUi();
}

function createModeUi() {
  if (document.getElementById('ocrModePanel')) return;
  const anchor = document.querySelector('.intro-card');
  if (!anchor) return;
  const style = document.createElement('style');
  style.textContent = `
    .ocr-mode-card{padding:14px 16px}.ocr-mode-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:10px}
    .ocr-mode-head strong{font-size:14px}.ocr-mode-head span{font-size:11px;opacity:.65}.ocr-mode-buttons{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}
    .ocr-mode-button{appearance:none;border:1px solid rgba(30,41,59,.16);border-radius:10px;background:rgba(255,255,255,.72);color:inherit;padding:9px 6px;cursor:pointer;font:inherit;min-height:50px}
    .ocr-mode-button strong,.ocr-mode-button small{display:block}.ocr-mode-button strong{font-size:13px}.ocr-mode-button small{font-size:10px;opacity:.62;margin-top:2px}
    .ocr-mode-button.is-active{border-color:currentColor;box-shadow:inset 0 0 0 1px currentColor}.ocr-mode-button:disabled{opacity:.45;cursor:not-allowed}
    .ocr-mode-description{font-size:12px;line-height:1.55;opacity:.78;margin:9px 0 0}.ocr-mode-note{font-size:11px;line-height:1.45;opacity:.62;margin:5px 0 0}
    @media(max-width:520px){.ocr-mode-buttons{grid-template-columns:1fr}.ocr-mode-button{text-align:left;min-height:42px;padding:9px 11px}}
  `;
  document.head.append(style);
  const panel = document.createElement('section');
  panel.id = 'ocrModePanel';
  panel.className = 'card ocr-mode-card';
  panel.innerHTML = `<div class="ocr-mode-head"><div><strong>OCRモード</strong><br><span>スマホでは日本語高速を推奨</span></div><span id="ocrEngineState">モデル未読込</span></div><div class="ocr-mode-buttons"></div><p id="ocrModeDescription" class="ocr-mode-description"></p><p class="ocr-mode-note">日本語高速/詳細は検出ニューラルネットを使いません。モデルは最初のOCR時だけ読み込みます。</p>`;
  const buttons = panel.querySelector('.ocr-mode-buttons');
  for (const mode of Object.values(MODES)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ocr-mode-button';
    button.dataset.mode = mode.id;
    button.innerHTML = `<strong>${mode.label}</strong><small>${mode.short}</small>`;
    button.addEventListener('click', () => switchMode(mode.id));
    buttons.append(button);
  }
  anchor.after(panel);
  modePanel = panel;
  renderModeUi();
}

function renderModeUi() {
  runtimeBadge();
  if (!modePanel) return;
  modePanel.querySelectorAll('.ocr-mode-button').forEach((button) => {
    const active = button.dataset.mode === activeMode.id;
    button.classList.toggle('is-active', active);
    button.disabled = predictInFlight > 0;
    button.setAttribute('aria-pressed', String(active));
  });
  const description = document.getElementById('ocrModeDescription');
  if (description) description.textContent = activeMode.description;
  const state = document.getElementById('ocrEngineState');
  if (state) state.textContent = predictInFlight ? 'OCR実行中' : underlying || underlyingPromise ? 'モデル読込済み' : 'モデル未読込';
}

function shrinkBurstPreviews() {
  const chooser = document.getElementById('burstChooser');
  if (!chooser) return;
  const shrink = () => chooser.querySelectorAll('canvas').forEach((canvas) => {
    if (Math.max(canvas.width, canvas.height) <= 220) return;
    const scale = 220 / Math.max(canvas.width, canvas.height);
    const temp = document.createElement('canvas');
    temp.width = Math.max(1, Math.round(canvas.width * scale));
    temp.height = Math.max(1, Math.round(canvas.height * scale));
    temp.getContext('2d', { alpha: false }).drawImage(canvas, 0, 0, temp.width, temp.height);
    canvas.width = temp.width; canvas.height = temp.height;
    canvas.getContext('2d', { alpha: false }).drawImage(temp, 0, 0);
    temp.width = 1; temp.height = 1;
  });
  new MutationObserver(shrink).observe(chooser, { childList: true, subtree: true });
}

function patchDebugJson() {
  const el = document.getElementById('debugJson');
  if (!el) return;
  let busy = false;
  new MutationObserver(() => {
    if (busy || !el.textContent?.trim().startsWith('{')) return;
    let data;
    try { data = JSON.parse(el.textContent); } catch { return; }
    if (!data?.paddle?.runtime) return;
    busy = true;
    data.config = {
      ...(data.config || {}),
      activeMode: activeMode.id,
      activeModeLabel: activeMode.label,
      japaneseReceiptSpecific: activeMode.kind === 'japanese',
      detectorSkipped: Boolean(data.paddle.runtime?.receiptFastPath?.detectorSkipped),
      actualDetProvider: data.paddle.runtime.detProvider ?? null,
      actualRecProvider: data.paddle.runtime.recProvider ?? null,
    };
    el.textContent = JSON.stringify(data, null, 2);
    queueMicrotask(() => { busy = false; });
  }).observe(el, { childList: true, subtree: true, characterData: true });
}

createModeUi();
await import('./app-v2.js');
await import('./ui-extras.js');
createModeUi();
shrinkBurstPreviews();
patchDebugJson();
renderModeUi();

const liveButton = document.getElementById('liveToggleButton');
liveButton?.addEventListener('click', (event) => {
  if (activeMode.kind === 'japanese') {
    event.preventDefault();
    event.stopImmediatePropagation();
    status('リアルタイムOCRは比較モード専用', '日本語高速では1枚のレシートを最小計算量で読むことを優先します。', false);
  }
}, { capture: true });

status('撮影できます', '日本語高速はモデル未読込のまま待機しています。撮影後に必要なrecognitionモデルだけ読み込みます。', false);
const footer = document.querySelector('footer p');
if (footer) footer.textContent = 'Receipt-specific Japanese OCR · detector-free line segmentation · PP-OCRv5 recognition';
window.addEventListener('pagehide', () => { void disposeUnderlying(); });
console.debug('[Receipt OCR router] ready', { mode: activeMode.id, webgpu: Boolean(navigator.gpu) });
