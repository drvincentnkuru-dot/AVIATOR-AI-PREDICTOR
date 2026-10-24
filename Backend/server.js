'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const VERSION = 'V1.1.5';
const PORT = Number(process.env.PORT || 10000);
const ROOT_DIR = path.resolve(__dirname, '..');
const CSV_NAME = 'aviator-2026-10 (1).csv';
const CSV_FILE = path.join(ROOT_DIR, 'data', CSV_NAME);
const TARGET_MULTIPLIER = 2;
const MIN_HISTORY = 24;
const BACKTEST_MIN_SAMPLES = 30;
const SIGNAL_THRESHOLD = 72;
const WATCH_THRESHOLD = 60;
const MIN_EXPECTED_SOURCE_ROWS = 1000;
const MAX_HISTORY_RESPONSE = 10000;
const DIAGNOSTIC_THRESHOLDS = [50, 55, 60, 65, 68, 72];

const CACHE = {
  file: null,
  mtimeMs: null,
  size: null,
  loadedAt: null,
  rows: [],
  quality: null,
  error: null
};

function normalizeHeader(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// CSV parser supports quoted commas, escaped quotes, and quoted newlines.
function parseCsv(text) {
  const source = String(text).replace(/^\uFEFF/, '');
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (ch === '"') {
      if (quoted && source[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      record.push(field);
      field = '';
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && source[i + 1] === '\n') i++;

      record.push(field);
      field = '';

      if (record.some(cell => String(cell).trim() !== '')) {
        records.push(record);
      }

      record = [];
    } else {
      field += ch;
    }
  }

  if (quoted) {
    throw new Error('CSV contains an unclosed quoted field.');
  }

  record.push(field);

  if (record.some(cell => String(cell).trim() !== '')) {
    records.push(record);
  }

  if (records.length < 2) {
    throw new Error('The required CSV has no data rows.');
  }

  return records;
}

function parseMultiplier(raw) {
  const normalized = String(raw ?? '')
    .trim()
    .replace(/[xX]$/, '')
    .replace(/\s/g, '')
    .replace(',', '.');

  if (!normalized) return null;

  const n = Number(normalized);

  return Number.isFinite(n) && n >= 1 && n <= 1000000
    ? Math.round(n * 10000) / 10000
    : null;
}

function compareRoundIds(a, b) {
  try {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  } catch {
    return String(a).localeCompare(String(b));
  }
}

function parseSourceCsv(text) {
  const records = parseCsv(text);
  const headers = records[0].map(normalizeHeader);
  const find = aliases => headers.findIndex(h => aliases.includes(h));

  const multiplierIndex = find([
    'crash_multiplier',
    'multiplier',
    'crash',
    'crashpoint',
    'crash_point',
    'value',
    'coefficient',
    'result',
    'x',
    'outcome'
  ]);

  const roundIdIndex = find([
    'round_id',
    'round',
    'roundid',
    'game_id',
    'id',
    'round_number'
  ]);

  const timeIndex = find([
    'time_utc',
    'timestamp',
    'time',
    'date',
    'datetime',
    'created_at',
    'createdat'
  ]);

  if (multiplierIndex < 0) {
    throw new Error('The required CSV has no recognized multiplier column.');
  }

  if (roundIdIndex < 0) {
    throw new Error('The required CSV has no recognized round ID column.');
  }

  const rows = [];
  let invalidRows = 0;
  let missingTimestamps = 0;
  let missingRoundIds = 0;

  for (let i = 1; i < records.length; i++) {
    const cells = records[i];
    const multiplier = parseMultiplier(cells[multiplierIndex]);

    if (multiplier === null) {
      invalidRows++;
      continue;
    }

    const roundId = String(cells[roundIdIndex] ?? '').trim();

    if (!roundId) {
      missingRoundIds++;
      invalidRows++;
      continue;
    }

    const rawTime = timeIndex >= 0
      ? String(cells[timeIndex] ?? '').trim()
      : '';

    const timeMs = rawTime ? Date.parse(rawTime) : NaN;

    if (!Number.isFinite(timeMs)) {
      missingTimestamps++;
    }

    rows.push({
      roundId,
      time: rawTime || null,
      timeMs: Number.isFinite(timeMs) ? timeMs : null,
      multiplier,
      sourceLine: i + 1
    });
  }

  if (rows.length < MIN_EXPECTED_SOURCE_ROWS) {
    throw new Error(
      `Wrong or incomplete CSV selected: only ${rows.length} valid rounds parsed from ${CSV_NAME}; expected at least ${MIN_EXPECTED_SOURCE_ROWS}.`
    );
  }

  if (!rows.every(r => /^\d+$/.test(r.roundId))) {
    throw new Error(
      'The required CSV contains non-numeric round IDs; refusing to guess order.'
    );
  }

  rows.sort((a, b) => compareRoundIds(a.roundId, b.roundId));

  const seen = new Set();

  const unique = rows.filter(row => {
    if (seen.has(row.roundId)) return false;
    seen.add(row.roundId);
    return true;
  });

  const duplicateRoundIds = rows.length - unique.length;
  const warnings = [];

  if (missingTimestamps) {
    warnings.push(
      `${missingTimestamps} valid round(s) have missing or unparseable timestamps.`
    );
  }

  if (missingRoundIds) {
    warnings.push(
      `${missingRoundIds} row(s) with missing round IDs were rejected.`
    );
  }

  if (invalidRows) {
    warnings.push(
      `${invalidRows} source row(s) were rejected due to invalid data.`
    );
  }

  if (duplicateRoundIds) {
    warnings.push(
      `${duplicateRoundIds} duplicate round ID(s) were removed.`
    );
  }

  return {
    rows: unique,
    quality: {
      sourceFile: CSV_NAME,
      sourceDataRows: records.length - 1,
      validRowsBeforeDeduplication: rows.length,
      validRounds: unique.length,
      invalidRows,
      duplicateRoundIds,
      missingTimestamps,
      missingRoundIds,
      headerColumns: headers,
      multiplierColumn: headers[multiplierIndex],
      roundIdColumn: headers[roundIdIndex],
      timeColumn: timeIndex >= 0 ? headers[timeIndex] : null,
      orderMethod: 'numeric round_id ascending',
      firstRound: unique[0]?.roundId ?? null,
      lastRound: unique[unique.length - 1]?.roundId ?? null,
      warnings
    }
  };
}

function loadData(force = false) {
  try {
    const stat = fs.statSync(CSV_FILE);

    if (!stat.isFile()) {
      throw new Error('The required CSV path is not a file.');
    }

    if (
      !force &&
      CACHE.file === CSV_FILE &&
      CACHE.mtimeMs === stat.mtimeMs &&
      CACHE.size === stat.size &&
      CACHE.rows.length
    ) {
      return CACHE;
    }

    const parsed = parseSourceCsv(fs.readFileSync(CSV_FILE, 'utf8'));

    Object.assign(CACHE, {
      file: CSV_FILE,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      loadedAt: new Date().toISOString(),
      rows: parsed.rows,
      quality: {
        fileBytes: stat.size,
        ...parsed.quality
      },
      error: null
    });
  } catch (err) {
    Object.assign(CACHE, {
      error: `Required large CSV unavailable: data/${CSV_NAME}. ${err.message}`,
      rows: [],
      quality: null,
      file: null
    });
  }

  return CACHE;
}

function mean(values) {
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : null;
}

function median(values) {
  if (!values.length) return null;

  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);

  return s.length % 2
    ? s[m]
    : (s[m - 1] + s[m]) / 2;
}

function rateAtLeast(rows, target = TARGET_MULTIPLIER) {
  return rows.length
    ? rows.filter(r => r.multiplier >= target).length / rows.length * 100
    : null;
}

function currentStreak(rows, predicate) {
  let n = 0;

  for (
    let i = rows.length - 1;
    i >= 0 && predicate(rows[i]);
    i--
  ) {
    n++;
  }

  return n;
}

// Historical position scoring uses only observations before the position being tested.
function scoreAt(rows, endIndex) {
  const history = rows.slice(0, endIndex);

  if (history.length < MIN_HISTORY) {
    return { score: null, features: null };
  }

  const w6 = history.slice(-6);
  const w12 = history.slice(-12);
  const w24 = history.slice(-24);

  const r6 = rateAtLeast(w6);
  const r12 = rateAtLeast(w12);
  const r24 = rateAtLeast(w24);

  const latest = history[history.length - 1];
  const lowStreak = currentStreak(
    history,
    r => r.multiplier < 1.5
  );

  let score =
    50 +
    (r6 - 50) * 0.40 +
    (r12 - 50) * 0.30 +
    (r24 - 50) * 0.20;

  if (lowStreak >= 3) {
    score -= Math.min(8, (lowStreak - 2) * 2);
  }

  if (latest.multiplier >= 10) {
    score -= 2;
  }

  if (latest.multiplier < 1.2) {
    score += 1;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score,
    features: {
      sampleCount: history.length,
      rate2x6: r6,
      rate2x12: r12,
      rate2x24: r24,
      lowCurrentStreak: lowStreak,
      recentMean: mean(w6.map(r => r.multiplier)),
      latestMultiplier: latest.multiplier
    }
  };
}

function createEvaluations(rows) {
  const out = [];

  for (let i = MIN_HISTORY; i < rows.length; i++) {
    const result = scoreAt(rows, i);

    if (result.score !== null) {
      out.push({
        position: i,
        referenceRoundId: rows[i - 1].roundId,
        roundId: rows[i].roundId,
        score: result.score,
        actualNext: rows[i].multiplier
      });
    }
  }

  return out;
}

function evaluateThreshold(evaluations, threshold) {
  const selected = evaluations.filter(
    e => e.score !== null && e.score >= threshold
  );

  const hits = selected.filter(
    e => e.actualNext >= TARGET_MULTIPLIER
  ).length;

  const misses = selected.length - hits;
  const hitRate = selected.length
    ? hits / selected.length * 100
    : null;

  const baseline = rateAtLeast(
    evaluations.map(e => ({ multiplier: e.actualNext })),
    TARGET_MULTIPLIER
  );

  return {
    threshold,
    samples: selected.length,
    hits,
    misses,
    hitRate,
    baselineHitRate: baseline,
    liftPercentagePoints:
      hitRate === null || baseline === null
        ? null
        : hitRate - baseline,
    coverage: evaluations.length
      ? selected.length / evaluations.length * 100
      : 0,
    meetsMinimumSamples: selected.length >= BACKTEST_MIN_SAMPLES,
    aboveBaseline:
      hitRate !== null &&
      baseline !== null &&
      hitRate > baseline,
    diagnosticOnly: true
  };
}

function backtest(rows) {
  const evaluations = createEvaluations(rows);
  const split = Math.floor(evaluations.length * 0.7);

  const development = evaluations.slice(0, split);
  const holdout = evaluations.slice(split);

  const diagnostics = DIAGNOSTIC_THRESHOLDS.map(threshold => ({
    threshold,
    development: evaluateThreshold(development, threshold),
    holdout: evaluateThreshold(holdout, threshold),
    overall: evaluateThreshold(evaluations, threshold)
  }));

  const productionHoldout = evaluateThreshold(
    holdout,
    SIGNAL_THRESHOLD
  );

  const watchHoldout = evaluateThreshold(
    holdout,
    WATCH_THRESHOLD
  );

  const scores = evaluations.map(e => e.score);

  return {
    targetMultiplier: TARGET_MULTIPLIER,
    totalEvaluatedPositions: evaluations.length,
    developmentPositions: development.length,
    holdoutPositions: holdout.length,
    split: 'Chronological 70% development / 30% holdout',
    productionThreshold: SIGNAL_THRESHOLD,
    watchThreshold: WATCH_THRESHOLD,
    productionHoldout,
    watchHoldout,
    diagnostics,
    scoreDiagnostics: {
      min: scores.length ? Math.min(...scores) : null,
      max: scores.length ? Math.max(...scores) : null,
      average: mean(scores),
      countAtLeast72: scores.filter(s => s >= 72).length
    },
    note: 'Walk-forward historical diagnostics only. Holdout results are descriptive, not proof of future performance. No guarantee of the next multiplier.'
  };
}

function analyze(rows) {
  if (!rows.length) {
    return {
      ok: false,
      version: VERSION,
      error: CACHE.error || 'No valid CSV rounds loaded.'
    };
  }

  const values = rows.map(r => r.multiplier);
  const latest = rows[rows.length - 1];
  const previous = rows[rows.length - 2] || null;

  const scored = scoreAt(rows, rows.length);
  const bt = backtest(rows);
  const prod = bt.productionHoldout;

  const enoughHistory = rows.length >= MIN_HISTORY;
  const q = CACHE.quality;

  const dataQualityPass = Boolean(
    q &&
    q.sourceFile === CSV_NAME &&
    q.validRounds >= MIN_EXPECTED_SOURCE_ROWS &&
    q.invalidRows === 0 &&
    q.duplicateRoundIds === 0
  );

  const samplePass = prod.meetsMinimumSamples;
  const baselinePass = prod.aboveBaseline;

  const sharedEvidencePass =
    enoughHistory &&
    dataQualityPass &&
    samplePass &&
    baselinePass;

  let action = 'NO SIGNAL';
  const reasons = [];

  if (!enoughHistory) {
    reasons.push(
      `At least ${MIN_HISTORY} historical rounds are required.`
    );
  }

  if (!dataQualityPass) {
    reasons.push(
      'CSV quality gate failed. Signals are blocked until the required source passes validation.'
    );
  }

  if (!samplePass) {
    reasons.push(
      `Production-threshold holdout has ${prod.samples} samples; at least ${BACKTEST_MIN_SAMPLES} are required.`
    );
  }

  if (!baselinePass) {
    reasons.push(
      'The production-threshold holdout hit rate does not exceed its historical baseline.'
    );
  }

  if (
    sharedEvidencePass &&
    scored.score !== null &&
    scored.score >= SIGNAL_THRESHOLD
  ) {
    action = 'SIGNAL';
    reasons.push(
      'Configured evidence gates passed. This remains a historical research signal, not a guarantee.'
    );
  } else if (
    sharedEvidencePass &&
    scored.score !== null &&
    scored.score >= WATCH_THRESHOLD
  ) {
    action = 'WATCH';
    reasons.push(
      'Evidence gates passed, but the current score is below the signal threshold. WATCH is monitoring-only, not a betting instruction.'
    );
  } else {
    if (scored.score !== null && scored.score < WATCH_THRESHOLD) {
      reasons.push(
        'Current evidence score is below the watch threshold.'
      );
    }

    reasons.push(
      'One or more required evidence gates failed; issuing NO SIGNAL.'
    );
  }

  const evidenceStatus =
    sharedEvidencePass &&
    scored.score !== null &&
    scored.score >= SIGNAL_THRESHOLD
      ? 'QUALIFIED EVIDENCE'
      : sharedEvidencePass &&
        scored.score !== null &&
        scored.score >= WATCH_THRESHOLD
        ? 'MODERATE EVIDENCE'
        : 'LOW / INSUFFICIENT EVIDENCE';

  // Always return a research target when analysis succeeds.
  // This is not a claim that the next round will reach the target.
  const nextRoundSignal = {
    action: 'RESEARCH TARGET',
    targetMultiplier: TARGET_MULTIPLIER,
    evidenceStatus,
    evidenceScore: scored.score,
    referenceRoundId: latest.roundId,
    referenceMultiplier: latest.multiplier,
    generatedAt: new Date().toISOString(),
    note: 'This is a target for research on the next round, not a claim that the next round will reach this multiplier.'
  };

  return {
    ok: true,
    version: VERSION,
    source: CSV_NAME,
    sourcePath: `data/${CSV_NAME}`,
    loadedAt: CACHE.loadedAt,
    generatedAt: new Date().toISOString(),
    rounds: rows.length,

    latestRound: {
      roundId: latest.roundId,
      time: latest.time,
      multiplier: latest.multiplier
    },

    previousRound: previous
      ? {
          roundId: previous.roundId,
          multiplier: previous.multiplier
        }
      : null,

    nextRoundSignal,

    signal: {
      action,
      score: scored.score,
      targetMultiplier: TARGET_MULTIPLIER,
      confidence: null,
      confidenceLabel: 'Evidence score, not win probability',
      reasons
    },

    distribution: {
      samples: values.length,
      mean: mean(values),
      median: median(values),
      min: Math.min(...values),
      max: Math.max(...values),
      atLeast2: rateAtLeast(rows, 2),
      atLeast3: rateAtLeast(rows, 3),
      atLeast5: rateAtLeast(rows, 5),
      atLeast10: rateAtLeast(rows, 10),
      below1_2: values.filter(v => v < 1.2).length / values.length * 100,
      below1_5: values.filter(v => v < 1.5).length / values.length * 100
    },

    windows: [6, 12, 24].map(size => {
      const w = rows.slice(-size);

      return {
        window: size,
        samples: w.length,
        mean: mean(w.map(r => r.multiplier)),
        atLeast2: rateAtLeast(w, 2),
        atLeast3: rateAtLeast(w, 3)
      };
    }),

    evidenceGates: [
      {
        name: 'Minimum history',
        passed: enoughHistory,
        detail: `${rows.length} rounds; minimum ${MIN_HISTORY}`
      },
      {
        name: 'Holdout backtest sample count',
        passed: samplePass,
        detail: `${prod.samples} selected holdout signals; minimum ${BACKTEST_MIN_SAMPLES}`
      },
      {
        name: 'Holdout above baseline',
        passed: baselinePass,
        detail: `${prod.hitRate === null ? 'n/a' : prod.hitRate.toFixed(2) + '%'} hit rate vs ${prod.baselineHitRate === null ? 'n/a' : prod.baselineHitRate.toFixed(2) + '%'} baseline`
      },
      {
        name: 'Large CSV data quality',
        passed: dataQualityPass,
        detail: q
          ? `${q.validRounds} valid rounds; ${q.invalidRows} invalid rows; ${q.duplicateRoundIds} duplicate IDs`
          : 'Required CSV unavailable'
      }
    ],

    dataQuality: q,

    backtestSummary: {
      evaluated: bt.totalEvaluatedPositions,
      holdout: bt.holdoutPositions,
      productionHoldout: bt.productionHoldout,
      watchHoldout: bt.watchHoldout
    },

    features: scored.features,

    disclaimer: 'Historical evidence and walk-forward analysis only. No guaranteed next multiplier. Aviator outcomes may be random. Use for research only.'
  };
}

function apiError(res, data) {
  return res.status(503).json({
    ok: false,
    version: VERSION,
    source: CSV_NAME,
    sourcePath: `data/${CSV_NAME}`,
    error: data.error || 'Required large CSV could not be loaded.'
  });
}

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    name: 'AVIATOR AI PREDICTOR',
    version: VERSION,
    csvSource: `data/${CSV_NAME}`,
    message: 'Historical research API. Use /api/status, /api/analyze, /api/backtest or /api/history.'
  });
});

app.get('/api/status', (_req, res) => {
  const d = loadData();

  res.status(d.error ? 503 : 200).json({
    ok: !d.error,
    name: 'AVIATOR AI PREDICTOR',
    version: VERSION,
    source: CSV_NAME,
    sourcePath: `data/${CSV_NAME}`,
    loadedAt: d.loadedAt,
    rounds: d.rows.length,
    dataQuality: d.quality,
    error: d.error,
    generatedAt: new Date().toISOString()
  });
});

app.get('/api/analyze', (_req, res) => {
  const d = loadData();

  if (d.error) return apiError(res, d);

  return res.json(analyze(d.rows));
});

app.get('/api/backtest', (_req, res) => {
  const d = loadData();

  if (d.error) return apiError(res, d);

  return res.json({
    ok: true,
    version: VERSION,
    source: CSV_NAME,
    sourcePath: `data/${CSV_NAME}`,
    rounds: d.rows.length,
    ...backtest(d.rows)
  });
});

app.get('/api/history', (req, res) => {
  const d = loadData();

  if (d.error) return apiError(res, d);

  const requested = Number.parseInt(req.query.limit, 10) || 100;
  const limit = Math.max(
    1,
    Math.min(MAX_HISTORY_RESPONSE, requested)
  );

  const rows = d.rows.slice(-limit).map(r => ({
    roundId: r.roundId,
    time: r.time,
    multiplier: r.multiplier
  }));

  return res.json({
    ok: true,
    version: VERSION,
    source: CSV_NAME,
    sourcePath: `data/${CSV_NAME}`,
    total: d.rows.length,
    returned: rows.length,
    rows
  });
});

app.post('/api/reload', (_req, res) => {
  const d = loadData(true);

  return res.status(d.error ? 503 : 200).json({
    ok: !d.error,
    version: VERSION,
    source: CSV_NAME,
    sourcePath: `data/${CSV_NAME}`,
    rounds: d.rows.length,
    error: d.error,
    loadedAt: d.loadedAt
  });
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled request error:', err);

  return res.status(500).json({
    ok: false,
    version: VERSION,
    error: 'Internal server error.'
  });
});

app.listen(PORT, () => {
  console.log(`AVIATOR AI PREDICTOR ${VERSION} listening on port ${PORT}`);
  console.log(`Required CSV: ${CSV_FILE}`);
  console.log('CSV fallback is disabled.');
});
