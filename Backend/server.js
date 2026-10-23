
'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Keep compatibility with the existing V1.1.5 frontend.
const VERSION = 'V1.1.5';
const PORT = Number(process.env.PORT || 10000);
const ROOT_DIR = path.resolve(__dirname, '..');

// Use the large CSV ONLY. Never fall back to the old 58-round file.
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

function parseCsvLine(line) {
  const output = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      output.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }

  if (quoted) {
    throw new Error('CSV contains an unclosed quoted field.');
  }

  output.push(cell);
  return output;
}

function parseMultiplier(raw) {
  const s = String(raw ?? '')
    .trim()
    .replace(/[xX]$/, '')
    .replace(/\s/g, '')
    .replace(',', '.');

  if (!s) return null;

  const n = Number(s);

  return Number.isFinite(n) && n >= 1 && n <= 1000000
    ? Math.round(n * 10000) / 10000
    : null;
}

function parseCsv(csvText) {
  const lines = String(csvText)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter(line => line.trim());

  if (lines.length < 2) {
    throw new Error('The required CSV has no data rows.');
  }

  const headers = parseCsvLine(lines[0]).map(normalizeHeader);
  const find = aliases => headers.findIndex(h => aliases.includes(h));

  const multiplierIndex = find([
    'crash_multiplier', 'multiplier', 'crash', 'crashpoint',
    'crash_point', 'value', 'coefficient', 'result', 'x', 'outcome'
  ]);

  const roundIdIndex = find([
    'round_id', 'round', 'roundid', 'game_id', 'id', 'round_number'
  ]);

  const timeIndex = find([
    'time_utc', 'timestamp', 'time', 'date',
    'datetime', 'created_at', 'createdat'
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

  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const multiplier = parseMultiplier(cells[multiplierIndex]);

    if (multiplier === null) {
      invalidRows++;
      continue;
    }

    const roundId = String(cells[roundIdIndex] ?? '').trim();
    const rawTime = timeIndex >= 0
      ? String(cells[timeIndex] ?? '').trim()
      : '';

    if (!roundId) {
      missingRoundIds++;
      invalidRows++;
      continue;
    }

    const parsedTime = rawTime ? Date.parse(rawTime) : NaN;

    if (!Number.isFinite(parsedTime)) {
      missingTimestamps++;
    }

    rows.push({
      roundId,
      time: rawTime || null,
      timeMs: Number.isFinite(parsedTime) ? parsedTime : null,
      multiplier,
      sourceLine: i + 1
    });
  }

  if (rows.length < MIN_EXPECTED_SOURCE_ROWS) {
    throw new Error(
      `Wrong or incomplete CSV selected: only ${rows.length} valid rounds ` +
      `were parsed from ${CSV_NAME}. Expected at least ${MIN_EXPECTED_SOURCE_ROWS}.`
    );
  }

  if (!rows.every(row => /^\d+$/.test(row.roundId))) {
    throw new Error(
      'The required CSV contains non-numeric round IDs; refusing to guess order.'
    );
  }

  // Sort by numeric round ID, then remove duplicate IDs.
  rows.sort((a, b) => Number(a.roundId) - Number(b.roundId));

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
    warnings.push(`${missingRoundIds} row(s) with missing round IDs were rejected.`);
  }

  if (invalidRows) {
    warnings.push(`${invalidRows} source row(s) were rejected due to invalid data.`);
  }

  if (duplicateRoundIds) {
    warnings.push(`${duplicateRoundIds} duplicate round ID(s) were removed.`);
  }

  return {
    rows: unique,
    quality: {
      sourceFile: CSV_NAME,
      sourceDataRows: lines.length - 1,
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

    const parsed = parseCsv(fs.readFileSync(CSV_FILE, 'utf8'));

    Object.assign(CACHE, {
      file: CSV_FILE,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      loadedAt: new Date().toISOString(),
      rows: parsed.rows,
      quality: { fileBytes: stat.size, ...parsed.quality },
      error: null
    });
  } catch (error) {
    Object.assign(CACHE, {
      error: `Required large CSV unavailable: data/${CSV_NAME}. ${error.message}`,
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

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function rateAtLeast(rows, target = TARGET_MULTIPLIER) {
  return rows.length
    ? rows.filter(row => row.multiplier >= target).length / rows.length * 100
    : null;
}

function currentStreak(rows, predicate) {
  let count = 0;

  for (
    let i = rows.length - 1;
    i >= 0 && predicate(rows[i]);
    i--
  ) {
    count++;
  }

  return count;
}

// Score each historical position using only rounds before that position.
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
    row => row.multiplier < 1.5
  );

  let score =
    50 +
    (r6 - 50) * 0.40 +
    (r12 - 50) * 0.30 +
    (r24 - 50) * 0.20;

  if (lowStreak >= 3) {
    score -= Math.min(8, (lowStreak - 2) * 2);
  }

  if (latest.multiplier >= 10) score -= 2;
  if (latest.multiplier < 1.2) score += 1;

  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score,
    features: {
      sampleCount: history.length,
      rate2x6: r6,
      rate2x12: r12,
      rate2x24: r24,
      lowCurrentStreak: lowStreak,
      recentMean: mean(w6.map(row => row.multiplier)),
      latestMultiplier: latest.multiplier
    }
  };
}

function createEvaluations(rows) {
  const output = [];

  for (let i = MIN_HISTORY; i < rows.length; i++) {
    const result = scoreAt(rows, i);

    if (result.score !== null) {
      output.push({
        position: i,
        referenceRoundId: rows[i - 1].roundId,
        roundId: rows[i].roundId,
        score: result.score,
        actualNext: rows[i].multiplier
      });
    }
  }

  return output;
}

function evaluateThreshold(evaluations, threshold) {
  const selected = evaluations.filter(
    item => item.score !== null && item.score >= threshold
  );

  const hits = selected.filter(
    item => item.actualNext >= TARGET_MULTIPLIER
  ).length;

  const misses = selected.length - hits;
  const hitRate = selected.length ? hits / selected.length * 100 : null;

  const baseline = rateAtLeast(
    evaluations.map(item => ({ multiplier: item.actualNext })),
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
      hitRate === null || baseline === null ? null : hitRate - baseline,
    coverage: evaluations.length
      ? selected.length / evaluations.length * 100
      : 0,
    meetsMinimumSamples: selected.length >= BACKTEST_MIN_SAMPLES,
    aboveBaseline: hitRate !== null && baseline !== null && hitRate > baseline,
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

  const productionHoldout = evaluateThreshold(holdout, SIGNAL_THRESHOLD);
  const watchHoldout = evaluateThreshold(holdout, WATCH_THRESHOLD);
  const scores = evaluations.map(item => item.score);

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
      countAtLeast72: scores.filter(score => score >= 72).length
    },
    note:
      'Walk-forward historical diagnostics only. Holdout results are descriptive, ' +
      'not proof of future performance. No guarantee of the next multiplier.'
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

  const values = rows.map(row => row.multiplier);
  const latest = rows[rows.length - 1];
  const previous = rows[rows.length - 2] || null;

  const result = scoreAt(rows, rows.length);
  const bt = backtest(rows);
  const production = bt.productionHoldout;

  const enoughHistory = rows.length >= MIN_HISTORY;

  const dataQualityPass =
    !!CACHE.quality &&
    CACHE.quality.invalidRows === 0 &&
    CACHE.quality.duplicateRoundIds === 0 &&
    CACHE.quality.validRounds >= MIN_EXPECTED_SOURCE_ROWS;

  const samplePass = production.meetsMinimumSamples;
  const baselinePass = production.aboveBaseline;
  const evidencePass = samplePass && baselinePass && dataQualityPass;

  let action = 'NO SIGNAL';
  const reasons = [];

  if (!enoughHistory) {
    reasons.push(`At least ${MIN_HISTORY} historical rounds are required.`);
  }

  if (enoughHistory && result.score < WATCH_THRESHOLD) {
    reasons.push(
      'Current evidence score is below the watch threshold; this is not a positive betting signal.'
    );
  }

  if (!samplePass) {
    reasons.push(
      'Holdout does not contain the required minimum number of selected backtest samples.'
    );
  }

  if (!baselinePass) {
    reasons.push(
      'The selected holdout hit rate does not exceed its historical baseline.'
    );
  }

  if (!dataQualityPass) {
    reasons.push(
      'The CSV quality gate failed. A signal is blocked until the source data passes validation.'
    );
  }

  if (
    enoughHistory &&
    evidencePass &&
    result.score !== null &&
    result.score >= SIGNAL_THRESHOLD
  ) {
    action = 'SIGNAL';
    reasons.push(
      'Configured evidence gates passed; this is still not a prediction guarantee.'
    );
  } else if (
    enoughHistory &&
    evidencePass &&
    result.score !== null &&
    result.score >= WATCH_THRESHOLD
  ) {
    action = 'WATCH';
    reasons.push(
      'Evidence qualifies for watch-only status, not a guaranteed outcome.'
    );
  } else if (enoughHistory && dataQualityPass) {
    // WATCH here means review/monitor only, never a confirmed betting signal.
    action = 'WATCH';
    reasons.push(
      'Analysis completed: WATCH is a review status only because one or more evidence gates did not pass. Do not treat this as a confirmed betting signal.'
    );
  }

  if (action === 'NO SIGNAL' && reasons.length === 0) {
    reasons.push('Current evidence is insufficient; no signal is issued.');
  }

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

    signal: {
      action,
      score: result.score,
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
      below1_2: values.filter(value => value < 1.2).length / values.length * 100,
      below1_5: values.filter(value => value < 1.5).length / values.length * 100
    },

    windows: [6, 12, 24].map(size => {
      const window = rows.slice(-size);

      return {
        window: size,
        samples: window.length,
        mean: mean(window.map(row => row.multiplier)),
        atLeast2: rateAtLeast(window, 2),
        atLeast3: rateAtLeast(window, 3)
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
        detail:
          `${production.samples} selected holdout signals; minimum ${BACKTEST_MIN_SAMPLES}`
      },
      {
        name: 'Holdout above baseline',
        passed: baselinePass,
        detail:
          `${production.hitRate === null ? 'n/a' : production.hitRate.toFixed(2) + '%'} hit rate vs ` +
          `${production.baselineHitRate === null ? 'n/a' : production.baselineHitRate.toFixed(2) + '%'} baseline`
      },
      {
        name: 'Large CSV data quality',
        passed: dataQualityPass,
        detail: CACHE.quality
          ? `${CACHE.quality.validRounds} valid rounds; ${CACHE.quality.invalidRows} invalid rows; ${CACHE.quality.duplicateRoundIds} duplicate IDs`
          : 'Required CSV unavailable'
      }
    ],

    dataQuality: CACHE.quality,

    backtestSummary: {
      evaluated: bt.totalEvaluatedPositions,
      holdout: bt.holdoutPositions,
      productionHoldout: bt.productionHoldout,
      watchHoldout: bt.watchHoldout
    },

    features: result.features,

    disclaimer:
      'Historical evidence and walk-forward analysis only. No guaranteed next multiplier. Aviator outcomes may be random. Use for research only.'
  };
}

function apiError(res, data) {
  return res.status(503).json({
    ok: false,
    version: VERSION,
    source: CSV_NAME,
    error: data.error || 'Required large CSV could not be loaded.'
  });
}

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    name: 'AVIATOR AI PREDICTOR',
    version: VERSION,
    csvSource: `data/${CSV_NAME}`,
    message:
      'Historical research API. Use /api/status, /api/analyze, /api/backtest or /api/history.'
  });
});

app.get('/api/status', (_req, res) => {
  const data = loadData();

  res.status(data.error ? 503 : 200).json({
    ok: !data.error,
    name: 'AVIATOR AI PREDICTOR',
    version: VERSION,
    source: CSV_NAME,
    sourcePath: `data/${CSV_NAME}`,
    loadedAt: data.loadedAt,
    rounds: data.rows.length,
    dataQuality: data.quality,
    error: data.error,
    generatedAt: new Date().toISOString()
  });
});

app.get('/api/analyze', (_req, res) => {
  const data = loadData();

  if (data.error) return apiError(res, data);

  res.json(analyze(data.rows));
});

app.get('/api/backtest', (_req, res) => {
  const data = loadData();

  if (data.error) return apiError(res, data);

  res.json({
    ok: true,
    version: VERSION,
    source: CSV_NAME,
    sourcePath: `data/${CSV_NAME}`,
    rounds: data.rows.length,
    ...backtest(data.rows)
  });
});

app.get('/api/history', (req, res) => {
  const data = loadData();

  if (data.error) return apiError(res, data);

  const requestedLimit = Number.parseInt(req.query.limit, 10) || 100;
  const limit = Math.max(
    1,
    Math.min(MAX_HISTORY_RESPONSE, requestedLimit)
  );

  const rows = data.rows.slice(-limit).map(row => ({
    roundId: row.roundId,
    time: row.time,
    multiplier: row.multiplier
  }));

  res.json({
    ok: true,
    version: VERSION,
    source: CSV_NAME,
    sourcePath: `data/${CSV_NAME}`,
    total: data.rows.length,
    returned: rows.length,
    rows
  });
});

app.post('/api/reload', (_req, res) => {
  const data = loadData(true);

  res.status(data.error ? 503 : 200).json({
    ok: !data.error,
    version: VERSION,
    source: CSV_NAME,
    sourcePath: `data/${CSV_NAME}`,
    rounds: data.rows.length,
    error: data.error,
    loadedAt: data.loadedAt
  });
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled request error:', err);
  res.status(500).json({
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
