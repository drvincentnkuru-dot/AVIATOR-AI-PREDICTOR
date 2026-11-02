'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: false }));
app.use(express.json({ limit: '32kb' }));
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

const VERSION = 'V1.3.0';
const PORT = Number(process.env.PORT || 10000);
const ROOT_DIR = path.resolve(__dirname, '..');
const CSV_NAME = 'aviator-2026-10 (1).csv';
const CSV_PATH = path.join(ROOT_DIR, 'data', CSV_NAME);
const SOURCE_PATH = `data/${CSV_NAME}`;
const TARGET_MULTIPLIER = 2;
const MIN_EXPECTED_SOURCE_ROWS = 1000;
const MIN_HISTORY = 100;
const MIN_MATCHES = 30;
const MIN_SIGNAL_MATCHES = 50;
const MIN_VALIDATION_SAMPLES = 50;
const MIN_SIGNAL_LIFT_PP = 5;
const MIN_WATCH_LIFT_PP = 2;
const PRIOR_WEIGHT = 20;
const MAX_DATA_AGE_HOURS = Math.max(1, Number(process.env.MAX_DATA_AGE_HOURS || 24));
const MAX_HISTORY_RESPONSE = 500;
const CONTEXT_LENGTHS = [3, 2, 1];
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT = 120;
const requestCounts = new Map();

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

function parseCsv(sourceText) {
  const source = String(sourceText).replace(/^\uFEFF/, '');
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
      if (record.some(cell => String(cell).trim() !== '')) records.push(record);
      record = [];
    } else {
      field += ch;
    }
  }

  if (quoted) throw new Error('CSV contains an unclosed quoted field.');
  record.push(field);
  if (record.some(cell => String(cell).trim() !== '')) records.push(record);
  if (records.length < 2) throw new Error('The required CSV has no data rows.');
  return records;
}

function parseMultiplier(raw) {
  const normalized = String(raw ?? '').trim().replace(/[xX]$/, '').replace(/\s/g, '').replace(',', '.');
  if (!normalized) return null;
  const value = Number(normalized);
  return Number.isFinite(value) && value >= 1 && value <= 1000000
    ? Math.round(value * 10000) / 10000
    : null;
}

function compareRoundIds(a, b) {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function parseSourceCsv(text) {
  const records = parseCsv(text);
  const headers = records[0].map(normalizeHeader);
  const find = aliases => headers.findIndex(header => aliases.includes(header));
  const multiplierIndex = find(['crash_multiplier', 'multiplier', 'crash', 'crashpoint', 'crash_point', 'value', 'coefficient', 'result', 'x', 'outcome']);
  const roundIdIndex = find(['round_id', 'round', 'roundid', 'game_id', 'id', 'round_number']);
  const timeIndex = find(['time_utc', 'timestamp', 'time', 'date', 'datetime', 'created_at', 'createdat']);

  if (multiplierIndex < 0) throw new Error('The required CSV has no recognized multiplier column.');
  if (roundIdIndex < 0) throw new Error('The required CSV has no recognized round ID column.');

  const rows = [];
  let invalidRows = 0;
  let missingTimestamps = 0;
  let missingRoundIds = 0;

  for (let i = 1; i < records.length; i++) {
    const cells = records[i];
    const multiplier = parseMultiplier(cells[multiplierIndex]);
    const roundId = String(cells[roundIdIndex] ?? '').trim();
    if (multiplier === null || !roundId) {
      invalidRows++;
      if (!roundId) missingRoundIds++;
      continue;
    }
    if (!/^\d+$/.test(roundId)) throw new Error('The required CSV contains non-numeric round IDs; refusing to guess order.');

    const rawTime = timeIndex >= 0 ? String(cells[timeIndex] ?? '').trim() : '';
    const timeMs = rawTime ? Date.parse(rawTime) : NaN;
    if (!Number.isFinite(timeMs)) missingTimestamps++;
    rows.push({ roundId, time: rawTime || null, timeMs: Number.isFinite(timeMs) ? timeMs : null, multiplier, sourceLine: i + 1 });
  }

  if (rows.length < MIN_EXPECTED_SOURCE_ROWS) {
    throw new Error(`Wrong or incomplete CSV selected: only ${rows.length} valid rounds parsed; at least ${MIN_EXPECTED_SOURCE_ROWS} are required.`);
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
  if (missingTimestamps) warnings.push(`${missingTimestamps} valid round(s) have missing or unparseable timestamps.`);
  if (missingRoundIds) warnings.push(`${missingRoundIds} row(s) with missing round IDs were rejected.`);
  if (invalidRows) warnings.push(`${invalidRows} source row(s) were rejected due to invalid data.`);
  if (duplicateRoundIds) warnings.push(`${duplicateRoundIds} duplicate round ID(s) were removed.`);

  const latest = unique[unique.length - 1] || null;
  const now = Date.now();
  const ageMs = latest && latest.timeMs !== null ? now - latest.timeMs : null;
  const ageHours = ageMs === null ? null : ageMs / 3600000;
  const timestampFuture = ageMs !== null && ageMs < -5 * 60 * 1000;
  const fresh = ageHours !== null && ageHours >= 0 && ageHours <= MAX_DATA_AGE_HOURS && !timestampFuture;
  if (ageHours === null) warnings.push('Latest round timestamp is unavailable; data freshness cannot be verified.');
  else if (timestampFuture) warnings.push('Latest round timestamp is in the future; check the CSV clock or timestamp format.');
  else if (ageHours > MAX_DATA_AGE_HOURS) warnings.push(`Latest round is ${ageHours.toFixed(1)} hours old; maximum permitted age is ${MAX_DATA_AGE_HOURS} hours.`);

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
      lastRound: latest?.roundId ?? null,
      latestRoundTime: latest?.time ?? null,
      latestRoundTimeMs: latest?.timeMs ?? null,
      sourceAgeHours: ageHours,
      maxDataAgeHours: MAX_DATA_AGE_HOURS,
      dataFresh: fresh,
      warnings
    }
  };
}

function loadData(force = false) {
  try {
    const stat = fs.statSync(CSV_PATH);
    if (!stat.isFile()) throw new Error('The required CSV path is not a file.');
    if (!force && CACHE.file === CSV_PATH && CACHE.mtimeMs === stat.mtimeMs && CACHE.size === stat.size && CACHE.rows.length) return CACHE;

    const parsed = parseSourceCsv(fs.readFileSync(CSV_PATH, 'utf8'));
    Object.assign(CACHE, {
      file: CSV_PATH,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      loadedAt: new Date().toISOString(),
      rows: parsed.rows,
      quality: { fileBytes: stat.size, ...parsed.quality },
      error: null
    });
  } catch (err) {
    Object.assign(CACHE, { error: `Required large CSV unavailable: ${SOURCE_PATH}. ${err.message}`, rows: [], quality: null, file: null });
  }
  return CACHE;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function rateAtLeast(rows, target = TARGET_MULTIPLIER) {
  return rows.length ? rows.filter(row => row.multiplier >= target).length / rows.length * 100 : null;
}
function wilsonInterval(hits, samples, z = 1.96) {
  if (!samples) return { lowerPercent: null, upperPercent: null };
  const p = hits / samples;
  const z2 = z * z;
  const denominator = 1 + z2 / samples;
  const center = (p + z2 / (2 * samples)) / denominator;
  const radius = z * Math.sqrt(p * (1 - p) / samples + z2 / (4 * samples * samples)) / denominator;
  return { lowerPercent: Math.max(0, (center - radius) * 100), upperPercent: Math.min(100, (center + radius) * 100) };
}
function bucket(multiplier) {
  if (multiplier < 1.5) return 'L';
  if (multiplier < 2) return 'M';
  if (multiplier < 3) return 'H';
  return 'X';
}
function contextKey(rows, endExclusive, length) {
  return rows.slice(endExclusive - length, endExclusive).map(row => bucket(row.multiplier)).join('');
}
function estimateFromMaps(rows, endIndex, maps, baseHits, baseSamples) {
  const baseline = baseSamples ? baseHits / baseSamples * 100 : null;
  for (const length of CONTEXT_LENGTHS) {
    if (endIndex < length) continue;
    const key = contextKey(rows, endIndex, length);
    const entry = maps[length].get(key);
    const samples = entry?.samples || 0;
    if (samples < MIN_MATCHES) continue;
    const hits = entry.hits;
    const empirical = hits / samples * 100;
    const probability = (hits + PRIOR_WEIGHT * (baseline / 100)) / (samples + PRIOR_WEIGHT) * 100;
    return {
      targetMultiplier: TARGET_MULTIPLIER,
      probabilityPercent: probability,
      historicalBaselinePercent: baseline,
      differenceFromBaselinePercentagePoints: probability - baseline,
      contextLength: length,
      contextPattern: key,
      matchingSamples: samples,
      matchingHits: hits,
      empiricalPercent: empirical,
      confidenceInterval95: wilsonInterval(hits, samples),
      method: 'Expanding-window matched-sequence estimate with a fixed base-rate prior',
      note: 'Historical estimate only; not a guaranteed or independently verified probability.'
    };
  }
  return {
    targetMultiplier: TARGET_MULTIPLIER,
    probabilityPercent: baseline,
    historicalBaselinePercent: baseline,
    differenceFromBaselinePercentagePoints: 0,
    contextLength: 0,
    contextPattern: null,
    matchingSamples: 0,
    matchingHits: 0,
    empiricalPercent: null,
    confidenceInterval95: { lowerPercent: null, upperPercent: null },
    method: 'Full-history base-rate fallback; no sequence-specific estimate met the minimum sample count',
    note: 'Base rate only; no sequence-specific edge was established.'
  };
}
function addTransition(maps, rows, outcomeIndex) {
  for (const length of CONTEXT_LENGTHS) {
    if (outcomeIndex < length) continue;
    const key = contextKey(rows, outcomeIndex, length);
    const entry = maps[length].get(key) || { samples: 0, hits: 0 };
    entry.samples++;
    if (rows[outcomeIndex].multiplier >= TARGET_MULTIPLIER) entry.hits++;
    maps[length].set(key, entry);
  }
}
function emptyMaps() { return { 1: new Map(), 2: new Map(), 3: new Map() }; }

// Strict chronological walk-forward: every prediction uses only outcomes
// observed before its target round. The current target is never in its own history.
function buildWalkForwardEvaluations(rows) {
  const maps = emptyMaps();
  const evaluations = [];
  let baseHits = 0;
  let baseSamples = 0;
  for (let i = 1; i < rows.length; i++) {
    if (i - 1 >= 1) addTransition(maps, rows, i - 1);
    baseSamples++;
    if (rows[i - 1].multiplier >= TARGET_MULTIPLIER) baseHits++;
    if (i < MIN_HISTORY) continue;
    const estimate = estimateFromMaps(rows, i, maps, baseHits, baseSamples);
    evaluations.push({
      position: i,
      referenceRoundId: rows[i - 1].roundId,
      targetRoundId: rows[i].roundId,
      actualHit: rows[i].multiplier >= TARGET_MULTIPLIER,
      actualMultiplier: rows[i].multiplier,
      estimatePercent: estimate.probabilityPercent,
      baselinePercent: estimate.historicalBaselinePercent,
      liftPP: estimate.differenceFromBaselinePercentagePoints,
      contextLength: estimate.contextLength,
      matchingSamples: estimate.matchingSamples
    });
  }
  return evaluations;
}
function evaluatePredictions(evaluations, mode = 'candidate') {
  const selected = mode === 'all'
    ? evaluations
    : evaluations.filter(item => item.contextLength > 0 && item.matchingSamples >= MIN_SIGNAL_MATCHES && item.estimatePercent >= item.baselinePercent + MIN_SIGNAL_LIFT_PP);
  const hits = selected.filter(item => item.actualHit).length;
  const samples = selected.length;
  const hitRate = samples ? hits / samples * 100 : null;
  const baseline = samples ? mean(selected.map(item => item.baselinePercent)) : null;
  const interval = wilsonInterval(hits, samples);
  return {
    samples,
    hits,
    misses: samples - hits,
    hitRatePercent: hitRate,
    baselinePercent: baseline,
    liftPercentagePoints: hitRate === null || baseline === null ? null : hitRate - baseline,
    coveragePercent: evaluations.length ? samples / evaluations.length * 100 : 0,
    confidenceInterval95: interval,
    meetsMinimumSamples: samples >= MIN_VALIDATION_SAMPLES,
    lowerBoundAboveBaseline: interval.lowerPercent !== null && baseline !== null && interval.lowerPercent > baseline
  };
}
function backtest(rows) {
  const evaluations = buildWalkForwardEvaluations(rows);
  const splitIndex = Math.floor(evaluations.length * 0.7);
  const development = evaluations.slice(0, splitIndex);
  const holdout = evaluations.slice(splitIndex);
  const devCandidates = evaluatePredictions(development);
  const holdoutCandidates = evaluatePredictions(holdout);
  const allCandidates = evaluatePredictions(evaluations);
  const allPredictions = evaluatePredictions(evaluations, 'all');
  return {
    targetMultiplier: TARGET_MULTIPLIER,
    totalEvaluatedPositions: evaluations.length,
    developmentPositions: development.length,
    holdoutPositions: holdout.length,
    split: 'Chronological 70% development / 30% untouched holdout',
    estimator: 'Expanding-window matched-sequence estimator; only prior rounds are used at each prediction point',
    candidateRule: `At least ${MIN_SIGNAL_MATCHES} completed matches and estimated lift >= ${MIN_SIGNAL_LIFT_PP} percentage points`,
    developmentCandidates: devCandidates,
    holdoutCandidates,
    overallCandidates: allCandidates,
    allHoldoutPredictions: evaluatePredictions(holdout, 'all'),
    allPredictions,
    validationPass: holdoutCandidates.meetsMinimumSamples && holdoutCandidates.liftPercentagePoints >= MIN_SIGNAL_LIFT_PP && holdoutCandidates.lowerBoundAboveBaseline,
    note: 'This is a chronological historical diagnostic, not proof of future performance. Overlapping sequences can be dependent; confidence intervals may be optimistic. No guaranteed next multiplier.'
  };
}
function scoreAt(rows) {
  const history = rows;
  if (history.length < 24) return { score: null, features: null };
  const windows = [6, 12, 24].map(size => history.slice(-size));
  const rates = windows.map(windowRows => rateAtLeast(windowRows));
  let lowStreak = 0;
  for (let i = history.length - 1; i >= 0 && history[i].multiplier < 1.5; i--) lowStreak++;
  const latest = history[history.length - 1];
  let score = 50 + (rates[0] - 50) * 0.4 + (rates[1] - 50) * 0.3 + (rates[2] - 50) * 0.2;
  if (lowStreak >= 3) score -= Math.min(8, (lowStreak - 2) * 2);
  if (latest.multiplier >= 10) score -= 2;
  if (latest.multiplier < 1.2) score += 1;
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, features: { rate2x6: rates[0], rate2x12: rates[1], rate2x24: rates[2], lowCurrentStreak: lowStreak, recentMean: mean(windows[0].map(row => row.multiplier)), latestMultiplier: latest.multiplier } };
}
function analyze(rows) {
  const latest = rows[rows.length - 1];
  const previous = rows[rows.length - 2] || null;
  const values = rows.map(row => row.multiplier);
  const q = CACHE.quality;
  const now = Date.now();
  const ageHours = latest.timeMs === null ? null : (now - latest.timeMs) / 3600000;
  const dataFresh = ageHours !== null && ageHours >= 0 && ageHours <= MAX_DATA_AGE_HOURS;
  const dataQualityPass = Boolean(q && q.sourceFile === CSV_NAME && q.validRounds >= MIN_EXPECTED_SOURCE_ROWS && q.invalidRows === 0 && q.duplicateRoundIds === 0);
  const probability = estimateCurrent(rows);
  const bt = backtest(rows);
  const validation = bt.holdoutCandidates;
  const currentLift = probability.differenceFromBaselinePercentagePoints;
  const currentCandidate = probability.contextLength > 0 && probability.matchingSamples >= MIN_SIGNAL_MATCHES && currentLift >= MIN_SIGNAL_LIFT_PP;
  const holdoutValidated = bt.validationPass;
  let action = 'NO SIGNAL';
  const reasons = [];

  if (!dataQualityPass) reasons.push('The required large CSV did not pass source-quality checks.');
  if (!dataFresh) reasons.push(`The latest source round is ${ageHours === null ? 'undated' : `${ageHours.toFixed(1)} hours old`}; the permitted maximum is ${MAX_DATA_AGE_HOURS} hours. Historical analysis remains visible, but no signal is allowed.`);
  if (rows.length < MIN_HISTORY) reasons.push(`At least ${MIN_HISTORY} rounds are required for analysis.`);
  if (!probability.contextLength) reasons.push('No latest sequence had at least 30 completed historical matches; only the full-history baseline is available.');
  else reasons.push(`The current estimate uses ${probability.matchingSamples} prior completed matches of the latest ${probability.contextLength}-round pattern.`);
  if (!currentCandidate) reasons.push(`The current estimate does not meet the fixed candidate rule of at least ${MIN_SIGNAL_MATCHES} matches and +${MIN_SIGNAL_LIFT_PP} percentage points over baseline.`);
  if (!holdoutValidated) reasons.push(`The untouched holdout has not validated the estimator: ${validation.samples} qualifying samples, ${validation.hitRatePercent === null ? 'no' : validation.hitRatePercent.toFixed(2) + '%'} hit rate, baseline ${validation.baselinePercent === null ? 'n/a' : validation.baselinePercent.toFixed(2) + '%'}; at least ${MIN_VALIDATION_SAMPLES} samples and a lower confidence bound above baseline are required.`);

  if (dataQualityPass && dataFresh && rows.length >= MIN_HISTORY && currentCandidate && holdoutValidated) {
    action = 'SIGNAL';
    reasons.unshift('Current sequence rule and untouched chronological holdout validation both passed. This remains historical research, not a guarantee.');
  } else if (dataQualityPass && dataFresh && rows.length >= MIN_HISTORY && probability.contextLength > 0 && probability.matchingSamples >= MIN_MATCHES && currentLift >= MIN_WATCH_LIFT_PP) {
    action = 'WATCH';
    reasons.unshift('A possible historical edge exists, but the full signal validation requirements have not passed.');
  }

  const score = scoreAt(rows);
  const latestRound = { roundId: latest.roundId, time: latest.time, timeMs: latest.timeMs, multiplier: latest.multiplier };
  return {
    ok: true,
    version: VERSION,
    source: CSV_NAME,
    sourcePath: SOURCE_PATH,
    loadedAt: CACHE.loadedAt,
    generatedAt: new Date().toISOString(),
    rounds: rows.length,
    dataFresh,
    sourceAgeHours: ageHours,
    maxDataAgeHours: MAX_DATA_AGE_HOURS,
    latestRound,
    previousRound: previous ? { roundId: previous.roundId, time: previous.time, multiplier: previous.multiplier } : null,
    nextRoundSignal: { action, targetMultiplier: TARGET_MULTIPLIER, evidenceStatus: action === 'SIGNAL' ? 'HOLDOUT-VALIDATED RESEARCH' : action === 'WATCH' ? 'POSSIBLE EDGE · NOT VALIDATED' : 'NO QUALIFIED EDGE', evidenceScore: score.score, referenceRoundId: latest.roundId, referenceMultiplier: latest.multiplier, note: 'Evidence score, not win probability. Historical estimate only; no guaranteed next multiplier.' },
    signal: { action, score: score.score, targetMultiplier: TARGET_MULTIPLIER, confidence: null, confidenceLabel: 'Evidence score, not win probability', reasons },
    probabilityEstimate: probability,
    validation: { passed: holdoutValidated, ...validation },
    distribution: {
      samples: values.length,
      mean: mean(values), median: median(values), min: Math.min(...values), max: Math.max(...values),
      atLeast2: rateAtLeast(rows, 2), atLeast3: rateAtLeast(rows, 3), atLeast5: rateAtLeast(rows, 5), atLeast10: rateAtLeast(rows, 10),
      below1_2: values.filter(value => value < 1.2).length / values.length * 100,
      below1_5: values.filter(value => value < 1.5).length / values.length * 100
    },
    windows: [6, 12, 24].map(size => { const windowRows = rows.slice(-size); return { window: size, samples: windowRows.length, mean: mean(windowRows.map(row => row.multiplier)), atLeast2: rateAtLeast(windowRows, 2), atLeast3: rateAtLeast(windowRows, 3) }; }),
    evidenceGates: [
      { name: 'Minimum historical sample', passed: rows.length >= MIN_HISTORY, detail: `${rows.length} rounds; minimum ${MIN_HISTORY}` },
      { name: 'Required large CSV quality', passed: dataQualityPass, detail: `${q?.validRounds ?? 0} valid; ${q?.invalidRows ?? 0} invalid; ${q?.duplicateRoundIds ?? 0} duplicate IDs` },
      { name: 'Latest source data freshness', passed: dataFresh, detail: ageHours === null ? 'Latest timestamp unavailable' : `${ageHours.toFixed(1)} hours old; maximum ${MAX_DATA_AGE_HOURS} hours` },
      { name: 'Current sequence candidate', passed: currentCandidate, detail: `${probability.matchingSamples} matches; lift ${currentLift.toFixed(2)} percentage points` },
      { name: 'Untouched holdout validation', passed: holdoutValidated, detail: `${validation.samples} candidates; ${validation.hitRatePercent === null ? 'n/a' : validation.hitRatePercent.toFixed(2) + '%'} hit rate; lower bound ${validation.confidenceInterval95.lowerPercent === null ? 'n/a' : validation.confidenceInterval95.lowerPercent.toFixed(2) + '%'}` }
    ],
    dataQuality: q,
    backtestSummary: { evaluated: bt.totalEvaluatedPositions, holdout: bt.holdoutPositions, holdoutCandidates: bt.holdoutCandidates },
    features: score.features,
    disclaimer: 'Evidence score, not win probability. Historical estimate and backtest only. No guaranteed next multiplier. No live game feed is connected.'
  };
}
function estimateCurrent(rows) {
  const maps = emptyMaps();
  let baseHits = 0;
  for (let i = 1; i < rows.length; i++) {
    addTransition(maps, rows, i);
    if (rows[i].multiplier >= TARGET_MULTIPLIER) baseHits++;
  }
  return estimateFromMaps(rows, rows.length, maps, baseHits, rows.length - 1);
}
function apiError(res, data) {
  return res.status(503).json({ ok: false, version: VERSION, source: CSV_NAME, sourcePath: SOURCE_PATH, error: data.error || 'Required large CSV could not be loaded.' });
}
function rateLimit(req, res, next) {
  const now = Date.now();
  if (requestCounts.size > 2000) {
    for (const [ip, entry] of requestCounts) {
      if (now - entry.startedAt >= RATE_WINDOW_MS) requestCounts.delete(ip);
    }
  }
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const current = requestCounts.get(key);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) requestCounts.set(key, { startedAt: now, count: 1 });
  else current.count++;
  const entry = requestCounts.get(key);
  if (entry.count > RATE_LIMIT) return res.status(429).json({ ok: false, version: VERSION, error: 'Too many requests. Please wait and try again.' });
  next();
}
app.use('/api', rateLimit);

app.get('/', (_req, res) => res.json({ ok: true, name: 'AVIATOR AI PREDICTOR', version: VERSION, csvSource: SOURCE_PATH, message: 'Historical research API. Use /api/status, /api/analyze, /api/backtest or /api/history.' }));
app.get('/api/status', (_req, res) => {
  const data = loadData();
  return res.status(data.error ? 503 : 200).json({ ok: !data.error, name: 'AVIATOR AI PREDICTOR', version: VERSION, source: CSV_NAME, sourcePath: SOURCE_PATH, loadedAt: data.loadedAt, rounds: data.rows.length, dataQuality: data.quality, error: data.error, generatedAt: new Date().toISOString() });
});
app.get('/api/analyze', (_req, res) => { const data = loadData(); if (data.error) return apiError(res, data); return res.json(analyze(data.rows)); });
app.get('/api/backtest', (_req, res) => { const data = loadData(); if (data.error) return apiError(res, data); return res.json({ ok: true, version: VERSION, source: CSV_NAME, sourcePath: SOURCE_PATH, rounds: data.rows.length, ...backtest(data.rows) }); });
app.get('/api/history', (req, res) => {
  const data = loadData();
  if (data.error) return apiError(res, data);
  const requested = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(MAX_HISTORY_RESPONSE, requested)) : 50;
  return res.json({ ok: true, version: VERSION, source: CSV_NAME, sourcePath: SOURCE_PATH, rounds: data.rows.length, limit, rows: data.rows.slice(-limit).map(row => ({ roundId: row.roundId, time: row.time, multiplier: row.multiplier })) });
});
app.post('/api/reload', (req, res) => {
  const token = process.env.RELOAD_TOKEN;
  if (!token) return res.status(404).json({ ok: false, version: VERSION, error: 'Manual reload is disabled. Set RELOAD_TOKEN to enable it.' });
  const supplied = req.get('x-reload-token') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (supplied !== token) return res.status(401).json({ ok: false, version: VERSION, error: 'Unauthorized reload request.' });
  const data = loadData(true);
  if (data.error) return apiError(res, data);
  return res.json({ ok: true, version: VERSION, source: CSV_NAME, sourcePath: SOURCE_PATH, rounds: data.rows.length, loadedAt: data.loadedAt, dataQuality: data.quality });
});

app.listen(PORT, () => {
  console.log(`AVIATOR AI PREDICTOR ${VERSION} listening on port ${PORT}`);
  console.log(`Required CSV: ${CSV_PATH}`);
  console.log(`Maximum source age for SIGNAL: ${MAX_DATA_AGE_HOURS} hours`);
});
