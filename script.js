'use strict';

const API_BASE = 'https://aviator-ai-predictor-v1.onrender.com';
const $ = (id) => document.getElementById(id);
let busy = false;

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value == null || value === '' ? '—' : String(value);
}
function fmt(value, suffix = '') {
  return value == null || !Number.isFinite(Number(value)) ? '—' : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
}
function pct(value) { return value == null ? '—' : fmt(value, '%'); }
function fmtTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}
function setStatus(ok, label) {
  setText('apiStatus', label || (ok ? 'API ONLINE' : 'API OFFLINE'));
  $('statusDot').classList.toggle('online', Boolean(ok));
  $('statusDot').classList.toggle('offline', !ok);
}
function showError(message) {
  const el = $('errorBox');
  el.textContent = message;
  el.classList.remove('hidden');
}
function clearError() { $('errorBox').classList.add('hidden'); $('errorBox').textContent = ''; }
function addCell(row, value) {
  const td = document.createElement('td');
  td.textContent = value == null || value === '' ? '—' : String(value);
  row.appendChild(td);
}
function renderWindows(windows = {}) {
  const body = $('windowsBody');
  body.replaceChildren();
  const rows = [ ['Short', windows.short], ['Medium', windows.medium], ['Long', windows.long] ];
  rows.forEach(([name, item]) => {
    const tr = document.createElement('tr');
    [name, item?.samples, item?.mean == null ? '—' : `${fmt(item.mean)}x`, pct(item?.atLeast2), pct(item?.atLeast5)].forEach(v => addCell(tr, v));
    body.appendChild(tr);
  });
}
function renderGates(gates = []) {
  const box = $('evidenceGates');
  box.replaceChildren();
  if (!gates.length) { box.textContent = 'No evidence-gate results returned.'; return; }
  gates.forEach(gate => {
    const row = document.createElement('div');
    row.className = `gate ${gate.pass ? 'pass' : 'fail'}`;
    const status = document.createElement('strong');
    status.textContent = gate.pass ? 'PASS' : 'BLOCKED';
    const content = document.createElement('div');
    const name = document.createElement('b'); name.textContent = gate.name || 'Gate';
    const detail = document.createElement('p'); detail.textContent = gate.detail || '';
    content.append(name, detail); row.append(status, content); box.appendChild(row);
  });
}
function renderRounds(rounds = []) {
  const body = $('roundsBody'); body.replaceChildren();
  if (!rounds.length) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 3; td.textContent = 'No rounds returned.'; tr.appendChild(td); body.appendChild(tr); return; }
  rounds.forEach(round => {
    const tr = document.createElement('tr');
    addCell(tr, round.roundId);
    addCell(tr, round.timeUtc ? fmtTime(round.timeUtc) : '—');
    addCell(tr, `${fmt(round.multiplier)}x`);
    body.appendChild(tr);
  });
}
function renderAnalysis(data) {
  if (!data || data.ok !== true) throw new Error(data?.error || 'API did not return a valid analysis.');
  clearError(); setStatus(true);
  setText('sourceName', data.sourcePath || data.source);
  setText('roundCount', data.summary?.samples);
  setText('generatedAt', fmtTime(data.generatedAt));
  setText('signalAction', data.signal?.action || 'NO SIGNAL');
  $('signalAction').className = `action-label ${(data.signal?.action || 'NO SIGNAL').toLowerCase().replace(/\s+/g, '-')}`;
  setText('signalScore', data.signal?.score);
  setText('signalTarget', `Research target: next round ${data.signal?.target || '≥ 2.00x'}`);
  setText('confidenceLabel', data.signal?.confidenceLabel || 'Evidence score, not win probability.');
  const reasons = $('signalReasons'); reasons.replaceChildren();
  (data.signal?.reasons || []).forEach(reason => { const li = document.createElement('li'); li.textContent = reason; reasons.appendChild(li); });
  if (!reasons.children.length) { const li = document.createElement('li'); li.textContent = 'No additional reasons supplied.'; reasons.appendChild(li); }

  const d = data.distribution || {};
  setText('distributionSamples', `${fmt(d.samples)} rounds`);
  setText('meanValue', d.mean == null ? '—' : `${fmt(d.mean)}x`);
  setText('medianValue', d.median == null ? '—' : `${fmt(d.median)}x`);
  setText('minValue', d.min == null ? '—' : `${fmt(d.min)}x`);
  setText('maxValue', d.max == null ? '—' : `${fmt(d.max)}x`);
  setText('atLeast2', pct(d.atLeast2)); setText('atLeast10', pct(d.atLeast10));
  renderWindows(data.windows || {});

  const bt = data.backtest || {};
  setText('backtestTarget', bt.target || 'Target ≥ 2x');
  setText('testedPositions', bt.testedPositions);
  setText('btSamples', bt.samples);
  setText('btHitsMisses', `${bt.hits ?? '—'} / ${bt.misses ?? '—'}`);
  setText('btHitRate', pct(bt.hitRate)); setText('btBaseline', pct(bt.baselineHitRate)); setText('btCoverage', pct(bt.coverage));
  setText('backtestNote', bt.note || 'Historical walk-forward test; results do not guarantee future outcomes.');

  const q = data.dataQuality || {};
  setText('qualityStatus', q.validRounds >= 24 && !q.invalidRows && !q.duplicateRoundIds ? 'CHECKED' : 'REVIEW');
  setText('sourceDataRows', q.sourceDataRows); setText('invalidRows', q.invalidRows); setText('duplicateIds', q.duplicateRoundIds); setText('missingTimes', q.missingTimestamps);
  setText('columnInfo', `Multiplier: ${q.multiplierColumn || 'unknown'} · Round ID: ${q.roundIdColumn || 'row order'} · Time: ${q.timeColumn || 'not detected'} · Order: ${q.orderMethod || 'unknown'}`);
  const warnings = $('qualityWarnings'); warnings.replaceChildren();
  const warningItems = q.warnings?.length ? q.warnings : ['No parser warnings reported. Review source and ordering before relying on any analysis.'];
  warningItems.forEach(w => { const li = document.createElement('li'); li.textContent = w; warnings.appendChild(li); });
  renderGates(data.evidenceGates || []);
  renderRounds(data.recentRounds || []);
}
async function analyze() {
  if (busy) return;
  busy = true; $('analyzeBtn').disabled = true; $('analyzeBtn').textContent = 'ANALYZING…';
  try {
    const response = await fetch(`${API_BASE}/api/analyze`, { method: 'GET', cache: 'no-store', headers: { Accept: 'application/json' } });
    let data;
    try { data = await response.json(); } catch (_) { throw new Error(`API returned a non-JSON response (HTTP ${response.status}). Check the Render service and deployment.`); }
    if (!response.ok || data.ok !== true) throw new Error(data.error || `API request failed with HTTP ${response.status}.`);
    renderAnalysis(data);
  } catch (error) {
    setStatus(false); showError(`${error.message} API: ${API_BASE}`);
  } finally {
    busy = false; $('analyzeBtn').disabled = false; $('analyzeBtn').textContent = 'ANALYZE HISTORY';
  }
}
$('analyzeBtn').addEventListener('click', analyze);
analyze();
