'use strict';

/*
===========================================================
 AVIATOR AI PREDICTOR V1.0
 Frontend API client

 BACKEND:
 https://aviator-ai-predictor-v1.onrender.com

 IMPORTANT:
 This file uses the same API response contract as backend/server.js.
===========================================================
*/

const API_BASE =
  window.AVIATOR_API_BASE ||
  'https://aviator-ai-predictor-v1.onrender.com';

const q = (id) => document.getElementById(id);

const api = q('api');
const status = q('status');

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[c])
  );

const mul = (v) =>
  v == null ? '—' : Number(v).toFixed(2) + 'x';

const pct = (v) =>
  v == null ? '—' : Number(v).toFixed(2) + '%';


async function get(path) {
  const r = await fetch(API_BASE + path);

  if (!r.ok) {
    throw new Error('HTTP ' + r.status);
  }

  return r.json();
}


function show(d) {
  if (!d || !d.ok) {
    throw new Error('Invalid API response');
  }

  /*
  =========================================================
   API STATUS
  =========================================================
  */

  api.textContent = 'API ONLINE';
  api.className = 'on';


  /*
  =========================================================
   SIGNAL
  =========================================================
  */

  q('action').textContent = d.signal?.action || '—';

  q('action').className =
    'action ' +
    String(d.signal?.action || '')
      .toLowerCase();

  q('score').textContent =
    d.signal?.score ?? '—';

  q('confidence').textContent =
    d.signal?.confidence != null
      ? d.signal.confidence + '%'
      : '—';

  q('risk').textContent =
    d.signal?.risk || '—';

  q('reasons').innerHTML =
    (d.signal?.reasons || [])
      .map((x) => '<p>• ' + esc(x) + '</p>')
      .join('');


  /*
  =========================================================
   ROUND CONTEXT
  =========================================================
  */

  q('prev').textContent =
    d.previousRound
      ? `#${d.previousRound.roundId} ${mul(d.previousRound.multiplier)}`
      : '—';

  q('latest').textContent =
    d.latestRound
      ? `#${d.latestRound.roundId} ${mul(d.latestRound.multiplier)}`
      : '—';

  q('next').textContent =
    d.nextRound
      ? `#${d.nextRound.roundId}`
      : '—';

  q('entry').textContent =
    d.entry?.entryTime ||
    (
      d.entry?.entryRound
        ? 'Next round #' + d.entry.entryRound
        : '—'
    );


  /*
  =========================================================
   DATASET SUMMARY
  =========================================================
  */

  const s = d.analysis?.summary || {};

  const f =
    d.analysis?.recent?.features || {};

  const b =
    d.model?.backtest || {};

  q('samples').textContent =
    s.samples ?? '—';

  q('summary').innerHTML = [
    ['Min', mul(s.min)],
    ['Median', mul(s.median)],
    ['Mean', mul(s.mean)],
    ['Max', mul(s.max)]
  ]
    .map(
      (x) =>
        `<p>${x[0]} <strong>${x[1]}</strong></p>`
    )
    .join('');


  /*
  =========================================================
   RECENT WINDOW
  =========================================================
  */

  const recentRates =
    f.recentRates || {};

  q('recent').innerHTML = [
    ['Window', f.recentWindow ?? '—'],
    ['Recent mean', mul(f.recentMean)],
    ['>=2x rate', pct(recentRates.atLeast2)],
    ['>=3x rate', pct(recentRates.atLeast3)],
    ['Low streak', f.lowStreak ?? '—'],
    ['Very-low streak', f.veryLowStreak ?? '—']
  ]
    .map(
      (x) =>
        `<p>${x[0]} <strong>${x[1]}</strong></p>`
    )
    .join('');


  /*
  =========================================================
   BACKTEST
  =========================================================
  */

  q('hit').textContent =
    b.samples
      ? pct(b.hitRate)
      : '—';

  q('bt').innerHTML = [
    ['Samples', b.samples ?? 0],
    ['Hits', b.hits ?? 0],
    ['Misses', b.misses ?? 0],
    ['Coverage', pct(b.coverage)]
  ]
    .map(
      (x) =>
        `<p>${x[0]} <strong>${x[1]}</strong></p>`
    )
    .join('');


  /*
  =========================================================
   RECENT ROUNDS TABLE
  =========================================================
  */

  const rounds =
    d.analysis?.recent?.rounds || [];

  q('table').innerHTML =
    rounds
      .slice()
      .reverse()
      .map((r) => {
        let label = 'MID';

        if (r.multiplier >= 10) {
          label = 'EXTREME';
        } else if (r.multiplier >= 3) {
          label = 'HIGH';
        } else if (r.multiplier >= 2) {
          label = 'TARGET+';
        } else if (r.multiplier < 1.2) {
          label = 'LOW';
        }

        return `
          <div class="row">
            <span>#${r.roundId}</span>
            <strong>${mul(r.multiplier)}</strong>
            <span>${label}</span>
          </div>
        `;
      })
      .join('');


  /*
  =========================================================
   ANALYSIS TIME
  =========================================================
  */

  q('time').textContent =
    d.analyzedAt
      ? new Date(d.analyzedAt).toLocaleString()
      : '—';

  status.textContent =
    'V' + (d.version || '1.0') + ' analysis loaded.';
}


async function run(path, msg, render = true) {
  try {
    status.textContent = msg;

    const d = await get(path);

    if (render) {
      show(d);
    } else {
      api.textContent = 'API ONLINE';
      api.className = 'on';

      status.textContent =
        'Backtest loaded.';
    }

  } catch (e) {
    api.textContent = 'API OFFLINE';
    api.className = 'off';

    status.textContent =
      e.message || 'API request failed.';
  }
}


/*
===========================================================
 BUTTONS
===========================================================
*/

q('analyze').onclick = () =>
  run(
    '/api/analyze',
    'Analyzing...'
  );


q('backtest').onclick = () =>
  run(
    '/api/backtest',
    'Running backtest...',
    false
  );


q('history').onclick = async () => {
  try {
    status.textContent =
      'Loading history...';

    const d =
      await get('/api/history');

    const rounds =
      d.rounds || [];

    q('table').innerHTML =
      rounds
        .slice()
        .reverse()
        .map(
          (r) => `
            <div class="row">
              <span>#${r.roundId}</span>
              <strong>${mul(r.multiplier)}</strong>
              <span>HISTORICAL</span>
            </div>
          `
        )
        .join('');

    api.textContent = 'API ONLINE';
    api.className = 'on';

    status.textContent =
      (d.total ?? rounds.length) +
      ' rounds loaded.';

  } catch (e) {
    api.textContent = 'API OFFLINE';
    api.className = 'off';

    status.textContent =
      e.message || 'History request failed.';
  }
};


/*
===========================================================
 INITIAL API CHECK
===========================================================
*/

run(
  '/api/analyze',
  'Connecting to API...'
);
