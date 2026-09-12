// Small UI / bookkeeping safety enhancements kept separate from the OCR pipeline.

const COPY_TARGETS = [
  ['structuredJson', 'Structured JSON'],
  ['debugJson', 'Debug JSON'],
  ['rawJson', 'Raw OCR JSON'],
];

const style = document.createElement('style');
style.textContent = `
  .json-copy-bar { display:flex; justify-content:flex-end; margin:8px 0 6px; }
  .json-copy-button { appearance:none; border:1px solid rgba(30,41,59,.18); background:rgba(255,255,255,.75); color:inherit; border-radius:9px; padding:7px 11px; font:inherit; font-size:12px; font-weight:700; cursor:pointer; }
  .json-copy-button:active { transform:translateY(1px); }
  .merchant-post-note { margin-top:6px; font-size:12px; opacity:.72; }
`;
document.head.append(style);

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('copy command failed');
}

function installCopyButton(targetId, label) {
  const target = document.getElementById(targetId);
  if (!target || target.parentElement?.querySelector(`[data-copy-target="${targetId}"]`)) return;
  const bar = document.createElement('div');
  bar.className = 'json-copy-bar';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'json-copy-button';
  button.dataset.copyTarget = targetId;
  button.textContent = 'JSONをコピー';
  button.setAttribute('aria-label', `${label} をコピー`);
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const previous = button.textContent;
    try {
      await copyText(target.textContent || '');
      button.textContent = 'コピー済み ✓';
    } catch (error) {
      console.warn('[Receipt OCR extras] copy failed', error);
      button.textContent = 'コピー失敗';
    }
    window.setTimeout(() => { button.textContent = previous; }, 1400);
  });
  bar.append(button);
  target.before(bar);
}

for (const [targetId, label] of COPY_TARGETS) installCopyButton(targetId, label);

function safeJson(id) {
  const text = document.getElementById(id)?.textContent?.trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function isBadMerchant(text) {
  if (!text || typeof text !== 'string') return true;
  return /https?:\/\/|www\.|\.(?:com|jp|net|org)(?:\/|$)|(?:TEL|FAX)\s*\d|@/i.test(text);
}

function merchantCandidateFromRaw(raw) {
  const items = Array.isArray(raw?.items) ? raw.items.slice(0, 14) : [];
  const metadata = /(TEL|FAX|電話|〒|https?:|www\.|領収|登録番号|日時|レジ|担当|取引|伝票|カード|会員|ポイント|小計|合計|税|VISA|MASTERCARD)/i;
  const storeWord = /(店|ストア|スーパー|マート|バリュ|イオン|AEON|EON|LAWSON|ローソン|セブン|ファミリーマート|ドラッグ|薬局|ドン.?キ|SHOP|STORE|MARKET|MART)/i;
  const candidates = [];

  items.forEach((item, index) => {
    const text = String(item?.text || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 2 || text.length > 48 || metadata.test(text) || isBadMerchant(text)) return;
    if (/^[\d\s¥￥,.:/()\-]+$/.test(text)) return;
    const japanese = (text.match(/[ぁ-んァ-ヶ一-龠々〆ヵヶ]/g) || []).length;
    const letters = (text.match(/[A-Za-z]/g) || []).length;
    const digits = (text.match(/[0-9０-９]/g) || []).length;
    const confidence = Number.isFinite(item?.score) ? item.score : 0;
    const keyword = storeWord.test(text);
    const rank = japanese * 2.4 + letters * 0.35 - digits * 0.8 + (keyword ? 18 : 0) + confidence * 9 - index * 0.55;
    candidates.push({ text, confidence, japanese, keyword, rank, index });
  });

  candidates.sort((a, b) => b.rank - a.rank);
  return candidates[0] || null;
}

function setMerchantEvaluation(candidate, strong) {
  const rows = [...document.querySelectorAll('#evaluationList .evaluation-row')];
  const merchantRow = rows.find((row) => row.querySelector('strong')?.textContent?.includes('店名'));
  if (!merchantRow) return;
  const detail = merchantRow.querySelector('span');
  const criterion = merchantRow.querySelector('.criterion');
  const score = merchantRow.querySelector('em');
  if (detail) detail.textContent = candidate?.text || '店名を確定できません';
  if (criterion) {
    criterion.textContent = strong ? 'PASS' : 'REVIEW';
    criterion.className = `criterion ${strong ? 'pass' : 'review'}`;
  }
  if (score) score.textContent = strong ? '10/10' : '4/10';

  if (!strong) {
    const verdict = document.getElementById('evaluationVerdict');
    const total = document.getElementById('evaluationScore');
    if (verdict) {
      verdict.textContent = '要確認';
      verdict.className = 'evaluation-verdict review';
    }
    if (total) {
      const current = Number.parseInt(total.textContent || '', 10);
      if (Number.isFinite(current)) total.textContent = `${Math.max(0, current - 6)}/100`;
    }
  }
}

let merchantGuardBusy = false;
function validateMerchantAfterRender() {
  if (merchantGuardBusy) return;
  const structuredEl = document.getElementById('structuredJson');
  const structured = safeJson('structuredJson');
  if (!structured || !isBadMerchant(structured.merchant)) return;

  const raw = safeJson('rawJson');
  const candidate = merchantCandidateFromRaw(raw);
  const strong = Boolean(candidate && candidate.confidence >= 0.84 && (candidate.keyword || candidate.japanese >= 5));
  const usable = Boolean(candidate && candidate.confidence >= 0.72 && (candidate.keyword || candidate.japanese >= 4));

  merchantGuardBusy = true;
  try {
    structured.merchant = usable ? candidate.text : null;
    structured.parser = {
      ...(structured.parser || {}),
      merchantPostProcess: {
        corrected: true,
        candidate: usable ? candidate.text : null,
        confidence: usable ? Math.round(candidate.confidence * 1000) / 1000 : null,
        status: strong ? 'PASS' : 'REVIEW',
        reason: 'URL / metadata-like strings are not accepted as merchant names',
      },
    };
    if (structuredEl) structuredEl.textContent = JSON.stringify(structured, null, 2);
    const merchantEl = document.getElementById('merchantCandidate');
    if (merchantEl) merchantEl.textContent = usable ? candidate.text : '—';
    setMerchantEvaluation(usable ? candidate : null, strong);
    console.debug('[Receipt OCR extras] merchant guard', { originalRejected: true, candidate, strong });
  } finally {
    merchantGuardBusy = false;
  }
}

const structuredEl = document.getElementById('structuredJson');
if (structuredEl) {
  new MutationObserver(() => queueMicrotask(validateMerchantAfterRender)).observe(structuredEl, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}

let debugNormalizeBusy = false;
function normalizeDebugRuntime() {
  if (debugNormalizeBusy) return;
  const debugEl = document.getElementById('debugJson');
  const debug = safeJson('debugJson');
  const runtime = debug?.paddle?.runtime;
  const fastPath = runtime?.fastPath;
  if (!debugEl || !debug || !runtime || !fastPath) return;

  debugNormalizeBusy = true;
  try {
    debug.config = {
      ...(debug.config || {}),
      recognitionBatchSize: 8,
      requestedBackend: runtime.requestedBackend ?? null,
      backend: runtime.recProvider ?? runtime.detProvider ?? runtime.requestedBackend ?? null,
      detProvider: runtime.detProvider ?? null,
      recProvider: runtime.recProvider ?? null,
      model: fastPath.model ?? null,
      detectionModel: fastPath.detectionModel ?? null,
      recognitionModel: fastPath.recognitionModel ?? null,
      ocrInputSide: fastPath.inputSide ?? null,
    };
    debugEl.textContent = JSON.stringify(debug, null, 2);
  } finally {
    debugNormalizeBusy = false;
  }
}

const debugEl = document.getElementById('debugJson');
if (debugEl) {
  new MutationObserver(() => queueMicrotask(normalizeDebugRuntime)).observe(debugEl, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}

// Also run once in case this module loads after a completed result render.
validateMerchantAfterRender();
normalizeDebugRuntime();
