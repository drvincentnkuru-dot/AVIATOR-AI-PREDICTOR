'use strict';

/* AVIATOR AI PREDICTOR V1.2.0 — large-CSV research dashboard. */
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
  const el = $(id);
  if (el) el.textContent = safe(value);
}

function showError(message) {
  const box = $('errorBox');

  if (box) {
    box.textContent = message || '';
    box.hidden = !message;
  }
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
  const td = document.createElement('td');
  td.textContent = safe(value);
  return td;
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
    const tr = document.createElement('tr');
    const td = makeCell(emptyText);

    td.colSpan = emptyColumns;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  rows.forEach(values => {
    const tr = document.createElement('tr');

    values.forEach(value => {
      tr.appendChild(makeCell(value));
    });

    body.appendChild(tr);
  });
}

function formatDate(value) {
  if (!value) return '—';

  const d = new Date(value);

  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString();
}

function validateSource(data, endpoint) {
  if (!data || data.ok !== true) {
    throw new Error(
      `${endpoint}: API did not return ok:true. ${safe(data && data.error)}`
    );
  }

  if (data.version !== 'V1.2.0') {
    throw new Error(
      `${endpoint}: expected V1.2.0, received ${safe(data.version)}.`
    );
  }

  if (data.sourcePath !== REQUIRED_SOURCE) {
    throw new Error(
      `${endpoint}: wrong CSV source. Expected ${REQUIRED_SOURCE}; received ${safe(data.sourcePath)}.`
    );
  }
}

function renderAnalyze(data) {
  setText('sourceName', data.sourcePath || data.source);

  setText(
    'roundCount',
    Number(data.rounds || 0).toLocaleString()
  );

  setText('generatedAt', formatDate(data.generatedAt));

  const latest = data.latestRound || {};

  setText(
    'latestValue',
    latest.multiplier !== undefined
      ? `${fmt(latest.multiplier)}x`
      : '—'
  );

  const signal = data.signal || {};

  const decision = [
    'SIGNAL',
    'WATCH',
    'NO SIGNAL'
  ].includes(signal.action)
    ? signal.action
    : 'NO SIGNAL';

  setText('signalAction', decision);

  const actionEl = $('signalAction');

  const actionClass =
    decision === 'SIGNAL'
      ? 'signal'
      : decision === 'WATCH'
        ? 'watch'
        : 'no-signal';

  if (actionEl) {
    actionEl.className = `action-label ${actionClass}`;
  }

  setText(
    'evidenceStatus',
    (data.nextRoundSignal || {}).evidenceStatus ||
      'LOW / INSUFFICIENT EVIDENCE'
  );

  setText('signalScore', signal.score);

  const target =
    (data.nextRoundSignal || {}).targetMultiplier ??
    signal.targetMultiplier ??
    2;

  setText('signalTarget', `${fmt(target)}x`);

  setText(
    'nextSignalNote',
    (data.nextRoundSignal || {}).note ||
      'Historical estimate only; no guaranteed next multiplier.'
  );

  setText(
    'confidenceLabel',
    signal.confidenceLabel ||
      'Evidence score, not win probability'
  );

  const probability = data.probabilityEstimate || {};

  setText(
    'probabilityValue',
    probability.probabilityPercent == null
      ? '—'
      : `${fmt(probability.probabilityPercent)}%`
  );

  setText(
    'probabilityVsBaseline',
    probability.historicalBaselinePercent == null
      ? 'Baseline: —'
      : `Baseline: ${fmt(probability.historicalBaselinePercent)}%`
  );

  const ci = probability.confidenceInterval95 || {};

  const ciText =
    ci.lowerPercent == null || ci.upperPercent == null
      ? '95% interval unavailable'
      : `95% interval of matched-history rate: ${fmt(ci.lowerPercent)}–${fmt(ci.upperPercent)}%`;

  const matchText = Number(probability.contextLength) > 0
    ? `${safe(probability.matchingSamples)} matching transitions across the latest ${safe(probability.contextLength)}-round pattern. `
    : 'Using the full-history base rate because no matching pattern had enough examples. ';

  setText(
    'probabilityDetails',
    `${matchText}${ciText}. Historical estimate only, not a guarantee.`
  );

  const reasons = $('signalReasons');

  if (reasons) {
    reasons.replaceChildren();

    const items =
      Array.isArray(signal.reasons) && signal.reasons.length
        ? signal.reasons
        : ['No explanation returned.'];

    items.forEach(reason => {
      const li = document.createElement('li');
      li.textContent = safe(reason);
      reasons.appendChild(li);
    });
  }

  const d = data.distribution || {};

  setText('meanValue', fmt(d.mean));
  setText('medianValue', fmt(d.median));
  setText('minValue', `${fmt(d.min)}x`);
  setText('maxValue', `${fmt(d.max)}x`);
  setText('atLeast2', pct(d.atLeast2));
  setText('atLeast10', pct(d.atLeast10));

  const windows = Array.isArray(data.windows)
    ? data.windows
    : [];

  fillTable(
    'windowsBody',
    windows.map(w => [
      `${safe(w.window)} rounds`,
      safe(w.samples),
      fmt(w.mean),
      pct(w.atLeast2),
      pct(w.atLeast3)
    ]),
    5
  );

  renderQuality(data);
}

function renderQuality(data) {
  const q = data.dataQuality || {};

  setText('sourceDataRows', q.sourceDataRows);
  setText('invalidRows', q.invalidRows);
  setText('duplicateIds', q.duplicateRoundIds);
  setText('missingTimes', q.missingTimestamps);

  setText(
    'columnInfo',
    `Columns: multiplier=${safe(q.multiplierColumn)}, round ID=${safe(q.roundIdColumn)}, timestamp=${safe(q.timeColumn)} · Order: ${safe(q.orderMethod)}`
  );

  const warnings = $('qualityWarnings');

  if (warnings) {
    warnings.replaceChildren();

    const list = Array.isArray(q.warnings)
      ? q.warnings
      : [];

    (
      list.length
        ? list
        : ['No CSV quality warnings reported.']
    ).forEach(warning => {
      const li = document.createElement('li');
      li.textContent = safe(warning);
      warnings.appendChild(li);
    });
  }

  const passed =
    q.sourceFile === 'aviator-2026-10 (1).csv' &&
    Number(q.validRounds) >= 1000 &&
    Number(q.invalidRows) === 0 &&
    Number(q.duplicateRoundIds) === 0;

  const badge = $('qualityStatus');

  if (badge) {
    badge.textContent = passed
      ? 'SOURCE CHECK PASSED'
      : 'CHECK REQUIRED';

    badge.classList.toggle('pass', passed);
    badge.classList.toggle('fail', !passed);
  }

  const gates = $('evidenceGates');

  if (gates) {
    gates.replaceChildren();

    (
      Array.isArray(data.evidenceGates)
        ? data.evidenceGates
        : []
    ).forEach(g => {
      const box = document.createElement('div');

      box.className = `gate ${g.passed ? 'pass' : 'fail'}`;

      const title = document.createElement('strong');
      title.textContent =
        `${g.passed ? 'PASS' : 'NOT PASSED'} · ${safe(g.name)}`;

      const detail = document.createElement('span');
      detail.textContent = safe(g.detail || '');

      box.append(title, detail);
      gates.appendChild(box);
    });
  }
}

function renderBacktest(bt) {
  setText(
    'backtestTarget',
    `${fmt(bt.targetMultiplier ?? 2)}x`
  );

  setText(
    'testedPositions',
    Number(bt.totalEvaluatedPositions || 0).toLocaleString()
  );

  const h = bt.productionHoldout || {};

  setText('btSamples', h.samples);
  setText(
    'btHitsMisses',
    `${safe(h.hits)} / ${safe(h.misses)}`
  );

  setText('btHitRate', pct(h.hitRate));
  setText('btBaseline', pct(h.baselineHitRate));
  setText('btCoverage', pct(h.coverage));

  setText(
    'backtestNote',
    bt.note || 'Historical diagnostics only.'
  );

  const diagnostics = Array.isArray(bt.diagnostics)
    ? bt.diagnostics
    : [];

  fillTable(
    'backtestBody',
    diagnostics.map(item => {
      const d = item.development || {};
      const h2 = item.holdout || {};

      return [
        safe(item.threshold),
        safe(d.samples),
        pct(d.hitRate),
        safe(h2.samples),
        pct(h2.hitRate),
        pct(h2.baselineHitRate),
        pct(h2.coverage)
      ];
    }),
    7
  );
}

function renderHistory(data) {
  const rows = Array.isArray(data.rows)
    ? data.rows
    : [];

  fillTable(
    'roundsBody',
    rows.slice().reverse().map(r => [
      safe(r.roundId),
      r.time ? formatDate(r.time) : '—',
      `${fmt(r.multiplier)}x`
    ]),
    3
  );
}

async function fetchJson(endpoint) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const url =
      `${API_BASE}${endpoint}` +
      `${endpoint.includes('?') ? '&' : '?'}_=${Date.now()}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json'
      },
      cache: 'no-store',
      signal: controller.signal
    });

    let data;

    try {
      data = await response.json();
    } catch {
      throw new Error(
        `${endpoint}: API response was not valid JSON (HTTP ${response.status}).`
      );
    }

    if (!response.ok || data.ok !== true) {
      throw new Error(
        data.error ||
        `${endpoint}: request failed (HTTP ${response.status}).`
      );
    }

    validateSource(data, endpoint);

    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(
        `${endpoint}: request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`
      );
    }

    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshAll() {
  const btn = $('analyzeBtn');

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Analyzing…';
  }

  showError('');
  setApi(false, 'Connecting…');

  try {
    const [status, analysis, bt, history] = await Promise.all([
      fetchJson('/api/status'),
      fetchJson('/api/analyze'),
      fetchJson('/api/backtest'),
      fetchJson('/api/history?limit=50')
    ]);

    if (status.sourcePath !== REQUIRED_SOURCE) {
      throw new Error(
        'Status endpoint reports an unexpected CSV source.'
      );
    }

    renderAnalyze(analysis);
    renderBacktest(bt);
    renderHistory(history);

    setApi(
      true,
      `API online · ${Number(status.rounds || 0).toLocaleString()} rounds`
    );
  } catch (err) {
    setApi(false, 'API unavailable');

    showError(
      `${err.message || 'Unknown API error'} Check that Render is running and the required large CSV is present.`
    );
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Analyze history';
    }
  }
}

if ($('analyzeBtn')) {
  $('analyzeBtn').addEventListener('click', refreshAll);
}

refreshAll();
