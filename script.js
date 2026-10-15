'use strict';

const API_BASE = 'https://aviator-ai-predictor-1.onrender.com';

const $ = id => document.getElementById(id);

const fmt = (value, digits = 2) =>
  value === null ||
  value === undefined ||
  !Number.isFinite(Number(value))
    ? '—'
    : Number(value).toLocaleString(undefined, {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits
      });

const pct = value =>
  value === null ||
  value === undefined ||
  !Number.isFinite(Number(value))
    ? '—'
    : `${fmt(value)}%`;

const safe = value =>
  value === null || value === undefined || value === ''
    ? '—'
    : String(value);

function showError(message) {
  const box = $('errorBox');
  box.textContent = message;
  box.hidden = !message;
}

function setApi(ok, label) {
  $('apiStatus').textContent = label;

  $('statusDot').classList.toggle('online', !!ok);
  $('statusDot').classList.toggle('offline', !ok);
}

function makeCell(text) {
  const cell = document.createElement('td');
  cell.textContent = safe(text);
  return cell;
}

function addRow(tbody, values) {
  const row = document.createElement('tr');

  values.forEach(value => {
    row.appendChild(makeCell(value));
  });

  tbody.appendChild(row);
}

function fillTable(
  id,
  rows,
  emptyColumns,
  emptyText = 'No data available.'
) {
  const body = $(id);
  body.replaceChildren();

  if (!rows.length) {
    const row = document.createElement('tr');
    const cell = makeCell(emptyText);

    cell.colSpan = emptyColumns;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }

  rows.forEach(values => addRow(body, values));
}

function renderAnalyze(data) {
  $('sourceName').textContent = safe(
    data.sourcePath || data.source
  );

  $('roundCount').textContent =
    Number(data.rounds || 0).toLocaleString();

  $('generatedAt').textContent = data.generatedAt
    ? new Date(data.generatedAt).toLocaleString()
    : '—';

  $('latestValue').textContent = data.latestRound
    ? `${fmt(data.latestRound.multiplier)}x`
    : '—';

  const signal = data.signal || {};

  $('signalAction').textContent = safe(
    signal.action || 'NO SIGNAL'
  );

  $('signalAction').className =
    'action-label ' +
    String(signal.action || 'NO SIGNAL')
      .toLowerCase()
      .replace(/\s+/g, '-');

  $('signalScore').textContent = safe(signal.score);

  $('signalTarget').textContent =
    `${fmt(signal.targetMultiplier || 2)}x`;

  $('confidenceLabel').textContent = safe(
    signal.confidenceLabel ||
    'Evidence score, not win probability'
  );

  const reasons = $('signalReasons');
  reasons.replaceChildren();

  (
    signal.reasons ||
    ['No explanation returned.']
  ).forEach(reason => {
    const item = document.createElement('li');
    item.textContent = reason;
    reasons.appendChild(item);
  });

  const distribution = data.distribution || {};

  $('meanValue').textContent = fmt(distribution.mean);
  $('medianValue').textContent = fmt(distribution.median);
  $('minValue').textContent = `${fmt(distribution.min)}x`;
  $('maxValue').textContent = `${fmt(distribution.max)}x`;
  $('atLeast2').textContent = pct(distribution.atLeast2);
  $('atLeast10').textContent = pct(distribution.atLeast10);

  fillTable(
    'windowsBody',
    (data.windows || []).map(window => [
      `${window.window} rounds`,
      window.samples,
      fmt(window.mean),
      pct(window.atLeast2),
      pct(window.atLeast3)
    ]),
    5
  );

  const quality = data.dataQuality || {};

  $('qualityStatus').textContent =
    quality && quality.validRounds
      ? (
          quality.invalidRows === 0 &&
          quality.duplicateRoundIds === 0
            ? 'PASS'
            : 'REVIEW'
        )
      : 'UNAVAILABLE';

  $('sourceDataRows').textContent =
    safe(quality.sourceDataRows);

  $('invalidRows').textContent =
    safe(quality.invalidRows);

  $('duplicateIds').textContent =
    safe(quality.duplicateRoundIds);

  $('missingTimes').textContent =
    safe(quality.missingTimestamps);

  $('columnInfo').textContent =
    `Columns: multiplier=${safe(quality.multiplierColumn)}, ` +
    `round ID=${safe(quality.roundIdColumn)}, ` +
    `timestamp=${safe(quality.timeColumn)} · ` +
    `Order: ${safe(quality.orderMethod)}`;

  const warnings = $('qualityWarnings');
  warnings.replaceChildren();

  (quality.warnings || []).forEach(warning => {
    const item = document.createElement('li');
    item.textContent = warning;
    warnings.appendChild(item);
  });

  if (!(quality.warnings || []).length) {
    const item = document.createElement('li');
    item.textContent = 'No CSV quality warnings reported.';
    warnings.appendChild(item);
  }

  const gates = $('evidenceGates');
  gates.replaceChildren();

  (data.evidenceGates || []).forEach(gate => {
    const container = document.createElement('div');

    container.className =
      'gate ' + (gate.passed ? 'pass' : 'fail');

    const title = document.createElement('strong');
    title.textContent =
      `${gate.passed ? 'PASS' : 'NOT PASSED'} · ${gate.name}`;

    const detail = document.createElement('span');
    detail.textContent = gate.detail || '';

    container.append(title, detail);
    gates.appendChild(container);
  });
}

function renderBacktest(backtest) {
  $('backtestTarget').textContent =
    `${fmt(backtest.targetMultiplier || 2)}x`;

  $('testedPositions').textContent =
    Number(backtest.totalEvaluatedPositions || 0)
      .toLocaleString();

  const holdout = backtest.productionHoldout || {};

  $('btSamples').textContent = safe(holdout.samples);

  $('btHitsMisses').textContent =
    `${safe(holdout.hits)} / ${safe(holdout.misses)}`;

  $('btHitRate').textContent = pct(holdout.hitRate);
  $('btBaseline').textContent = pct(holdout.baselineHitRate);
  $('btCoverage').textContent = pct(holdout.coverage);

  $('backtestNote').textContent =
    backtest.note || 'Historical diagnostics only.';

  const diagnostics = backtest.diagnostics || [];

  fillTable(
    'backtestBody',
    diagnostics.map(item => [
      item.threshold,
      item.development.samples,
      pct(item.development.hitRate),
      item.holdout.samples,
      pct(item.holdout.hitRate),
      pct(item.holdout.baselineHitRate),
      pct(item.holdout.coverage)
    ]),
    7
  );
}

async function fetchJson(endpoint) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      Accept: 'application/json'
    }
  });

  const data = await response.json();

  if (!response.ok || data.ok === false) {
    throw new Error(
      data.error || `API request failed (${response.status}).`
    );
  }

  return data;
}

async function refresh() {
  const button = $('analyzeBtn');

  button.disabled = true;
  button.textContent = 'Analyzing…';

  showError('');

  try {
    const [analysis, backtest, history] = await Promise.all([
      fetchJson('/api/analyze'),
      fetchJson('/api/backtest'),
      fetchJson('/api/history?limit=20')
    ]);

    renderAnalyze(analysis);
    renderBacktest(backtest);

    fillTable(
      'roundsBody',
      (history.rows || [])
        .slice()
        .reverse()
        .map(row => [
          row.roundId,
          row.time
            ? new Date(row.time).toLocaleString()
            : '—',
          `${fmt(row.multiplier)}x`
        ]),
      3
    );

    setApi(
      true,
      `API ONLINE · ${analysis.version || 'version unknown'}`
    );
  } catch (error) {
    setApi(false, 'API OFFLINE');

    showError(
      `${error.message} Check the Render service and the API URL.`
    );
  } finally {
    button.disabled = false;
    button.textContent = 'Analyze history';
  }
}

$('analyzeBtn').addEventListener('click', refresh);

refresh();
