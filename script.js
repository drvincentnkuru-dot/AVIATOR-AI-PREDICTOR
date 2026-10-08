// ============================================================
// AVIATOR AI PREDICTOR
// Frontend V1.1.1
//
// IMPORTANT:
// Frontend contains NO prediction logic.
// It only renders the canonical /api/analyze response.
// ============================================================

const API_BASE =
  "https://aviator-ai-predictor-v1.onrender.com";

const $ = id =>
  document.getElementById(id);

function fmt(value, digits = 2) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return "—";
  }

  return Number(value).toFixed(digits);
}

function pct(value) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return "—";
  }

  return `${Number(value).toFixed(1)}%`;
}

function setText(id, value) {
  const element = $(id);

  if (element) {
    element.textContent =
      value === null ||
      value === undefined
        ? "—"
        : value;
  }
}

function actionClass(action) {
  if (action === "SIGNAL") {
    return "signal";
  }

  if (action === "WATCH") {
    return "watch";
  }

  return "no-signal";
}

function render(data) {
  if (!data || data.ok === false) {
    setText(
      "action",
      "NO SIGNAL"
    );

    setText("score", "—");
    setText("confidence", "—");

    setText(
      "risk",
      "DATA ERROR"
    );

    setText(
      "evidence",
      data?.error ||
        "API unavailable"
    );

    return;
  }

  const signal =
    data.signal || {};

  const quality =
    data.dataset?.quality || {};

  const summary =
    data.dataset?.summary || {};

  const windows =
    data.research?.windows || {};

  const backtest =
    data.backtest || {};

  const context =
    data.roundContext || {};

  const evidence =
    data.evidence || {};

  const action =
    $("action");

  if (action) {
    action.textContent =
      signal.action ||
      "NO SIGNAL";

    action.className =
      `value ${actionClass(
        signal.action
      )}`;
  }

  setText(
    "score",
    fmt(signal.score, 0)
  );

  setText(
    "confidence",
    `${fmt(
      signal.confidence,
      0
    )} / 100`
  );

  setText(
    "risk",
    signal.risk || "—"
  );

  setText(
    "evidence",
    signal.evidenceStrength ||
      "—"
  );

  // ----------------------------------------------------------
  // REASONS
  // ----------------------------------------------------------

  const reasons =
    $("reasons");

  if (reasons) {
    reasons.innerHTML = "";

    (
      signal.reasons || []
    ).forEach(reason => {
      const li =
        document.createElement(
          "li"
        );

      li.textContent =
        reason;

      reasons.appendChild(li);
    });
  }

  // ----------------------------------------------------------
  // ROUND CONTEXT
  // ----------------------------------------------------------

  setText(
    "previous",
    context.previous === null ||
    context.previous === undefined
      ? "—"
      : `${fmt(
          context.previous
        )}x`
  );

  setText(
    "latest",
    context.latest === null ||
    context.latest === undefined
      ? "—"
      : `${fmt(
          context.latest
        )}x`
  );

  setText(
    "next",
    "Not predictable from V1.1.1"
  );

  setText(
    "entry",
    context.entry ||
      "No live entry clock"
  );

  // ----------------------------------------------------------
  // DATA QUALITY
  // ----------------------------------------------------------

  setText(
    "quality",
    quality.state ||
      "—"
  );

  setText(
    "rounds",
    quality.validRows ??
      "—"
  );

  setText(
    "invalid",
    quality.invalidRows ??
      "—"
  );

  setText(
    "duplicates",
    quality.duplicateRoundIds ??
      "—"
  );

  setText(
    "source",
    data.source ||
      "CSV HISTORICAL DATA"
  );

  // ----------------------------------------------------------
  // DISTRIBUTION
  // ----------------------------------------------------------

  setText(
    "min",
    fmt(summary.min)
  );

  setText(
    "median",
    fmt(summary.median)
  );

  setText(
    "mean",
    fmt(summary.mean)
  );

  setText(
    "max",
    fmt(summary.max)
  );

  setText(
    "stdev",
    fmt(summary.stdev)
  );

  setText(
    "p75",
    fmt(summary.p75)
  );

  // ----------------------------------------------------------
  // WINDOWS
  // ----------------------------------------------------------

  setText(
    "shortTarget",
    pct(
      windows.short?.targetRate
    )
  );

  setText(
    "mediumTarget",
    pct(
      windows.medium?.targetRate
    )
  );

  setText(
    "longTarget",
    pct(
      windows.long?.targetRate
    )
  );

  setText(
    "shortStreak",
    windows.short?.lowStreak ??
      "—"
  );

  setText(
    "veryLowStreak",
    windows.short?.veryLowStreak ??
      "—"
  );

  setText(
    "regime",
    data.research?.regime ||
      "—"
  );

  // ----------------------------------------------------------
  // RESEARCH EVIDENCE
  // ----------------------------------------------------------

  setText(
    "autocorr",
    fmt(
      data.research
        ?.autocorrelation,
      3
    )
  );

  setText(
    "afterLow",
    pct(
      data.research
        ?.transitions
        ?.afterLow
        ?.rate
    )
  );

  setText(
    "afterVeryLow",
    pct(
      data.research
        ?.transitions
        ?.afterVeryLow
        ?.rate
    )
  );

  // ----------------------------------------------------------
  // BACKTEST
  // ----------------------------------------------------------

  setText(
    "btSamples",
    backtest.samples ??
      "—"
  );

  setText(
    "btHits",
    backtest.hits ??
      "—"
  );

  setText(
    "btMisses",
    backtest.misses ??
      "—"
  );

  setText(
    "btRate",
    pct(
      backtest.hitRate
    )
  );

  setText(
    "btCoverage",
    pct(
      backtest.coverage
    )
  );

  setText(
    "btFalse",
    pct(
      backtest.falseSignalRate
    )
  );

  setText(
    "btStable",
    backtest.stable
      ? "YES"
      : "NO"
  );

  // ----------------------------------------------------------
  // EVIDENCE GATES
  // ----------------------------------------------------------

  const gateList =
    $("gates");

  if (gateList) {
    gateList.innerHTML = "";

    (
      evidence.gates || []
    ).forEach(gate => {
      const li =
        document.createElement(
          "li"
        );

      li.textContent =
        `${gate.pass ? "PASS" : "BLOCK"} — ` +
        `${gate.name}: ` +
        `${gate.detail}`;

      li.className =
        gate.pass
          ? "pass"
          : "block";

      gateList.appendChild(li);
    });
  }

  // ----------------------------------------------------------
  // FEATURES
  // ----------------------------------------------------------

  const featureList =
    $("features");

  if (featureList) {
    featureList.innerHTML = "";

    (
      evidence.featureContributions ||
      []
    ).forEach(feature => {
      const li =
        document.createElement(
          "li"
        );

      const points =
        Number(feature.points);

      li.textContent =
        `${feature.feature}: ` +
        `${points > 0 ? "+" : ""}` +
        `${points}`;

      featureList.appendChild(li);
    });
  }

  // ----------------------------------------------------------
  // RECENT ROUNDS
  // ----------------------------------------------------------

  const table =
    $("roundTable");

  if (table) {
    table.innerHTML = "";

    (
      data.recentRounds || []
    )
      .slice()
      .reverse()
      .forEach(round => {
        const tr =
          document.createElement(
            "tr"
          );

        tr.innerHTML =
          `<td>${round.position}</td>` +
          `<td>${fmt(
            round.multiplier
          )}x</td>`;

        table.appendChild(tr);
      });
  }

  // ----------------------------------------------------------
  // VERSION / TIME
  // ----------------------------------------------------------

  setText(
    "version",
    data.version ||
      "V1.1.1"
  );

  setText(
    "updated",
    new Date()
      .toLocaleTimeString()
  );
}

// ------------------------------------------------------------
// API
// ------------------------------------------------------------

async function getCanonicalData() {
  const response =
    await fetch(
      `${API_BASE}/api/analyze`,
      {
        cache: "no-store"
      }
    );

  if (!response.ok) {
    throw new Error(
      `API HTTP ${response.status}`
    );
  }

  return response.json();
}

async function refresh() {
  setText(
    "updated",
    "Loading..."
  );

  try {
    const data =
      await getCanonicalData();

    render(data);
  } catch (error) {
    render({
      ok: false,
      error:
        error.message
    });
  }
}

// ------------------------------------------------------------
// EVENTS
// ------------------------------------------------------------

document.addEventListener(
  "DOMContentLoaded",
  () => {
    $("analyzeBtn")
      ?.addEventListener(
        "click",
        refresh
      );

    $("backtestBtn")
      ?.addEventListener(
        "click",
        refresh
      );

    $("historyBtn")
      ?.addEventListener(
        "click",
        async () => {
          try {
            const response =
              await fetch(
                `${API_BASE}/api/history`,
                {
                  cache:
                    "no-store"
                }
              );

            const data =
              await response.json();

            alert(
              `Loaded ${data.count} valid historical rounds.`
            );
          } catch (error) {
            alert(
              `History error: ${error.message}`
            );
          }
        }
      );

    refresh();
  }
);
