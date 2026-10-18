
'use strict';

/*
============================================================
 AVIATOR AI PREDICTOR
 V1.1.5 • SYNCHRONIZED FRONTEND

 Backend:
 https://aviator-ai-predictor-1.onrender.com

 Required research source:
 data/aviator-2026-10 (1).csv

 Pipeline:
 Collect → Analyze → Backtest → Score → Signal

 Historical research only. No guaranteed next multiplier.
============================================================
*/

const API_BASE = 'https://aviator-ai-predictor-1.onrender.com';
const REQUIRED_SOURCE = 'data/aviator-2026-10 (1).csv';
const REQUEST_TIMEOUT_MS = 25000;

const $ = id => document.getElementById(id);

const fmt = (value, digits = 2) => {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    !Number.isFinite(Number(value))
  ) {
    return '—';
  }

  return Number(value).toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  });
};

const pct = value => {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    !Number.isFinite(Number(value))
  ) {
    return '—';
  }

  return `${fmt(value)}%`;
};

const safe = value =>
  value === null || value === undefined || value === ''
    ? '—'
    : String(value);

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

function fillTable(
  id,
  rows,
  emptyColumns,
  emptyText = 'No data available.'
) {
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
  if (Number.isNaN(date.getTime())) return '—';

  return date.toLocaleString();
}

/* =========================================================
   SOURCE VALIDATION
========================================================= */

function validateSource(data, endpointName) {
  if (!data || data.ok !== true) {
    throw new Error(`${endpointName}: API did not return ok:true.`);
  }

  if (data.version !== 'V1.1.5') {
    throw new Error(
      `${endpointName}: expected V1.1.5, received ${safe(data.version)}.`
    );
  }

  if (data.sourcePath !== REQUIRED_SOURCE) {
    throw new Error(
      `${endpointName}: wrong CSV source. Expected ${REQUIRED_SOURCE}; ` +
      `received ${safe(data.sourcePath)}.`
    );
  }
}

/* =========================================================
   ANALYSIS
========================================================= */

function renderAnalyze(data) {
  setText('sourceName', data.sourcePath || data.source);
  setText('roundCount', Number(data.rounds || 0).toLocaleString());
  setText('generatedAt', formatDate(data.generatedAt));

  const latest = data.latestRound || {};
  setText(
    'latestValue',
    latest.multiplier !== undefined
      ? `${fmt(latest.multiplier)}x`
      : '—'
  );

  const signal = data.signal || {};
  const action = signal.action || 'NO SIGNAL';

  setText('signalAction', action);

  const actionElement = $('signalAction');
  if (actionElement) {
    actionElement.className =
      'action-label ' + String(action).toLowerCase().replace(/\s+/g, '-');
  }

  setText('signalScore', signal.score);
  setText(
    'signalTarget',
    `${fmt(signal.targetMultiplier ?? 2)}x`
  );
  setText(
    'confidenceLabel',
    signal.confidenceLabel || 'Evidence score, not win probability'
  );

  const reasons = $('signalReasons');
  if (reasons) {
    reasons.replaceChildren();

    const list = Array.isArray(signal.reasons)
      ? signal.reasons
      : ['No explanation returned.'];

    list.forEach(reason => {
      const item = document.createElement('li');
      item.textContent = safe(reason);
      reasons.appendChild(item);
    });
  }

  const distribution = data.distribution || {};

  setText('meanValue', fmt(distribution.mean));
  setText('medianValue', fmt(distribution.median));
  setText('minValue', `${fmt(distribution.min)}x`);
  setText('maxValue', `${fmt(distribution.max)}x`);
  setText('atLeast2', pct(distribution.atLeast2));
  setText('atLeast10', pct(distribution.atLeast10));

  const windows = Array.isArray(data.windows) ? data.windows : [];

  fillTable(
    'windowsBody',
    windows.map(window => [
      `${safe(window.window)} rounds`,
      safe(window.samples),
      fmt(window.mean),
      pct(window.atLeast2),
      pct(window.atLeast3)
    ]),
    5
  );

  renderQuality(data);
}

/* =========================================================
   DATA QUALITY AND EVIDENCE GATES
========================================================= */

function renderQuality(data) {
  const quality = data.dataQuality || {};

  setText('sourceDataRows', quality.sourceDataRows);
  setText('invalidRows', quality.invalidRows);
  setText('duplicateIds', quality.duplicateRoundIds);
  setText('missingTimes', quality.missingTimestamps);

  setText(
    'columnInfo',
    `Columns: multiplier=${safe(quality.multiplierColumn)}, ` +
    `round ID=${safe(quality.roundIdColumn)}, ` +
    `timestamp=${safe(quality.timeColumn)} · ` +
    `Order: ${safe(quality.orderMethod)}`
  );

  const warnings = $('qualityWarnings');
  if (warnings) {
    warnings.replaceChildren();

    const list = Array.isArray(quality.warnings)
      ? quality.warnings
      : [];

    if (list.length) {
      list.forEach(warning => {
        const item = document.createElement('li');
        item.textContent = safe(warning);
        warnings.appendChild(item);
      });
    } else {
      const item = document.createElement('li');
      item.textContent = 'No CSV quality warnings reported.';
      warnings.appendChild(item);
    }
  }

  const invalid = Number(quality.invalidRows ?? 0);
  const duplicates = Number(quality.duplicateRoundIds ?? 0);
  const validRounds = Number(quality.validRounds ?? 0);

  const qualityPassed =
    quality.sourceFile === 'aviator-2026-10 (1).csv' &&
    validRounds >= 1000 &&
    invalid === 0 &&
    duplicates === 0;

  const badge = $('qualityStatus');
  if (badge) {
    badge.textContent = qualityPassed
      ? 'SOURCE CHECK PASSED'
      : 'CHECK REQUIRED';

    badge.style.color = qualityPassed
      ? 'var(--green)'
      : 'var(--yellow)';
  }

  const gates = $('evidenceGates');
  if (gates) {
    gates.replaceChildren();

    const list = Array.isArray(data.evidenceGates)
      ? data.evidenceGates
      : [];

    list.forEach(gate => {
      const container = document.createElement('div');
      container.className = 'gate ' + (gate.passed ? 'pass' : 'fail');

      const title = document.createElement('strong');
      title.textContent =
        `${gate.passed ? 'PASS' : 'NOT PASSED'} · ${safe(gate.name)}`;

      const detail = document.createElement('span');
      detail.textContent = safe(gate.detail || '');

      container.append(title, detail);
      gates.appendChild(container);
    });
  }
}

/* =========================================================
   BACKTEST
========================================================= */

function renderBacktest(backtest) {
  setText(
    'backtestTarget',
    `${fmt(backtest.targetMultiplier ?? 2)}x`
  );

  setText(
    'testedPositions',
    Number(backtest.totalEvaluatedPositions || 0).toLocaleString()
  );

  const holdout = backtest.productionHoldout || {};

  setText('btSamples', holdout.samples);
  setText(
    'btHitsMisses',
    `${safe(holdout.hits)} / ${safe(holdout.misses)}`
  );
  setText('btHitRate', pct(holdout.hitRate));
  setText('btBaseline', pct(holdout.baselineHitRate));
  setText('btCoverage', pct(holdout.coverage));
  setText('backtestNote', backtest.note || 'Historical diagnostics only.');

  const diagnostics = Array.isArray(backtest.diagnostics)
    ? backtest.diagnostics
    : [];

  fillTable(
    'backtestBody',
    diagnostics.map(item => {
      const development = item.development || {};
      const test = item.holdout || {};

      return [
        safe(item.threshold),
        safe(development.samples),
        pct(development.hitRate),
        safe(test.samples),
        pct(test.hitRate),
        pct(test.baselineHitRate),
        pct(test.coverage)
      ];
    }),
    7
  );
}

/* =========================================================
   RECENT HISTORY
========================================================= */

function renderHistory(history) {
  const rows = Array.isArray(history.rows) ? history.rows : [];

  fillTable(
    'roundsBody',
    rows.slice().reverse().map(row => [
      safe(row.roundId),
      row.time ? formatDate(row.time) : '—',
      `${fmt(row.multiplier)}x`
    ]),
    3
  );
}

/* =========================================================
   API REQUEST
========================================================= */

async function fetchJson(endpoint) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const separator = endpoint.includes('?') ? '&' : '?';
    const url = `${API_BASE}${endpoint}${separator}_=${Date.now()}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal
    });

    let data;

    try {
      data = await response.json();
    } catch (_) {
      throw new Error(
        `API returned a non-JSON response (HTTP ${response.status}).`
      );
    }

    if (!response.ok || !data || data.ok !== true) {
      throw new Error(
        (data && data.error) ||
        `API request failed (HTTP ${response.status}).`
      );
    }

    return data;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`API request timed out after ${REQUEST_TIMEOUT_MS} ms.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================================
   REFRESH ALL DATA
========================================================= */

let refreshRunning = false;

async function refresh() {
  const button = $('analyzeBtn');

  if (refreshRunning) return;
  refreshRunning = true;

  if (button) {
    button.disabled = true;
    button.textContent = 'Analyzing…';
  }

  showError('');
  setApi(false, 'CHECKING API…');

  try {
    const [status, analysis, backtest, history] = await Promise.all([
      fetchJson('/api/status'),
      fetchJson('/api/analyze'),
      fetchJson('/api/backtest'),
      fetchJson('/api/history?limit=20')
    ]);

    validateSource(status, 'Status');
    validateSource(analysis, 'Analysis');
    validateSource(backtest, 'Backtest');
    validateSource(history, 'History');

    if (
      Number(status.rounds) !== Number(analysis.rounds) ||
      Number(status.rounds) !== Number(backtest.rounds) ||
      Number(status.rounds) !== Number(history.rounds)
    ) {
      throw new Error(
        'Endpoint round counts do not match. Results were not rendered.'
      );
    }

    renderAnalyze(analysis);
    renderBacktest(backtest);
    renderHistory(history);

    setApi(
      true,
      `API ONLINE · ${analysis.version} · ${Number(analysis.rounds).toLocaleString()} ROUNDS`
    );

    window.__AVIATOR_LAST_RESPONSE = {
      status,
      analysis,
      backtest,
      history
    };
  } catch (error) {
    console.error('AVIATOR refresh failed:', error);

    setApi(false, 'API ERROR / SOURCE CHECK');

    showError(
      `${error.message} Confirm the Render service, deployed version, and large CSV source.`
    );
  } finally {
    refreshRunning = false;

    if (button) {
      button.disabled = false;
      button.textContent = 'Analyze history';
    }
  }
}

/* =========================================================
   INITIALIZATION
========================================================= */

function initialize() {
  const button = $('analyzeBtn');

  if (button) {
    button.addEventListener('click', refresh);
  }

  refresh();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
  initialize();
}
