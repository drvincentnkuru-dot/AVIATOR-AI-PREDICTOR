'use strict';

/* AVIATOR AI PREDICTOR V1.3.0 — large-CSV historical research dashboard. */
const API_BASE = 'https://aviator-ai-predictor-1.onrender.com';
const REQUIRED_SOURCE = 'data/aviator-2026-10 (1).csv';
const REQUIRED_VERSION = 'V1.3.0';
const REQUEST_TIMEOUT_MS = 25000;
const $ = id => document.getElementById(id);

const fmt = (value, digits = 2) => {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
};
const pct = value => value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : `${fmt(value)}%`;
const safe = value => value === null || value === undefined || value === '' ? '—' : String(value);

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = safe(value);
}
function showError(message) {
  const box = $('errorBox');
  if (!box) return;
  box.textContent = message || '';
  box.hidden = !message;
}
function setApi(ok, label) {
  setText('apiStatus', label);
  const dot = $('statusDot');
  if (dot) {
    dot.classList.toggle('online', Boolean(ok));
    dot.classList.toggle('offline', !ok);
  }
}
function makeCell(value) {
  const cell = document.createElement('td');
  cell.textContent = safe(value);
  return cell;
}
function fillTable(id, rows, emptyColumns, emptyText = 'No data available.') {
  const body = $(id);
  if (!body) return;
  body.replaceChildren();
  if (!Array.isArray(rows) || rows.length === 0) {
    const row = document.createElement('tr');
    const cell = makeCell(emptyText);
    cell.colSpan = emptyColumns;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  rows.forEach(values => {
    const row = document.createElement('tr');
    values.forEach(value => row.appendChild(makeCell(value)));
    body.appendChild(row);
  });
}
function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}
function validateSource(data, endpoint) {
  if (!data || data.ok !== true) throw new Error(`${endpoint}: API did not return ok:true. ${safe(data && data.error)}`);
  if (data.version !== REQUIRED_VERSION) throw new Error(`${endpoint}: expected ${REQUIRED_VERSION}, received ${safe(data.version)}.`);
  if (data.sourcePath !== REQUIRED_SOURCE) throw new Error(`${endpoint}: wrong CSV source. Expected ${REQUIRED_SOURCE}; received ${safe(data.sourcePath)}.`);
}
function clearDashboard() {
  [
    'sourceName', 'roundCount', 'latestValue', 'latestTime', 'sourceAge', 'generatedAt',
    'signalScore', 'probabilityValue', 'probabilityVsBaseline', 'probabilityDetails',
    'meanValue', 'medianValue', 'minValue', 'maxValue', 'atLeast2', 'atLeast10',
    'backtestTarget', 'testedPositions', 'btSamples', 'btHitsMisses', 'btHitRate', 'btBaseline', 'btCoverage',
    'sourceDataRows', 'invalidRows', 'duplicateIds', 'missingTimes', 'columnInfo'
  ].forEach(id => setText(id, '—'));
  setText('signalAction', 'NO SIGNAL');
  setText('evidenceStatus', 'Waiting for analysis…');
  setText('freshnessNotice', 'Checking source freshness…');
  setText('qualityStatus', 'Checking…');
  setText('backtestNote', 'Loading walk-forward validation…');
  setText('nextSignalNote', 'Historical estimate only; no guaranteed next multiplier.');
  const action = $('signalAction');
  if (action) action.className = 'action-label no-signal';
  fillTable('windowsBody', [], 5, 'Waiting for analysis…');
  fillTable('backtestBody', [], 7, 'Waiting for validation…');
  fillTable('roundsBody', [], 3, 'Waiting for history…');
  ['signalReasons', 'qualityWarnings', 'evidenceGates'].forEach(id => {
    const el = $(id);
    if (el) el.replaceChildren();
  });
}
function renderAnalyze(data) {
  setText('sourceName', data.sourcePath || data.source);
  setText('roundCount', Number(data.rounds || 0).toLocaleString());
  setText('generatedAt', formatDate(data.generatedAt));

  const latest = data.latestRound || {};
  setText('latestValue', latest.multiplier === undefined ? '—' : `${fmt(latest.multiplier)}x`);
  setText('latestTime', formatDate(latest.time));
  setText('sourceAge', data.sourceAgeHours === null || data.sourceAgeHours === undefined ? 'Unknown' : `${fmt(data.sourceAgeHours, 1)} hours`);

  const signal = data.signal || {};
  const decision = ['SIGNAL', 'WATCH', 'NO SIGNAL'].includes(signal.action) ? signal.action : 'NO SIGNAL';
  setText('signalAction', decision);
  const actionElement = $('signalAction');
  if (actionElement) actionElement.className = `action-label ${decision === 'SIGNAL' ? 'signal' : decision === 'WATCH' ? 'watch' : 'no-signal'}`;
  setText('evidenceStatus', (data.nextRoundSignal || {}).evidenceStatus || 'LOW / INSUFFICIENT EVIDENCE');
  setText('signalScore', signal.score);
  setText('signalTarget', `${fmt((data.nextRoundSignal || {}).targetMultiplier ?? signal.targetMultiplier ?? 2)}x`);
  setText('nextSignalNote', (data.nextRoundSignal || {}).note || 'Historical estimate only; no guaranteed next multiplier.');
  setText('confidenceLabel', signal.confidenceLabel || 'Evidence score, not win probability');

  const probability = data.probabilityEstimate || {};
  setText('probabilityValue', probability.probabilityPercent == null ? '—' : `${fmt(probability.probabilityPercent)}%`);
  setText('probabilityVsBaseline', probability.historicalBaselinePercent == null ? 'Baseline: —' : `Baseline: ${fmt(probability.historicalBaselinePercent)}%`);
  const interval = probability.confidenceInterval95 || {};
  const intervalText = interval.lowerPercent == null || interval.upperPercent == null
    ? 'No sequence-specific interval available.'
    : `Raw matched-history Wilson interval: ${fmt(interval.lowerPercent)}–${fmt(interval.upperPercent)}%`;
  const patternText = Number(probability.contextLength) > 0
    ? `${safe(probability.matchingSamples)} completed matches of the latest ${safe(probability.contextLength)}-round pattern. `
    : 'Using the full-history base rate; no qualifying sequence was found. ';
  setText('probabilityDetails', `${patternText}${intervalText} This interval is descriptive; overlapping observations may be dependent.`);

  const reasons = $('signalReasons');
  if (reasons) {
    reasons.replaceChildren();
    (Array.isArray(signal.reasons) && signal.reasons.length ? signal.reasons : ['No explanation returned.']).forEach(reason => {
      const item = document.createElement('li');
      item.textContent = safe(reason);
      reasons.appendChild(item);
    });
  }

  const fresh = data.dataFresh === true;
  const notice = $('freshnessNotice');
  if (notice) {
    notice.textContent = fresh
      ? `SOURCE FRESH · Latest round is within the ${safe(data.maxDataAgeHours)}-hour limit. This does not mean a live game feed is connected.`
      : `SOURCE STALE OR UNVERIFIED · Latest round age: ${data.sourceAgeHours == null ? 'unknown' : `${fmt(data.sourceAgeHours, 1)} hours`}. Historical results are shown, but SIGNAL is blocked.`;
    notice.className = `freshness-notice ${fresh ? 'fresh' : 'stale'}`;
  }

  const distribution = data.distribution || {};
  setText('meanValue', fmt(distribution.mean));
  setText('medianValue', fmt(distribution.median));
  setText('minValue', `${fmt(distribution.min)}x`);
  setText('maxValue', `${fmt(distribution.max)}x`);
  setText('atLeast2', pct(distribution.atLeast2));
  setText('atLeast10', pct(distribution.atLeast10));
  const windows = Array.isArray(data.windows) ? data.windows : [];
  fillTable('windowsBody', windows.map(window => [
    `${safe(window.window)} rounds`, safe(window.samples), fmt(window.mean), pct(window.atLeast2), pct(window.atLeast3)
  ]), 5);
  renderQuality(data);
}
function renderQuality(data) {
  const quality = data.dataQuality || {};
  setText('sourceDataRows', quality.sourceDataRows);
  setText('invalidRows', quality.invalidRows);
  setText('duplicateIds', quality.duplicateRoundIds);
  setText('missingTimes', quality.missingTimestamps);
  setText('columnInfo', `Columns: multiplier=${safe(quality.multiplierColumn)}, round ID=${safe(quality.roundIdColumn)}, timestamp=${safe(quality.timeColumn)} · Order: ${safe(quality.orderMethod)}`);

  const warnings = $('qualityWarnings');
  if (warnings) {
    warnings.replaceChildren();
    (Array.isArray(quality.warnings) && quality.warnings.length ? quality.warnings : ['No CSV quality warnings reported.']).forEach(warning => {
      const item = document.createElement('li');
      item.textContent = safe(warning);
      warnings.appendChild(item);
    });
  }
  const passed = quality.sourceFile === 'aviator-2026-10 (1).csv' && Number(quality.validRounds) >= 1000 && Number(quality.invalidRows) === 0 && Number(quality.duplicateRoundIds) === 0;
  const badge = $('qualityStatus');
  if (badge) {
    badge.textContent = passed ? 'SOURCE CHECK PASSED' : 'CHECK REQUIRED';
    badge.classList.toggle('pass', passed);
    badge.classList.toggle('fail', !passed);
  }
  const gates = $('evidenceGates');
  if (gates) {
    gates.replaceChildren();
    (Array.isArray(data.evidenceGates) ? data.evidenceGates : []).forEach(gate => {
      const box = document.createElement('div');
      box.className = `gate ${gate.passed ? 'pass' : 'fail'}`;
      const title = document.createElement('strong');
      title.textContent = `${gate.passed ? 'PASS' : 'NOT PASSED'} · ${safe(gate.name)}`;
      const detail = document.createElement('span');
      detail.textContent = safe(gate.detail || '');
      box.append(title, detail);
      gates.appendChild(box);
    });
  }
}
function renderBacktest(backtest) {
  setText('backtestTarget', `${fmt(backtest.targetMultiplier ?? 2)}x`);
  setText('testedPositions', Number(backtest.totalEvaluatedPositions || 0).toLocaleString());
  const holdout = backtest.holdoutCandidates || {};
  setText('btSamples', holdout.samples);
  setText('btHitsMisses', `${safe(holdout.hits)} / ${safe(holdout.misses)}`);
  setText('btHitRate', pct(holdout.hitRatePercent));
  setText('btBaseline', pct(holdout.baselinePercent));
  setText('btCoverage', pct(holdout.coveragePercent));
  setText('backtestNote', backtest.note || 'Chronological historical diagnostics only.');
  const datasets = [
    ['Development', backtest.developmentCandidates],
    ['Untouched holdout', backtest.holdoutCandidates],
    ['All periods (diagnostic)', backtest.overallCandidates]
  ];
  fillTable('backtestBody', datasets.map(([name, result]) => {
    const value = result || {};
    return [name, safe(value.samples), pct(value.hitRatePercent), pct(value.baselinePercent), pct(value.liftPercentagePoints), pct(value.confidenceInterval95 && value.confidenceInterval95.lowerPercent), pct(value.coveragePercent)];
  }), 7);
}
function renderHistory(data) {
  const rows = Array.isArray(data.rows) ? data.rows : [];
  fillTable('roundsBody', rows.slice().reverse().map(row => [safe(row.roundId), formatDate(row.time), `${fmt(row.multiplier)}x`]), 3);
}
async function fetchJson(endpoint) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `${API_BASE}${endpoint}${endpoint.includes('?') ? '&' : '?'}_=${Date.now()}`;
    const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
    let data;
    try { data = await response.json(); }
    catch { throw new Error(`${endpoint}: response was not valid JSON (HTTP ${response.status}).`); }
    if (!response.ok || data.ok !== true) throw new Error(data.error || `${endpoint}: request failed (HTTP ${response.status}).`);
    validateSource(data, endpoint);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`${endpoint}: request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
async function refreshAll() {
  const button = $('analyzeBtn');
  if (button) {
    button.disabled = true;
    button.textContent = 'Analyzing…';
  }
  showError('');
  setApi(false, 'Connecting…');
  clearDashboard();

  const endpoints = [
    ['status', '/api/status'],
    ['analysis', '/api/analyze'],
    ['backtest', '/api/backtest'],
    ['history', '/api/history?limit=50']
  ];
  try {
    const settled = await Promise.allSettled(endpoints.map(([, endpoint]) => fetchJson(endpoint)));
    const results = {};
    const errors = [];
    settled.forEach((result, index) => {
      const key = endpoints[index][0];
      if (result.status === 'fulfilled') results[key] = result.value;
      else errors.push(result.reason && result.reason.message ? result.reason.message : `${key}: request failed.`);
    });

    if (results.status && results.status.sourcePath !== REQUIRED_SOURCE) errors.push('Status endpoint reports an unexpected CSV source.');
    if (results.analysis) renderAnalyze(results.analysis);
    if (results.backtest) renderBacktest(results.backtest);
    if (results.history) renderHistory(results.history);

    if (results.status && results.analysis) {
      setApi(true, `API online · ${Number(results.status.rounds || 0).toLocaleString()} rounds`);
    } else {
      setApi(false, 'API partially unavailable');
    }
    if (errors.length) showError(`Some dashboard sections could not be refreshed:\n${errors.join('\n')}\nCheck Render status and confirm the required large CSV is deployed.`);
  } catch (error) {
    setApi(false, 'API unavailable');
    showError(`${error.message || 'Unknown API error'} Check that Render is running and the required large CSV is present.`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'Analyze history';
    }
  }
}

if ($('analyzeBtn')) $('analyzeBtn').addEventListener('click', refreshAll);
refreshAll();
