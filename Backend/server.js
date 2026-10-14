
'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const VERSION = 'V1.1.4';
const PORT = Number(process.env.PORT || 10000);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

const REQUESTED_CSV = process.env.AVIATOR_CSV_PATH
  ? (path.isAbsolute(process.env.AVIATOR_CSV_PATH)
      ? process.env.AVIATOR_CSV_PATH
      : path.resolve(ROOT_DIR, process.env.AVIATOR_CSV_PATH))
  : null;

const TARGET_MULTIPLIER = 2;
const MIN_HISTORY = 24;
const BACKTEST_MIN_SAMPLES = 30;

// Keep production thresholds unchanged.
const SIGNAL_THRESHOLD = 72;
const WATCH_THRESHOLD = 60;
const MAX_HISTORY_RESPONSE = 10000;

// Exploratory only; never automatically select a production threshold.
const DIAGNOSTIC_THRESHOLDS = [50, 55, 60, 65, 68, 72];
const CHRONOLOGICAL_SEGMENTS = 4;

// The latest 30% of chronological evaluations is reserved
// as a holdout period. It is not used to select a threshold.
const HOLDOUT_FRACTION = 0.30;

let cache = {
  file: null,
  mtimeMs: 0,
  size: 0,
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
    .replace(/[\s\-./]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

function parseCSVText(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  const input = String(text || '').replace(/^\uFEFF/, '');

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && field.length === 0) {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));

      if (row.some((v) => String(v).trim() !== '')) {
        rows.push(row);
      }

      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ''));

    if (row.some((v) => String(v).trim() !== '')) {
      rows.push(row);
    }
  }

  if (quoted) {
    throw new Error(
      'Malformed CSV: an opening quote was not closed.'
    );
  }

  return rows;
}

const MULTIPLIER_HEADERS = [
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
];

const ROUND_HEADERS = [
  'round_id',
  'round',
  'roundid',
  'game_id',
  'id',
  'round_number'
];

const TIME_HEADERS = [
  'time_utc',
  'timestamp',
  'time',
  'date',
  'datetime',
  'created_at',
  'createdat'
];

function chooseColumn(headers, candidates) {
  for (const candidate of candidates) {
    const index = headers.indexOf(candidate);
    if (index >= 0) return index;
  }

  return -1;
}

function numericMultiplier(value) {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/x$/i, '')
    .replace(/,/g, '.');

  if (!cleaned) return NaN;

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function parseRows(text, filePath) {
  const raw = parseCSVText(text);

  if (raw.length < 2) {
    throw new Error('CSV is empty or has no data rows.');
  }

  const headers = raw[0].map(normalizeHeader);

  const multiplierIndex = chooseColumn(
    headers,
    MULTIPLIER_HEADERS
  );

  const roundIndex = chooseColumn(headers, ROUND_HEADERS);
  const timeIndex = chooseColumn(headers, TIME_HEADERS);

  if (multiplierIndex < 0) {
    throw new Error(
      `Cannot find multiplier column. Found headers: ${
        headers.join(', ') || '(none)'
      }`
    );
  }

  const parsed = [];
  let invalidRows = 0;
  let missingTimes = 0;
  let missingRoundIds = 0;

  for (let i = 1; i < raw.length; i += 1) {
    const cells = raw[i];
    const multiplier = numericMultiplier(
      cells[multiplierIndex]
    );

    if (
      !Number.isFinite(multiplier) ||
      multiplier < 1 ||
      multiplier > 1000000
    ) {
      invalidRows += 1;
      continue;
    }

    const roundId = roundIndex >= 0
      ? String(cells[roundIndex] ?? '').trim()
      : String(i);

    const timeUtc = timeIndex >= 0
      ? String(cells[timeIndex] ?? '').trim()
      : '';

    if (!roundId) missingRoundIds += 1;

    if (!timeUtc || !Number.isFinite(Date.parse(timeUtc))) {
      missingTimes += 1;
    }

    parsed.push({
      roundId: roundId || `row-${i}`,
      timeUtc: timeUtc || null,
      multiplier: Number(multiplier.toFixed(4)),
      sourceRow: i + 1,
      sourceFile: path.basename(filePath)
    });
  }

  const allNumericIds = parsed.length > 0 &&
    parsed.every((r) => /^\d+(?:\.\d+)?$/.test(r.roundId));

  if (allNumericIds) {
    parsed.sort(
      (a, b) =>
        Number(a.roundId) - Number(b.roundId) ||
        a.sourceRow - b.sourceRow
    );
  } else {
    parsed.sort((a, b) => {
      const ta = a.timeUtc ? Date.parse(a.timeUtc) : NaN;
      const tb = b.timeUtc ? Date.parse(b.timeUtc) : NaN;

      if (
        Number.isFinite(ta) &&
        Number.isFinite(tb) &&
        ta !== tb
      ) {
        return ta - tb;
      }

      if (Number.isFinite(ta) !== Number.isFinite(tb)) {
        return Number.isFinite(ta) ? -1 : 1;
      }

      return a.sourceRow - b.sourceRow;
    });
  }

  const seenIds = new Set();
  const deduped = [];
  let duplicateIds = 0;

  for (const r of parsed) {
    if (r.roundId && seenIds.has(r.roundId)) {
      duplicateIds += 1;
      continue;
    }

    if (r.roundId) seenIds.add(r.roundId);
    deduped.push(r);
  }

  if (!deduped.length) {
    throw new Error(
      'No valid multiplier rows were found in this CSV.'
    );
  }

  const quality = {
    sourceFile: path.basename(filePath),
    headerColumns: headers,
    multiplierColumn: headers[multiplierIndex],
    roundIdColumn: roundIndex >= 0
      ? headers[roundIndex]
      : null,
    timeColumn: timeIndex >= 0
      ? headers[timeIndex]
      : null,
    sourceDataRows: raw.length - 1,
    validRowsBeforeDeduplication: parsed.length,
    validRounds: deduped.length,
    invalidRows,
    duplicateRoundIds: duplicateIds,
    missingTimestamps: missingTimes,
    missingRoundIds,
    orderMethod: allNumericIds
      ? 'numeric round_id ascending'
      : 'timestamp ascending where available; source order fallback',
    firstRound: deduped[0]?.roundId ?? null,
    lastRound: deduped[deduped.length - 1]?.roundId ?? null,
    warnings: []
  };

  if (invalidRows) {
    quality.warnings.push(
      `${invalidRows} row(s) skipped because multiplier was invalid or outside 1.00x–1000000x.`
    );
  }

  if (duplicateIds) {
    quality.warnings.push(
      `${duplicateIds} duplicate round ID(s) removed.`
    );
  }

  if (missingTimes) {
    quality.warnings.push(
      `${missingTimes} row(s) have missing/unparseable timestamps.`
    );
  }

  if (roundIndex < 0) {
    quality.warnings.push(
      'No recognized round ID column; source row numbers were used as IDs.'
    );
  }

  if (timeIndex < 0 && !allNumericIds) {
    quality.warnings.push(
      'No recognized timestamp column; CSV source order is being used where needed.'
    );
  }

  return { rows: deduped, quality };
}

function candidateCSVFiles() {
  if (REQUESTED_CSV) return [REQUESTED_CSV];

  const preferred = [
    path.join(DATA_DIR, 'aviator-2026-10 (1).csv'),
    path.join(DATA_DIR, 'aviator-2026-10.csv'),
    path.join(DATA_DIR, 'aviator_rounds.csv')
  ];

  if (!fs.existsSync(DATA_DIR)) return [];

  const existingPreferred = preferred.filter((p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isFile();
    } catch (_) {
      return false;
    }
  });

  const preferredSet = new Set(
    existingPreferred.map((p) => path.resolve(p))
  );

  const remaining = fs.readdirSync(DATA_DIR)
    .filter((name) => name.toLowerCase().endsWith('.csv'))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(DATA_DIR, name))
    .filter((p) => !preferredSet.has(path.resolve(p)));

  // Prefer the full research export over the 58-round seed.
  return [...existingPreferred, ...remaining];
}

function loadData(force = false) {
  const files = candidateCSVFiles();

  if (!files.length) {
    cache = {
      file: null,
      mtimeMs: 0,
      size: 0,
      loadedAt: new Date().toISOString(),
      rows: [],
      quality: null,
      error: `No CSV file found in ${DATA_DIR}. Put the full history CSV in the repository data/ folder.`
    };

    return cache;
  }

  let lastError = null;

  for (const file of files) {
    try {
      if (!fs.existsSync(file)) {
        throw new Error(`CSV file does not exist: ${file}`);
      }

      const stat = fs.statSync(file);

      if (
        !force &&
        cache.file === file &&
        cache.mtimeMs === stat.mtimeMs &&
        cache.size === stat.size &&
        cache.rows.length
      ) {
        return cache;
      }

      const parsed = parseRows(
        fs.readFileSync(file, 'utf8'),
        file
      );

      cache = {
        file,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        loadedAt: new Date().toISOString(),
        rows: parsed.rows,
        quality: parsed.quality,
        error: null
      };

      return cache;
    } catch (err) {
      lastError = err;
    }
  }

  cache = {
    file: files[0] || null,
    mtimeMs: 0,
    size: 0,
    loadedAt: new Date().toISOString(),
    rows: [],
    quality: null,
    error: lastError
      ? lastError.message
      : 'Unable to load CSV.'
  };

  return cache;
}

function mean(values) {
  return values.length
    ? values.reduce((sum, n) => sum + n, 0) / values.length
    : null;
}

function median(values) {
  if (!values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function stddev(values) {
  if (values.length < 2) return 0;

  const average = mean(values);

  return Math.sqrt(
    mean(values.map((x) => (x - average) ** 2))
  );
}

function rate(values, predicate) {
  return values.length
    ? 100 * values.filter(predicate).length / values.length
    : null;
}

function longestStreak(values, predicate) {
  let best = 0;
  let current = 0;

  for (const value of values) {
    if (predicate(value)) {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 0;
    }
  }

  return best;
}

function roundNumber(n, digits = 2) {
  return n == null || !Number.isFinite(n)
    ? null
    : Number(n.toFixed(digits));
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);

  return {
    samples: values.length,
    mean: roundNumber(mean(values)),
    median: roundNumber(median(values)),
    min: values.length ? roundNumber(sorted[0]) : null,
    max: values.length
      ? roundNumber(sorted[sorted.length - 1])
      : null,
    stdev: roundNumber(stddev(values)),
    p75: sorted.length
      ? roundNumber(
          sorted[
            Math.min(
              sorted.length - 1,
              Math.floor(sorted.length * 0.75)
            )
          ]
        )
      : null,
    below1_2: roundNumber(rate(values, (v) => v < 1.2)),
    below1_5: roundNumber(rate(values, (v) => v < 1.5)),
    atLeast2: roundNumber(rate(values, (v) => v >= 2)),
    atLeast3: roundNumber(rate(values, (v) => v >= 3)),
    atLeast5: roundNumber(rate(values, (v) => v >= 5)),
    atLeast10: roundNumber(rate(values, (v) => v >= 10)),
    longestBelow1_2: longestStreak(values, (v) => v < 1.2),
    longestBelow1_5: longestStreak(values, (v) => v < 1.5)
  };
}

function windowSummary(rows, size) {
  const values = rows.slice(-size).map((r) => r.multiplier);

  return {
    window: size,
    ...summarize(values)
  };
}

function transitionRate(rows, condition) {
  let eligible = 0;
  let targetHits = 0;

  for (let i = 0; i < rows.length - 1; i += 1) {
    if (condition(rows[i].multiplier)) {
      eligible += 1;

      if (rows[i + 1].multiplier >= TARGET_MULTIPLIER) {
        targetHits += 1;
      }
    }
  }

  return {
    samples: eligible,
    hits: targetHits,
    hitRate: eligible
      ? roundNumber(100 * targetHits / eligible)
      : null
  };
}

// Historical evidence score only; not a probability estimate.
function scoreAt(rows, endIndex) {
  if (endIndex < MIN_HISTORY) {
    return {
      score: 0,
      reasons: ['Not enough prior rounds for scoring.'],
      features: {}
    };
  }

  const prior = rows
    .slice(0, endIndex)
    .map((r) => r.multiplier);

  const last = prior[prior.length - 1];
  const w6 = prior.slice(-6);
  const w12 = prior.slice(-12);
  const w24 = prior.slice(-24);

  const r6 = rate(w6, (v) => v >= TARGET_MULTIPLIER) ?? 0;
  const r12 = rate(w12, (v) => v >= TARGET_MULTIPLIER) ?? 0;
  const r24 = rate(w24, (v) => v >= TARGET_MULTIPLIER) ?? 0;

  const lowStreak = longestStreak(
    w6,
    (v) => v < 1.5
  );

  const recentMean = mean(w6) ?? 0;

  let score = 50;
  const reasons = [];

  score += Math.max(
    -12,
    Math.min(12, (r6 - r24) * 0.24)
  );

  score += Math.max(
    -8,
    Math.min(8, (r12 - r24) * 0.12)
  );

  if (r6 >= r24 + 15) {
    reasons.push(
      'Recent >=2x rate is above the 24-round reference window.'
    );
  } else if (r6 <= r24 - 15) {
    reasons.push(
      'Recent >=2x rate is below the 24-round reference window.'
    );
  }

  if (last >= 10) {
    score -= 8;
    reasons.push(
      'The latest multiplier was very high; a caution adjustment was applied.'
    );
  } else if (last >= 5) {
    score -= 4;
    reasons.push(
      'The latest multiplier was elevated; a caution adjustment was applied.'
    );
  }

  if (lowStreak >= 3) {
    score -= Math.min(12, lowStreak * 2);
    reasons.push(
      `A low-multiplier streak of ${lowStreak} appears in the latest six rounds.`
    );
  }

  if (recentMean > 0 && recentMean < 1.8) {
    score -= 3;
    reasons.push('The latest six-round mean is low.');
  }

  if (recentMean >= 3 && r6 >= r24) {
    score += 3;
    reasons.push(
      'Recent mean and >=2x rate are comparatively elevated.'
    );
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  if (!reasons.length) {
    reasons.push(
      'Recent windows do not show a strong difference from the reference window.'
    );
  }

  return {
    score,
    reasons,
    features: {
      lastMultiplier: last,
      rate2x6: roundNumber(r6),
      rate2x12: roundNumber(r12),
      rate2x24: roundNumber(r24),
      recentMean6: roundNumber(recentMean),
      lowStreak6: lowStreak
    }
  };
}

function evaluateThreshold(evaluations, threshold) {
  const signals = evaluations.filter(
    (item) => item.score >= threshold
  );

  const hits = signals.filter(
    (item) => item.actualNext >= TARGET_MULTIPLIER
  ).length;

  const misses = signals.length - hits;
  const total = evaluations.length;

  const baselineHits = evaluations.filter(
    (item) => item.actualNext >= TARGET_MULTIPLIER
  ).length;

  const hitRate = signals.length
    ? 100 * hits / signals.length
    : null;

  const baselineHitRate = total
    ? 100 * baselineHits / total
    : null;

  return {
    threshold,
    samples: signals.length,
    hits,
    misses,
    hitRate: roundNumber(hitRate),
    coverage: total
      ? roundNumber(100 * signals.length / total)
      : 0,
    baselineSamples: total,
    baselineHits,
    baselineHitRate: roundNumber(baselineHitRate),
    liftPercentagePoints:
      hitRate !== null && baselineHitRate !== null
        ? roundNumber(hitRate - baselineHitRate)
        : null,
    falseSignalRate: signals.length
      ? roundNumber(100 * misses / signals.length)
      : null,
    meetsMinimumSamples:
      signals.length >= BACKTEST_MIN_SAMPLES,
    aboveBaseline:
      hitRate !== null &&
      baselineHitRate !== null &&
      hitRate > baselineHitRate,
    diagnosticOnly: true
  };
}

function buildChronologicalDiagnostics(evaluations) {
  const segments = [];

  for (let s = 0; s < CHRONOLOGICAL_SEGMENTS; s += 1) {
    const start = Math.floor(
      evaluations.length * s / CHRONOLOGICAL_SEGMENTS
    );

    const end = Math.floor(
      evaluations.length * (s + 1) / CHRONOLOGICAL_SEGMENTS
    );

    const segmentEvaluations = evaluations.slice(start, end);

    segments.push({
      segment: s + 1,
      period: `chronological segment ${s + 1} of ${CHRONOLOGICAL_SEGMENTS}`,
      evaluatedPositions: segmentEvaluations.length,
      thresholds: DIAGNOSTIC_THRESHOLDS.map(
        (threshold) =>
          evaluateThreshold(segmentEvaluations, threshold)
      )
    });
  }

  return segments;
}

function createEvaluations(rows) {
  const evaluations = [];

  // Each score uses only rounds preceding the evaluated next round.
  for (let i = MIN_HISTORY; i < rows.length - 1; i += 1) {
    const model = scoreAt(rows, i);

    evaluations.push({
      score: model.score,
      actualNext: rows[i + 1].multiplier,
      roundId: rows[i].roundId,
      nextRoundId: rows[i + 1].roundId
    });
  }

  return evaluations;
}

function scoreDistribution(evaluations) {
  const counts = {
    below50: 0,
    from50to59: 0,
    from60to71: 0,
    from72to77: 0,
    from78to100: 0
  };

  let scoreSum = 0;
  let minScore = null;
  let maxScore = null;

  for (const item of evaluations) {
    const score = item.score;

    scoreSum += score;
    minScore = minScore === null
      ? score
      : Math.min(minScore, score);

    maxScore = maxScore === null
      ? score
      : Math.max(maxScore, score);

    if (score < 50) {
      counts.below50 += 1;
    } else if (score < 60) {
      counts.from50to59 += 1;
    } else if (score < 72) {
      counts.from60to71 += 1;
    } else if (score < 78) {
      counts.from72to77 += 1;
    } else {
      counts.from78to100 += 1;
    }
  }

  return {
    minScore,
    maxScore,
    averageScore: evaluations.length
      ? roundNumber(scoreSum / evaluations.length)
      : null,
    scoreCounts: counts
  };
}

function walkForward(rows) {
  const allEvaluations = createEvaluations(rows);

  // Keep the final chronological portion untouched by threshold selection.
  const splitIndex = Math.floor(
    allEvaluations.length * (1 - HOLDOUT_FRACTION)
  );

  const development = allEvaluations.slice(0, splitIndex);
  const holdout = allEvaluations.slice(splitIndex);

  // Production performance and gates are based on holdout only.
  const production = evaluateThreshold(
    holdout,
    SIGNAL_THRESHOLD
  );

  const watchDiagnostic = evaluateThreshold(
    holdout,
    WATCH_THRESHOLD
  );

  const overallProduction = evaluateThreshold(
    allEvaluations,
    SIGNAL_THRESHOLD
  );

  const baselineHits = holdout.filter(
    (item) => item.actualNext >= TARGET_MULTIPLIER
  ).length;

  const holdoutBaselineRate = holdout.length
    ? 100 * baselineHits / holdout.length
    : null;

  const productionStable =
    production.meetsMinimumSamples &&
    production.aboveBaseline;

  const watchEvidenceSufficient =
    watchDiagnostic.meetsMinimumSamples &&
    watchDiagnostic.aboveBaseline;

  return {
    target: `next round >= ${TARGET_MULTIPLIER.toFixed(2)}x`,

    method:
      'Chronological walk-forward. Each score uses only prior rounds. The latest 30% of evaluated positions is reserved as holdout.',

    evaluationDesign: {
      type: 'chronological-development-holdout',
      developmentFraction: roundNumber(
        100 * (1 - HOLDOUT_FRACTION)
      ),
      holdoutFraction: roundNumber(100 * HOLDOUT_FRACTION),
      totalEvaluatedPositions: allEvaluations.length,
      developmentPositions: development.length,
      holdoutPositions: holdout.length,
      thresholdSelection:
        'No automatic threshold selection. Production threshold remains fixed at 72.',
      limitation:
        'The holdout is historical and does not guarantee future performance.'
    },

    minHistory: MIN_HISTORY,

    // These compatibility fields now report holdout performance.
    testedPositions: holdout.length,
    samples: production.samples,
    hits: production.hits,
    misses: production.misses,
    hitRate: production.hitRate,
    coverage: production.coverage,

    baselineSamples: holdout.length,
    baselineHits,
    baselineHitRate: roundNumber(holdoutBaselineRate),

    falseSignalRate: production.falseSignalRate,
    meetsMinimumSamples: production.meetsMinimumSamples,
    aboveBaseline: production.aboveBaseline,
    stable: productionStable,

    scoreDiagnostics: {
      ...scoreDistribution(allEvaluations),
      threshold: SIGNAL_THRESHOLD,
      scope: 'all chronological evaluations'
    },

    holdout: {
      productionThreshold: production,
      watchThreshold: watchDiagnostic,
      evidenceSufficientForProduction: productionStable,
      evidenceSufficientForWatch: watchEvidenceSufficient,
      baselineHitRate: roundNumber(holdoutBaselineRate)
    },

    developmentDiagnostics: {
      evaluatedPositions: development.length,
      thresholds: DIAGNOSTIC_THRESHOLDS.map(
        (threshold) =>
          evaluateThreshold(development, threshold)
      ),
      note:
        'Development-period results are exploratory and must not be presented as holdout performance.'
    },

    overallHistoricalDiagnostics: {
      evaluatedPositions: allEvaluations.length,
      productionThreshold: overallProduction,
      thresholds: DIAGNOSTIC_THRESHOLDS.map(
        (threshold) =>
          evaluateThreshold(allEvaluations, threshold)
      ),
      chronologicalSegments:
        buildChronologicalDiagnostics(allEvaluations)
    },

    thresholdDiagnostics: {
      purpose:
        'Exploratory comparison only. Thresholds below are not automatically promoted to production.',

      productionThreshold: SIGNAL_THRESHOLD,
      watchThreshold: WATCH_THRESHOLD,
      thresholdsCompared: DIAGNOSTIC_THRESHOLDS,

      development: DIAGNOSTIC_THRESHOLDS.map(
        (threshold) =>
          evaluateThreshold(development, threshold)
      ),

      holdout: DIAGNOSTIC_THRESHOLDS.map(
        (threshold) =>
          evaluateThreshold(holdout, threshold)
      ),

      chronologicalSegments:
        buildChronologicalDiagnostics(allEvaluations),

      interpretation:
        'Review sample count, hit rate, coverage, lift versus baseline, and consistency across periods. Repeatedly testing many thresholds can produce misleading apparent improvements.'
    },

    note:
      'Historical evidence only. No guaranteed next multiplier.'
  };
}

function buildResponse(force = false) {
  const data = loadData(force);

  if (!data.rows.length) {
    return {
      ok: false,
      version: VERSION,
      error: data.error || 'No valid data loaded.',
      source: data.file ? path.basename(data.file) : null,
      generatedAt: new Date().toISOString()
    };
  }

  const rows = data.rows;
  const values = rows.map((r) => r.multiplier);
  const last = rows[rows.length - 1];

  const model = scoreAt(rows, rows.length);
  const backtest = walkForward(rows);

  const productionGatePass =
    backtest.holdout.evidenceSufficientForProduction;

  const watchGatePass =
    backtest.holdout.evidenceSufficientForWatch;

  const gates = [
    {
      name: 'Minimum history',
      pass: rows.length >= MIN_HISTORY,
      detail:
        `${rows.length} valid rounds; at least ${MIN_HISTORY} required.`
    },
    {
      name: 'Holdout sample count',
      pass: backtest.meetsMinimumSamples,
      detail:
        `${backtest.samples} holdout signals at threshold ${SIGNAL_THRESHOLD}; at least ${BACKTEST_MIN_SAMPLES} required.`
    },
    {
      name: 'Holdout above baseline',
      pass: backtest.aboveBaseline,
      detail:
        `Holdout signal hit rate ${backtest.hitRate ?? 'n/a'}% vs holdout baseline ${backtest.baselineHitRate ?? 'n/a'}%.`
    },
    {
      name: 'Data quality',
      pass:
        data.quality.validRounds >= MIN_HISTORY &&
        data.quality.duplicateRoundIds === 0,
      detail:
        `${data.quality.validRounds} valid rounds; ${data.quality.duplicateRoundIds} duplicate IDs removed.`
    }
  ];

  const allGatesPass = gates.every((gate) => gate.pass);

  let action = 'NO SIGNAL';

  if (
    allGatesPass &&
    productionGatePass &&
    model.score >= SIGNAL_THRESHOLD
  ) {
    action = 'SIGNAL';
  } else if (
    rows.length >= MIN_HISTORY &&
    watchGatePass &&
    model.score >= WATCH_THRESHOLD
  ) {
    action = 'WATCH';
  }

  const distribution = summarize(values);

  return {
    ok: true,
    version: VERSION,
    generatedAt: new Date().toISOString(),

    disclaimer:
      'Historical evidence and walk-forward analysis only. No guaranteed next multiplier.',

    source: path.basename(data.file),
    sourcePath: path.relative(ROOT_DIR, data.file),

    summary: {
      samples: rows.length,
      previous: rows.length > 1
        ? rows[rows.length - 2]
        : null,
      latest: last,
      nextRound: null
    },

    signal: {
      action,
      score: model.score,
      confidence: null,
      confidenceLabel: 'Evidence score, not win probability',
      target: `>= ${TARGET_MULTIPLIER.toFixed(2)}x`,
      reasons: [
        ...model.reasons,
        ...(action === 'NO SIGNAL'
          ? ['Evidence gates are not satisfied; no actionable signal is approved.']
          : []),
        ...(action === 'WATCH'
          ? ['WATCH is an informational research status, not a confirmed entry or guarantee.']
          : [])
      ]
    },

    dataQuality: data.quality,
    distribution,

    windows: {
      short: windowSummary(rows, 6),
      medium: windowSummary(rows, 12),
      long: windowSummary(rows, 24)
    },

    transitions: {
      afterLow: transitionRate(
        rows,
        (v) => v < 1.5
      ),
      afterVeryLow: transitionRate(
        rows,
        (v) => v < 1.2
      )
    },

    regime: {
      latest6Mean: roundNumber(mean(values.slice(-6))),
      latest12Mean: roundNumber(mean(values.slice(-12))),
      latest24Mean: roundNumber(mean(values.slice(-24)))
    },

    features: model.features,
    backtest,
    evidenceGates: gates,
    recentRounds: rows.slice(-20).reverse()
  };
}

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    name: 'AVIATOR AI PREDICTOR',
    version: VERSION,
    message:
      'Use /api/analyze, /api/history, /api/status or /api/backtest.'
  });
});

app.get('/api/status', (_req, res) => {
  const data = loadData();

  res.json({
    ok: data.rows.length > 0,
    version: VERSION,
    source: data.file ? path.basename(data.file) : null,
    sourcePath: data.file
      ? path.relative(ROOT_DIR, data.file)
      : null,
    loadedAt: data.loadedAt,
    rounds: data.rows.length,
    dataQuality: data.quality,
    error: data.error,
    csvPathOverrideSet: Boolean(REQUESTED_CSV),
    generatedAt: new Date().toISOString()
  });
});

app.get('/api/analyze', (_req, res) => {
  const result = buildResponse();
  res.status(result.ok ? 200 : 503).json(result);
});

app.get('/api/backtest', (_req, res) => {
  const result = buildResponse();

  if (!result.ok) {
    return res.status(503).json(result);
  }

  return res.json({
    ok: true,
    version: VERSION,
    generatedAt: result.generatedAt,
    source: result.source,
    backtest: result.backtest,
    evidenceGates: result.evidenceGates,
    disclaimer: result.disclaimer
  });
});

app.get('/api/history', (req, res) => {
  const data = loadData();

  if (!data.rows.length) {
    return res.status(503).json({
      ok: false,
      error: data.error
    });
  }

  const requestedLimit = Number(req.query.limit) || 100;
  const requestedOffset = Number(req.query.offset) || 0;

  const limit = Math.max(
    1,
    Math.min(
      MAX_HISTORY_RESPONSE,
      Math.floor(requestedLimit)
    )
  );

  const offset = Math.max(0, Math.floor(requestedOffset));

  const rounds = data.rows
    .slice()
    .reverse()
    .slice(offset, offset + limit);

  return res.json({
    ok: true,
    version: VERSION,
    source: path.basename(data.file),
    total: data.rows.length,
    limit,
    offset,
    rounds
  });
});

app.get('/api/reload', (_req, res) => {
  const result = buildResponse(true);
  res.status(result.ok ? 200 : 503).json(result);
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled request error:', err);

  res.status(500).json({
    ok: false,
    version: VERSION,
    error: 'Internal server error.'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `AVIATOR AI PREDICTOR ${VERSION} listening on ${PORT}`
  );
});
