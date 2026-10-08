// ============================================================
// AVIATOR AI PREDICTOR
// Backend V1.1.1
// RESEARCH ONLY
//
// Architecture:
// CSV -> VALIDATE -> FEATURES -> BACKTEST -> SCORE -> SIGNAL
//
// IMPORTANT:
// This system does NOT claim to know the next Aviator round.
// The score is an evidence index, not a probability.
// ============================================================

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const VERSION = "V1.1.1";

const CONFIG = {
  target: 2.0,

  shortWindow: 6,
  mediumWindow: 12,
  longWindow: 24,

  minHistory: 24,
  minBacktestSamples: 12,

  signalThreshold: 68,
  strongThreshold: 78,

  stableHitRate: 50,

  veryLow: 1.20,
  low: 1.50,
  high: 3.00,
  extreme: 10.00
};

const CSV_PATH =
  process.env.AVIATOR_CSV_PATH ||
  path.join(__dirname, "..", "data", "aviator_rounds.csv");

let cache = {
  rows: [],
  loadedAt: null
};

// ------------------------------------------------------------
// UTILITIES
// ------------------------------------------------------------

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mean(values) {
  if (!values.length) return null;

  return (
    values.reduce((sum, value) => sum + value, 0) /
    values.length
  );
}

function median(values) {
  if (!values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2) {
    return sorted[middle];
  }

  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;

  const m = mean(values);

  const variance =
    values.reduce((sum, value) => {
      return sum + Math.pow(value - m, 2);
    }, 0) / values.length;

  return Math.sqrt(variance);
}

function percentile(values, p) {
  if (!values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;

  const lower = Math.floor(position);
  const upper = Math.ceil(position);

  if (lower === upper) {
    return sorted[lower];
  }

  return (
    sorted[lower] +
    (sorted[upper] - sorted[lower]) *
      (position - lower)
  );
}

function percentage(values, condition) {
  if (!values.length) return 0;

  return (
    (values.filter(condition).length / values.length) *
    100
  );
}

function longestStreak(values, condition) {
  let current = 0;
  let best = 0;

  for (const value of values) {
    if (condition(value)) {
      current++;
      best = Math.max(best, current);
    } else {
      current = 0;
    }
  }

  return best;
}

// ------------------------------------------------------------
// CSV
// ------------------------------------------------------------

function parseCSV(text) {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .filter(line => line.trim() !== "");

  if (!lines.length) {
    return [];
  }

  const headers = lines[0]
    .split(",")
    .map(x => x.trim().toLowerCase());

  const multiplierAliases = [
    "multiplier",
    "crash",
    "crashpoint",
    "value",
    "coefficient",
    "result"
  ];

  const roundAliases = [
    "roundid",
    "round_id",
    "round",
    "id"
  ];

  const timestampAliases = [
    "timestamp",
    "time",
    "date",
    "datetime"
  ];

  const findHeader = aliases =>
    aliases.find(alias => headers.includes(alias));

  const multiplierKey = findHeader(multiplierAliases);
  const roundKey = findHeader(roundAliases);
  const timestampKey = findHeader(timestampAliases);

  if (!multiplierKey) {
    throw new Error(
      "CSV must contain a multiplier/crash/value column."
    );
  }

  return lines.slice(1).map((line, index) => {
    const cells = line.split(",");
    const object = {};

    headers.forEach((header, cellIndex) => {
      object[header] = (cells[cellIndex] || "").trim();
    });

    return {
      roundId: roundKey
        ? object[roundKey] || String(index + 1)
        : String(index + 1),

      multiplier: numberOrNull(
        object[multiplierKey]
      ),

      timestamp: timestampKey
        ? object[timestampKey] || null
        : null,

      sourceRow: index + 2
    };
  });
}

function loadCSV() {
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(
      `CSV not found: ${CSV_PATH}`
    );
  }

  const text = fs.readFileSync(
    CSV_PATH,
    "utf8"
  );

  const parsed = parseCSV(text);

  cache.rows = parsed;
  cache.loadedAt = new Date().toISOString();

  return parsed;
}

function getRows() {
  if (!cache.rows.length) {
    loadCSV();
  }

  return cache.rows;
}

function getValidRows() {
  return getRows().filter(
    row =>
      Number.isFinite(row.multiplier) &&
      row.multiplier > 0
  );
}

function getValues() {
  return getValidRows().map(
    row => row.multiplier
  );
}

// ------------------------------------------------------------
// DATA QUALITY
// ------------------------------------------------------------

function getDataQuality() {
  const all = getRows();
  const valid = getValidRows();

  const invalidRows =
    all.length - valid.length;

  const ids = valid.map(row =>
    String(row.roundId)
  );

  const duplicateRoundIds =
    ids.length - new Set(ids).size;

  const timestamped = valid.filter(
    row =>
      row.timestamp &&
      !Number.isNaN(
        Date.parse(row.timestamp)
      )
  );

  let chronologicalViolations = 0;

  for (
    let i = 1;
    i < timestamped.length;
    i++
  ) {
    if (
      Date.parse(timestamped[i].timestamp) <
      Date.parse(timestamped[i - 1].timestamp)
    ) {
      chronologicalViolations++;
    }
  }

  const ready =
    valid.length >= CONFIG.minHistory &&
    invalidRows === 0 &&
    duplicateRoundIds === 0 &&
    chronologicalViolations === 0;

  return {
    state: ready ? "READY" : "LIMITED",
    ready,

    totalRows: all.length,
    validRows: valid.length,
    invalidRows,

    duplicateRoundIds,
    chronologicalViolations,

    minimumRequired:
      CONFIG.minHistory,

    source:
      path.basename(CSV_PATH),

    loadedAt: cache.loadedAt
  };
}

// ------------------------------------------------------------
// DISTRIBUTION
// ------------------------------------------------------------

function getDistribution(values) {
  return {
    count: values.length,

    min: values.length
      ? Math.min(...values)
      : null,

    max: values.length
      ? Math.max(...values)
      : null,

    mean: mean(values),
    median: median(values),

    stdev:
      standardDeviation(values),

    p25:
      percentile(values, 0.25),

    p75:
      percentile(values, 0.75),

    targetRate:
      percentage(
        values,
        value =>
          value >= CONFIG.target
      ),

    lowRate:
      percentage(
        values,
        value =>
          value < CONFIG.low
      ),

    veryLowRate:
      percentage(
        values,
        value =>
          value < CONFIG.veryLow
      ),

    highRate:
      percentage(
        values,
        value =>
          value >= CONFIG.high
      ),

    extremeRate:
      percentage(
        values,
        value =>
          value >= CONFIG.extreme
      ),

    lowStreak:
      longestStreak(
        values,
        value =>
          value < CONFIG.low
      ),

    veryLowStreak:
      longestStreak(
        values,
        value =>
          value < CONFIG.veryLow
      )
  };
}

// ------------------------------------------------------------
// ROLLING WINDOWS
// ------------------------------------------------------------

function getWindows(values) {
  return {
    short:
      getDistribution(
        values.slice(
          -CONFIG.shortWindow
        )
      ),

    medium:
      getDistribution(
        values.slice(
          -CONFIG.mediumWindow
        )
      ),

    long:
      getDistribution(
        values.slice(
          -CONFIG.longWindow
        )
      )
  };
}

// ------------------------------------------------------------
// REGIME
// ------------------------------------------------------------

function getRegime(windows) {
  if (!windows.long.count) {
    return "UNKNOWN";
  }

  if (
    windows.short.stdev >
    windows.long.stdev * 1.35
  ) {
    return "HIGH_VOLATILITY";
  }

  if (
    windows.short.targetRate >
    windows.long.targetRate + 15
  ) {
    return "ELEVATED_ACTIVITY";
  }

  if (
    windows.short.targetRate <
    windows.long.targetRate - 15
  ) {
    return "LOW_ACTIVITY";
  }

  return "BASELINE";
}

// ------------------------------------------------------------
// TRANSITIONS
// ------------------------------------------------------------

function getTransitions(values) {
  const result = {
    afterLow: {
      total: 0,
      target: 0,
      rate: null
    },

    afterVeryLow: {
      total: 0,
      target: 0,
      rate: null
    },

    afterTarget: {
      total: 0,
      target: 0,
      rate: null
    }
  };

  for (
    let i = 0;
    i < values.length - 1;
    i++
  ) {
    const current = values[i];
    const next = values[i + 1];

    if (current < CONFIG.low) {
      result.afterLow.total++;

      if (next >= CONFIG.target) {
        result.afterLow.target++;
      }
    }

    if (current < CONFIG.veryLow) {
      result.afterVeryLow.total++;

      if (next >= CONFIG.target) {
        result.afterVeryLow.target++;
      }
    }

    if (current >= CONFIG.target) {
      result.afterTarget.total++;

      if (next >= CONFIG.target) {
        result.afterTarget.target++;
      }
    }
  }

  for (const key of Object.keys(result)) {
    if (result[key].total) {
      result[key].rate =
        result[key].target /
        result[key].total *
        100;
    }
  }

  return result;
}

// ------------------------------------------------------------
// AUTOCORRELATION
// ------------------------------------------------------------

function getLag1Autocorrelation(values) {
  if (values.length < 3) {
    return 0;
  }

  const x = values.slice(0, -1);
  const y = values.slice(1);

  const mx = mean(x);
  const my = mean(y);

  let numerator = 0;
  let denominatorX = 0;
  let denominatorY = 0;

  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;

    numerator += dx * dy;
    denominatorX += dx * dx;
    denominatorY += dy * dy;
  }

  if (
    denominatorX === 0 ||
    denominatorY === 0
  ) {
    return 0;
  }

  return (
    numerator /
    Math.sqrt(
      denominatorX *
      denominatorY
    )
  );
}

// ------------------------------------------------------------
// MODEL
// ------------------------------------------------------------

function buildModel(values) {
  const windows =
    getWindows(values);

  const transitions =
    getTransitions(values);

  const autocorrelation =
    getLag1Autocorrelation(values);

  let score = 50;

  const reasons = [];
  const featureContributions = [];

  function addFeature(
    feature,
    points,
    reason
  ) {
    score += points;

    featureContributions.push({
      feature,
      points
    });

    if (reason) {
      reasons.push(reason);
    }
  }

  if (
    windows.medium.targetRate >
    windows.long.targetRate + 10
  ) {
    addFeature(
      "medium_vs_long",
      8,
      "Medium-window target activity is above the long-window baseline."
    );
  } else if (
    windows.medium.targetRate <
    windows.long.targetRate - 10
  ) {
    addFeature(
      "medium_vs_long",
      -8,
      "Medium-window target activity is below the long-window baseline."
    );
  }

  if (
    windows.short.targetRate >
    windows.medium.targetRate + 12
  ) {
    addFeature(
      "short_vs_medium",
      6,
      "Recent target activity is stronger than the medium window."
    );
  } else if (
    windows.short.targetRate <
    windows.medium.targetRate - 12
  ) {
    addFeature(
      "short_vs_medium",
      -6,
      "Recent target activity is weaker than the medium window."
    );
  }

  if (
    windows.short.veryLowStreak >= 3
  ) {
    addFeature(
      "very_low_streak",
      5,
      "A very-low streak exists. This is weak transition evidence only."
    );
  }

  if (
    windows.short.lowStreak >= 4
  ) {
    addFeature(
      "low_streak",
      4,
      "A recent low-result streak exists. Streaks alone are not sufficient."
    );
  }

  const latest =
    values[values.length - 1];

  if (
    latest >= CONFIG.high
  ) {
    addFeature(
      "latest_high",
      -4,
      "The latest round was high; immediate continuation is not assumed."
    );
  }

  if (
    latest < CONFIG.veryLow
  ) {
    addFeature(
      "latest_very_low",
      3,
      "The latest round was very low; transition evidence is mildly supportive."
    );
  }

  if (
    Math.abs(autocorrelation) >= 0.25
  ) {
    addFeature(
      "autocorrelation",
      autocorrelation > 0 ? 2 : -2,
      `Lag-1 autocorrelation is ${autocorrelation.toFixed(2)}.`
    );
  }

  if (
    transitions.afterLow.rate !== null
  ) {
    if (
      transitions.afterLow.rate >= 60
    ) {
      addFeature(
        "after_low_transition",
        4,
        `Observed target rate after low rounds is ${transitions.afterLow.rate.toFixed(1)}%.`
      );
    } else if (
      transitions.afterLow.rate <= 40
    ) {
      addFeature(
        "after_low_transition",
        -4,
        `Observed target rate after low rounds is only ${transitions.afterLow.rate.toFixed(1)}%.`
      );
    }
  }

  const regime =
    getRegime(windows);

  if (
    regime === "HIGH_VOLATILITY"
  ) {
    addFeature(
      "regime",
      -5,
      "Current rolling regime is high volatility."
    );
  }

  score =
    Math.max(
      0,
      Math.min(100, score)
    );

  let action = "NO SIGNAL";

  if (
    score >=
    CONFIG.strongThreshold
  ) {
    action = "SIGNAL";
  } else if (
    score >=
    CONFIG.signalThreshold
  ) {
    action = "WATCH";
  }

  const confidence =
    Math.max(
      50,
      Math.min(
        90,
        Math.round(
          50 +
          Math.abs(score - 50) *
            0.8
        )
      )
    );

  return {
    score,
    action,
    confidence,

    reasons,

    featureContributions,

    windows,
    transitions,
    autocorrelation,
    regime
  };
}

// ------------------------------------------------------------
// WALK-FORWARD BACKTEST
// ------------------------------------------------------------

function runBacktest(values) {
  let samples = 0;
  let hits = 0;
  let misses = 0;

  const recent = [];

  for (
    let i = CONFIG.minHistory;
    i < values.length;
    i++
  ) {
    const training =
      values.slice(0, i);

    const model =
      buildModel(training);

    if (
      model.score >=
      CONFIG.signalThreshold
    ) {
      samples++;

      const actual =
        values[i];

      const hit =
        actual >= CONFIG.target;

      if (hit) {
        hits++;
      } else {
        misses++;
      }

      recent.push({
        position: i + 1,
        score: model.score,
        action: model.action,
        predictedTarget: true,
        actual,
        hit
      });
    }
  }

  const hitRate =
    samples
      ? hits / samples * 100
      : 0;

  const available =
    Math.max(
      1,
      values.length -
      CONFIG.minHistory
    );

  const coverage =
    samples / available * 100;

  const falseSignalRate =
    samples
      ? 100 - hitRate
      : 0;

  const stable =
    samples >=
    CONFIG.minBacktestSamples &&
    hitRate >=
    CONFIG.stableHitRate;

  return {
    samples,
    hits,
    misses,

    hitRate,
    coverage,
    falseSignalRate,

    stable,

    minimumSamples:
      CONFIG.minBacktestSamples,

    threshold:
      CONFIG.signalThreshold,

    recent:
      recent.slice(-20)
  };
}

// ------------------------------------------------------------
// EVIDENCE GATES
// ------------------------------------------------------------

function getEvidenceGate(
  quality,
  backtest,
  model
) {
  const gates = [
    {
      name: "dataQuality",
      pass: quality.ready,
      detail:
        quality.ready
          ? "Dataset passes quality checks."
          : "Dataset quality gate failed."
    },

    {
      name: "minimumHistory",
      pass:
        quality.validRows >=
        CONFIG.minHistory,
      detail:
        `${quality.validRows}/${CONFIG.minHistory} minimum valid rounds.`
    },

    {
      name: "backtestSamples",
      pass:
        backtest.samples >=
        CONFIG.minBacktestSamples,
      detail:
        `${backtest.samples}/${CONFIG.minBacktestSamples} qualifying historical signals.`
    },

    {
      name: "backtestStability",
      pass:
        backtest.stable,
      detail:
        backtest.samples
          ? `Hit rate ${backtest.hitRate.toFixed(1)}%.`
          : "No qualifying signals."
    },

    {
      name: "volatility",
      pass:
        model.regime !==
        "HIGH_VOLATILITY",
      detail:
        model.regime
    }
  ];

  const pass =
    gates.every(
      gate => gate.pass
    ) &&
    model.score >=
    CONFIG.signalThreshold;

  return {
    pass,
    gates
  };
}

// ------------------------------------------------------------
// ROUND CONTEXT
// ------------------------------------------------------------

function getRoundContext(rows) {
  const previous =
    rows.length >= 2
      ? rows[rows.length - 2]
      : null;

  const latest =
    rows.length
      ? rows[rows.length - 1]
      : null;

  return {
    previous:
      previous
        ? previous.multiplier
        : null,

    latest:
      latest
        ? latest.multiplier
        : null,

    next: null,

    entry: null,

    entryRule:
      "V1.1.1 has no live Aviator round clock and never fabricates an entry time."
  };
}

// ------------------------------------------------------------
// CANONICAL API RESPONSE
// ------------------------------------------------------------

function createCanonicalResponse() {
  const rows =
    getValidRows();

  const values =
    rows.map(
      row => row.multiplier
    );

  const quality =
    getDataQuality();

  const summary =
    getDistribution(values);

  const model =
    buildModel(values);

  const backtest =
    runBacktest(values);

  const evidence =
    getEvidenceGate(
      quality,
      backtest,
      model
    );

  let action =
    model.action;

  if (!evidence.pass) {
    action = "NO SIGNAL";
  }

  const risk =
    action === "SIGNAL" ||
    action === "WATCH"
      ? "RESEARCH-ONLY / HIGH RISK"
      : "NO TRADE";

  return {
    ok: true,

    version: VERSION,

    mode: "RESEARCH",

    source:
      "CSV HISTORICAL DATA",

    timezone: "UTC",

    signal: {
      action,

      score:
        model.score,

      confidence:
        evidence.pass
          ? model.confidence
          : 50,

      risk,

      evidenceStrength:
        evidence.pass
          ? "SUFFICIENT"
          : "INSUFFICIENT",

      reasons:
        evidence.pass
          ? model.reasons
          : [
              "Evidence gates are not satisfied. No signal is issued."
            ]
    },

    roundContext:
      getRoundContext(rows),

    dataset: {
      quality,

      summary
    },

    research: {
      windows:
        model.windows,

      regime:
        model.regime,

      autocorrelation:
        model.autocorrelation,

      transitions:
        model.transitions
    },

    backtest,

    evidence: {
      pass:
        evidence.pass,

      gates:
        evidence.gates,

      featureContributions:
        model.featureContributions
    },

    recentRounds:
      values
        .slice(-20)
        .map(
          (multiplier, index) => ({
            position:
              values.length -
              Math.min(
                values.length,
                20
              ) +
              index +
              1,

            multiplier
          })
        )
  };
}

function safeCanonicalResponse() {
  try {
    return createCanonicalResponse();
  } catch (error) {
    return {
      ok: false,

      version: VERSION,

      mode: "RESEARCH",

      error:
        error.message,

      signal: {
        action: "NO SIGNAL",
        score: 0,
        confidence: 0,
        risk: "DATA ERROR",
        evidenceStrength:
          "UNAVAILABLE",
        reasons: [
          error.message
        ]
      },

      roundContext: {
        previous: null,
        latest: null,
        next: null,
        entry: null
      },

      dataset: {
        quality: {
          state: "ERROR"
        },
        summary: {}
      },

      research: {
        windows: {},
        regime: "UNKNOWN",
        autocorrelation: 0,
        transitions: {}
      },

      backtest: {
        samples: 0,
        hits: 0,
        misses: 0,
        hitRate: 0,
        coverage: 0,
        falseSignalRate: 0,
        stable: false,
        recent: []
      },

      evidence: {
        pass: false,
        gates: [],
        featureContributions: []
      },

      recentRounds: []
    };
  }
}

// ------------------------------------------------------------
// ROUTES
// ------------------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "AVIATOR AI PREDICTOR",
    version: VERSION,
    mode: "RESEARCH",
    message:
      "Historical research and walk-forward backtesting API. No guaranteed next-round prediction."
  });
});

// ONE CANONICAL RESPONSE
app.get(
  "/api/analyze",
  (req, res) => {
    res.json(
      safeCanonicalResponse()
    );
  }
);

// SAME CANONICAL RESPONSE.
// This prevents frontend/backend response mismatch.
app.get(
  "/api/backtest",
  (req, res) => {
    res.json(
      safeCanonicalResponse()
    );
  }
);

app.get(
  "/api/status",
  (req, res) => {
    const data =
      safeCanonicalResponse();

    res.json({
      ok: data.ok,
      version: VERSION,
      mode: "RESEARCH",

      quality:
        data.dataset.quality,

      signal:
        data.signal,

      backtest:
        data.backtest,

      canonicalEndpoint:
        "/api/analyze"
    });
  }
);

app.get(
  "/api/history",
  (req, res) => {
    try {
      const data =
        getValidRows();

      res.json({
        ok: true,
        version: VERSION,
        count: data.length,
        rounds: data
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message
      });
    }
  }
);

// ------------------------------------------------------------
// START
// ------------------------------------------------------------

app.listen(PORT, () => {
  console.log(
    `AVIATOR AI PREDICTOR ${VERSION} running on port ${PORT}`
  );

  console.log(
    `CSV: ${CSV_PATH}`
  );
});
