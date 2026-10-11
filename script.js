'use strict';

const API_BASE = 'https://aviator-ai-predictor-v1.onrender.com';
const $ = (id) => document.getElementById(id);
let lastAnalysis = null;
let busy = false;

function setText(id, value, fallback = '—') {
  const el = $(id); if (el) el.textContent = value === null || value === undefined || value === '' ? fallback : String(value);
}
function fmt(value, suffix = '') { return value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`; }
function fmtPercent(value) { return value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : `${Number(value).toFixed(2)}%`; }
function fmtMultiplier(value) { return value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : `${Number(value).toFixed(2)}x`; }
function setApiState(online, text) { const dot = $('apiDot'); if (dot) dot.className = `dot ${online ? 'online' : 'offline'}`; setText('apiStatus', text); }
function setBusy(value, label = '') {
  busy = value;
  ['analyzeBtn', 'backtestBtn', 'historyBtn'].forEach((id) => { if ($(id)) $(id).disabled = value; });
  if (value && label) setText('updated', label);
}
async function apiGet(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(`${API_BASE}${path}`, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal, cache: 'no-store' });
    let data;
    try { data = await response.json(); } catch (_) { throw new Error(`API returned non-JSON response (HTTP ${response.status}).`); }
    if (!response.ok || data.ok === false) throw new Error(data.error || `API request failed (HTTP ${response.status}).`);
    return data;
  } finally { clearTimeout(timeout); }
}
function renderAnalysis(data) {
  lastAnalysis = data;
  setApiState(true, 'API ONLINE');
  setText('version', data.version || 'V1.1.1');
  setText('action', data.signal?.action || 'NO SIGNAL');
  setText('score', fmt(data.signal?.score, ' / 100'));
  setText('risk', data.signal?.action === 'SIGNAL' ? 'Evidence gates passed' : data.signal?.action === 'WATCH' ? 'Caution' : 'Insufficient evidence');
  setText('riskDetail', data.signal?.confidenceLabel || 'Score is not a win probability');
  setText('actionDetail', data.signal?.target ? `Research target: next round ${data.signal.target}` : 'No betting guarantee');
  const actionCard = $('actionCard');
  if (actionCard) actionCard.className = `action-card ${data.signal?.action === 'SIGNAL' ? 'signal' : data.signal?.action === 'WATCH' ? 'watch' : 'no-signal'}`;
  const reasons = $('reasons');
  if (reasons) { reasons.replaceChildren(); (data.signal?.reasons || ['No model reasons available.']).forEach((reason) => { const li = document.createElement('li'); li.textContent = reason; reasons.appendChild(li); }); }

  const q = data.dataQuality || {};
  setText('source', data.source || 'Unknown CSV');
  setText('rounds', fmt(data.summary?.samples, ' rounds'));
  setText('invalid', q.invalidRows ?? 0);
  setText('duplicates', q.duplicateRoundIds ?? 0);
  setText('multiplierColumn', q.multiplierColumn || '—');
  setText('timeColumn', q.timeColumn || '—');
  setText('roundColumn', q.roundIdColumn || 'row index fallback');
  const warnings = $('qualityWarnings');
  if (warnings) { warnings.replaceChildren(); (q.warnings || []).forEach((warning) => { const p = document.createElement('p'); p.textContent = `⚠ ${warning}`; warnings.appendChild(p); }); }

  const d = data.distribution || {};
  setText('mean', fmtMultiplier(d.mean)); setText('median', fmtMultiplier(d.median)); setText('min', fmtMultiplier(d.min)); setText('max', fmtMultiplier(d.max));
  setText('stdev', fmtMultiplier(d.stdev)); setText('p75', fmtMultiplier(d.p75)); setText('atLeast2', fmtPercent(d.atLeast2)); setText('atLeast10', fmtPercent(d.atLeast10));
  [['short', data.windows?.short], ['medium', data.windows?.medium], ['long', data.windows?.long]].forEach(([prefix, w]) => {
    if (!w) return;
    setText(`${prefix}Samples`, w.samples); setText(`${prefix}Mean`, fmtMultiplier(w.mean)); setText(`${prefix}Median`, fmtMultiplier(w.median));
    setText(`${prefix}Low`, fmtPercent(w.below1_5)); setText(`${prefix}Target`, fmtPercent(w.atLeast2)); setText(`${prefix}5`, fmtPercent(w.atLeast5)); setText(`${prefix}10`, fmtPercent(w.atLeast10));
  });
  setText('afterLow', fmtPercent(data.transitions?.afterLow?.hitRate)); setText('afterLowSamples', `(${data.transitions?.afterLow?.samples ?? 0} cases)`);
  setText('afterVeryLow', fmtPercent(data.transitions?.afterVeryLow?.hitRate)); setText('afterVeryLowSamples', `(${data.transitions?.afterVeryLow?.samples ?? 0} cases)`);
  renderBacktest(data.backtest);
  renderGates(data.evidenceGates);
  renderRounds(data.recentRounds || [], data.summary?.samples || 0);
  setText('updated', `Updated ${new Date(data.generatedAt || Date.now()).toLocaleString()}`);
}
function renderBacktest(bt) {
  if (!bt) return;
  setText('btSamples', bt.samples ?? 0); setText('btHits', bt.hits ?? 0); setText('btMisses', bt.misses ?? 0);
  setText('btRate', fmtPercent(bt.hitRate)); setText('btBaseline', fmtPercent(bt.baselineHitRate)); setText('btCoverage', fmtPercent(bt.coverage)); setText('btFalse', fmtPercent(bt.falseSignalRate));
  const stable = $('btStable');
  if (stable) { stable.textContent = bt.stable ? 'Above baseline in test' : 'Not validated'; stable.className = `pill ${bt.stable ? 'pass' : 'fail'}`; }
  setText('btNote', `${bt.note || 'Historical backtest only'} ${bt.testedPositions !== undefined ? `Positions tested: ${bt.testedPositions}.` : ''}`);
}
function renderGates(gates) {
  const list = $('gates'); if (!list) return; list.replaceChildren();
  (gates || []).forEach((gate) => {
    const li = document.createElement('li');
    const state = document.createElement('span'); state.className = `gate-state ${gate.pass ? 'pass' : 'fail'}`; state.textContent = gate.pass ? 'PASS' : 'BLOCK';
    const body = document.createElement('span'); body.className = 'gate-detail'; body.textContent = `${gate.name}: ${gate.detail}`;
    li.append(state, body); list.appendChild(li);
  });
}
function renderRounds(rounds, total) {
  const table = $('roundTable'); if (!table) return; table.replaceChildren();
  if (!rounds.length) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 3; td.textContent = 'No rounds loaded.'; tr.appendChild(td); table.appendChild(tr); }
  rounds.forEach((round) => {
    const tr = document.createElement('tr');
    [round.roundId, round.timeUtc || '—', fmtMultiplier(round.multiplier)].forEach((value) => { const td = document.createElement('td'); td.textContent = value ?? '—'; tr.appendChild(td); });
    table.appendChild(tr);
  });
  setText('historyCount', `${rounds.length} shown / ${Number(total).toLocaleString()} total`);
}
async function analyze() {
  if (busy) return;
  setBusy(true, 'Loading and analyzing dataset…');
  try { const data = await apiGet('/api/analyze'); renderAnalysis(data); }
  catch (error) { setApiState(false, 'API OFFLINE'); setText('action', 'API ERROR'); const card = $('actionCard'); if (card) card.className = 'action-card error'; setText('actionDetail', error.message); setText('updated', 'Could not load analysis. Check Render service and CSV path.'); }
  finally { setBusy(false); }
}
async function runBacktest() {
  if (busy) return;
  setBusy(true, 'Running chronological walk-forward backtest…');
  try {
    const bt = await apiGet('/api/backtest');
    renderBacktest(bt.backtest);
    if (bt.evidenceGates) renderGates(bt.evidenceGates);
    setText('updated', `Backtest refreshed ${new Date(bt.generatedAt || Date.now()).toLocaleString()}`);
  } catch (error) { setText('btNote', `Backtest failed: ${error.message}`); }
  finally { setBusy(false); }
}
async function loadHistory() {
  if (busy) return;
  setBusy(true, 'Loading recent rounds…');
  try { const data = await apiGet('/api/history?limit=100&offset=0'); renderRounds(data.rounds || [], data.total || 0); setText('updated', `History loaded from ${data.source || 'CSV'}`); }
  catch (error) { setText('historyCount', 'Load failed'); setText('updated', `History failed: ${error.message}`); }
  finally { setBusy(false); }
}
function init() {
  $('analyzeBtn')?.addEventListener('click', analyze);
  $('backtestBtn')?.addEventListener('click', runBacktest);
  $('historyBtn')?.addEventListener('click', loadHistory);
  analyze();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
