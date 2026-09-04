#!/usr/bin/env node
/**
 * Checks on the calibration (scripts/lib/calibrate.mjs) and the season
 * backtest (scripts/lib/backtest.mjs), on leagues whose answers are known.
 *
 * A margin model fitted to games drawn from a known sigma has to recover it;
 * a slope has to show up when the truth has one and stay near zero when it
 * does not; the moneyline has to earn weight only when it carries information
 * the spread lacks; projection error has to grow with the horizon; and the
 * scoring has to reward a forecaster who knows the answer.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  fitMarginModel,
  fitMoneylineWeight,
  score,
  scoreModel,
  horizonStudy,
  tuneRatingParams,
  seasonInputs,
  calibrate,
} from "./lib/calibrate.mjs";
import { scoreSeasonLines, walkForwardFit, coachRecord } from "./lib/backtest.mjs";
import { anchorAt, fitForm } from "./lib/rate.mjs";
import { expandHistory, compactHistory, HISTORY_FIELDS } from "./lib/history.mjs";
import {
  resolveModel,
  winProbFromSpread,
  normalCdf,
  logit,
  expit,
} from "../src/js/core/probability.js";
import { LEAGUE_IDS } from "../src/js/leagues.js";

const close = (a, b, tolerance, message) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b}`);

let seed = 20260904;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const gaussian = () => {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

/** Games whose margins scatter around the spread by a known sigma(spread). */
function syntheticGames(count, sigmaOf, { moneylineNoise = null } = {}) {
  const games = [];
  for (let i = 0; i < count; i += 1) {
    const spread = Math.round(gaussian() * 9 * 2) / 2;
    const sigma = sigmaOf(spread);
    const margin = Math.round(-spread + gaussian() * sigma);
    const truth = normalCdf(-spread / sigma);
    const homeFair =
      moneylineNoise === null
        ? null
        : expit(logit(Math.min(0.99, Math.max(0.01, truth))) + gaussian() * moneylineNoise);
    games.push({
      season: 2020 + (i % 4),
      week: 1 + (i % 12),
      home: `H${i % 20}`,
      away: `A${(i * 7) % 20}`,
      neutral: 0,
      spread,
      total: 45 + Math.round(gaussian() * 5),
      homeMoneyline: null,
      awayMoneyline: null,
      homeFair,
      margin,
    });
  }
  return games;
}

// A fixed sigma is recovered, and no slope is invented.
{
  const games = syntheticGames(8000, () => 13);
  const fitted = fitMarginModel(games, { totals: false });
  close(fitted.margin.sigma, 13, 0.8, "a fixed sigma of 13 is recovered");
  assert.ok(fitted.margin.slope < 0.06, `no slope is invented (${fitted.margin.slope})`);
  assert.equal(fitted.margin.totalSlope, 0, "totals off means no total slope");
  const model = resolveModel({ margin: fitted.margin });
  const scored = scoreModel(games, model);
  const truthScored = score(
    games
      .filter((g) => g.margin !== 0)
      .map((g) => ({ p: normalCdf(-g.spread / 13), won: g.margin > 0 })),
  );
  close(scored.logLoss, truthScored.logLoss, 0.003, "the fitted model scores like the truth");
  // Well calibrated where it matters: predicted and actual agree in every
  // band with enough games to say.
  for (const band of scored.bands.filter((b) => b.n >= 200)) {
    close(band.predicted, band.actual, 0.05, `band ${band.low}-${band.high} is calibrated`);
  }
}

// A slope is found when the truth has one.
{
  const games = syntheticGames(8000, (spread) => 11 + 0.2 * Math.abs(spread));
  const fitted = fitMarginModel(games, { totals: false });
  assert.ok(
    fitted.margin.slope > 0.1 && fitted.margin.slope < 0.32,
    `a slope of 0.2 shows up (${fitted.margin.slope})`,
  );
  close(fitted.margin.sigma, 11, 1.2, "and the intercept with it");
}

// The moneyline earns weight when it knows something the spread does not,
// and none when it is noise around the same number.
{
  const informative = [];
  for (let i = 0; i < 6000; i += 1) {
    // The spread is a noisy read of a truth the moneyline sees more sharply.
    const truthSpread = Math.round(gaussian() * 9 * 2) / 2;
    const spread = truthSpread + Math.round(gaussian() * 3 * 2) / 2;
    const p = normalCdf(-truthSpread / 13);
    informative.push({
      season: 2020,
      week: 1,
      home: "H",
      away: "A",
      neutral: 0,
      spread,
      total: null,
      homeMoneyline: null,
      awayMoneyline: null,
      homeFair: expit(logit(Math.min(0.99, Math.max(0.01, p))) + gaussian() * 0.05),
      margin: Math.round(-truthSpread + gaussian() * 13) || 1,
    });
  }
  const model = resolveModel({ margin: { sigma: 13, slope: 0, totalSlope: 0 } });
  const weighted = fitMoneylineWeight(informative, model);
  assert.ok(weighted.weight >= 0.5, `a sharper moneyline earns weight (${weighted.weight})`);

  const noisy = syntheticGames(6000, () => 13, { moneylineNoise: 0.6 });
  const unweighted = fitMoneylineWeight(noisy, model);
  assert.ok(unweighted.weight <= 0.25, `a noisy moneyline earns little (${unweighted.weight})`);
}

// Projection error grows with the horizon on seasons whose ratings drift.
{
  const teams = Array.from({ length: 12 }, (_, i) => `T${i}`);
  const games = [];
  for (let season = 2019; season <= 2023; season += 1) {
    const rating = Object.fromEntries(teams.map((team) => [team, gaussian() * 7]));
    for (let week = 1; week <= 13; week += 1) {
      for (const team of teams) rating[team] += gaussian() * 1.2;
      const order = [...teams].sort(() => random() - 0.5);
      for (let i = 0; i < order.length; i += 2) {
        const home = order[i];
        const away = order[i + 1];
        const spread = -(rating[home] - rating[away] + 2.5) + gaussian() * 1.5;
        games.push({
          season,
          week,
          home,
          away,
          neutral: 0,
          spread: Math.round(spread * 2) / 2,
          total: null,
          homeMoneyline: null,
          awayMoneyline: null,
          homeFair: null,
          margin: Math.round(-spread + gaussian() * 13) || 3,
        });
      }
    }
  }
  const study = horizonStudy(games, { homeFieldPoints: 2.5, maxHorizon: 8 });
  assert.ok(study.byHorizon.length >= 6, "several horizons are measured");
  assert.ok(
    study.byHorizon.at(-1).rmse > study.byHorizon[0].rmse,
    `error grows with the horizon (${study.byHorizon[0].rmse} -> ${study.byHorizon.at(-1).rmse})`,
  );
  assert.ok(study.horizon.base >= 0 && study.horizon.perWeek > 0, "the curve has a slope");
  assert.ok(
    study.horizon.teamShare >= 0 && study.horizon.teamShare <= 0.9,
    "team share is a share",
  );
  assert.equal(study.seasons, 4, "the first season is the prior for the rest");

  const tuned = tuneRatingParams(games, { homeFieldPoints: 2.5, rounds: 1, anchorHalfLife: 3 });
  assert.ok(tuned.mae > 0 && tuned.trials.length > 5, "tuning tries the grid");
  for (const [name, value] of Object.entries(tuned.params)) {
    assert.ok(Number.isFinite(value) && value >= 0, `tuned ${name} is a number`);
  }
  assert.equal(tuned.params.anchorHalfLife, 3, "the half-life is given, not searched");
  assert.ok(study.priorMae > 0, "the prior's own miss is measured");

  // The whole document, with the anchor scaled to a live prior twice as good
  // as the history's: four times the pull, and a shorter half-life.
  const scaled = calibrate(games, {
    homeFieldPoints: 2.5,
    tune: false,
    livePriorMae: study.priorMae / 2,
  });
  close(
    scaled.prior.anchorLive,
    Math.min(8, scaled.prior.anchorHistory * 4),
    1e-6,
    "anchor scales with precision",
  );
  assert.ok(scaled.prior.halfLifeLive < scaled.prior.halfLifeHistory, "and fades sooner");
  const same = calibrate(games, {
    homeFieldPoints: 2.5,
    tune: false,
    livePriorMae: study.priorMae,
  });
  close(
    same.prior.anchorLive,
    same.prior.anchorHistory,
    1e-6,
    "a prior as good as the history's keeps its anchor",
  );

  const inputs = seasonInputs(games.filter((g) => g.season === 2019));
  assert.ok(Object.keys(inputs.schedule.weeks).length === 13, "a season's schedule has its weeks");
  assert.ok(Object.keys(inputs.lines).length > 0 && Object.keys(inputs.scores).length > 0);
}

// The anchor fades with the prior's age, and a constant one does not.
{
  const fading = { anchor: 2, anchorHalfLife: 2 };
  assert.equal(anchorAt(fading, 0), 2, "at the opening the anchor is whole");
  assert.equal(anchorAt(fading, 2), 1, "after one half-life it is half");
  close(anchorAt(fading, 6), 0.5, 1e-12, "after three it is a quarter");
  assert.equal(anchorAt({ anchor: 2, anchorHalfLife: 0 }, 9), 2, "zero keeps it constant");
  // Through the fit: the same single line moves a team further later in the
  // season, when the prior it argues against has faded.
  const schedule = { weeks: { 1: [{ home: "A", away: "B" }], 8: [{ home: "A", away: "B" }] } };
  const early = fitForm({
    schedule,
    lines: { "1|A": { spread: -10, source: "market" } },
    base: { A: 0, B: 0 },
    homeFieldPoints: 2.5,
    throughWeek: 1,
    params: fading,
  });
  const late = fitForm({
    schedule,
    lines: { "8|A": { spread: -10, source: "market" } },
    base: { A: 0, B: 0 },
    homeFieldPoints: 2.5,
    throughWeek: 8,
    params: fading,
  });
  assert.ok(late.ratings.A > early.ratings.A, "a line in week 8 moves a faded prior further");
}

// Scoring: a forecaster who knows the answer scores zero; the bands sum.
{
  const perfect = score([
    { p: 0.999, won: true },
    { p: 0.001, won: false },
  ]);
  assert.ok(perfect.logLoss < 0.002 && perfect.brier < 1e-5, "certainty scores nearly nothing");
  const coin = score(Array.from({ length: 100 }, (_, i) => ({ p: 0.5, won: i % 2 === 0 })));
  // Scores are reported to five places.
  close(coin.logLoss, Math.log(2), 1e-5, "a coin flip is log 2");
  close(coin.brier, 0.25, 1e-5, "and a quarter");
  assert.equal(
    coin.bands.reduce((total, band) => total + band.n, 0),
    100,
    "bands cover everything",
  );
}

// History round-trips through its compact form.
{
  const games = syntheticGames(5, () => 13);
  const back = expandHistory({ games: compactHistory(games) });
  assert.deepEqual(
    back.map((g) => HISTORY_FIELDS.map((f) => g[f] ?? null)),
    games.map((g) => HISTORY_FIELDS.map((f) => g[f] ?? null)),
  );
}

// The season backtest on made-up snapshots.
{
  const model = resolveModel(null);
  const line = (spread, winProb) => ({
    spread,
    source: "market",
    winProb,
    total: null,
    moneylineProb: null,
  });
  const snapshots = [
    {
      at: "2026-09-01T00:00:00Z",
      week: 1,
      lines: { "1|A": line(-10, 0.7), "1|B": line(-3, 0.55) },
    },
    {
      at: "2026-09-03T00:00:00Z",
      week: 1,
      lines: { "1|A": line(-12, 0.78), "1|B": line(-3, 0.56) },
    },
    {
      at: "2026-09-10T00:00:00Z",
      week: 2,
      lines: { "2|C": line(-7, 0.7) },
      recommendation: {
        picks: { 2: ["C"] },
        frontier: { candidates: [{ teams: ["C"], weekWinProb: 0.7, chosen: true }] },
      },
    },
  ];
  const results = { "1|A": "W", "1|B": "L", "2|C": "W" };
  const scored = scoreSeasonLines(snapshots, results, model);
  assert.equal(scored.n, 3, "three decided lines");
  close(
    scored.closing.logLoss,
    -(Math.log(0.78) + Math.log(1 - 0.56) + Math.log(0.7)) / 3,
    1e-5,
    "closing lines are the last snapshot's",
  );
  close(
    scored.opening.logLoss,
    -(Math.log(0.7) + Math.log(1 - 0.55) + Math.log(0.7)) / 3,
    1e-5,
    "opening lines are the first snapshot's",
  );
  assert.equal(scored.moneylineOnly.n, 0, "no moneylines, nothing to score them on");
  assert.ok(scored.spreadOnly.logLoss > 0 && scored.legacy.logLoss > 0);

  const record = coachRecord(snapshots, results);
  assert.deepEqual(
    record.map((row) => [row.week, row.teams, row.outcome]),
    [[2, ["C"], "W"]],
    "the coach's call and its outcome are read from the closing snapshot",
  );

  // Walk-forward fit needs two weeks of lines and reports each layer.
  const schedule = {
    weeks: {
      1: [
        { home: "A", away: "X" },
        { home: "B", away: "Y" },
      ],
      2: [
        { home: "C", away: "X" },
        { home: "A", away: "Y" },
      ],
    },
  };
  const ratings = { homeFieldPoints: 2.5, ratings: { A: 5, B: 0, C: 2, X: -5, Y: -2 } };
  const odds = {
    lines: {
      "1|A": line(-12, 0.78),
      "1|B": line(-3, 0.56),
      "2|C": line(-7, 0.7),
      "2|A": line(-9, 0.75),
    },
    scores: { "1|A": 14, "1|B": -3 },
  };
  const rows = walkForwardFit({
    schedule,
    odds,
    stats: { games: { "1|A": { margin: 10 } } },
    ratings,
    params: null,
  });
  assert.equal(rows.length, 1, "one week can be held out");
  assert.equal(rows[0].week, 2);
  for (const field of ["shipped", "fit", "noMargins", "noEfficiency"]) {
    assert.ok(Number.isFinite(rows[0][field]), `${field} is measured`);
  }
}

// Each league's history file, when present, is a real archive: thousands of
// games, spreads that predict margins, and a model that beats the old curve.
for (const league of LEAGUE_IDS) {
  let history = null;
  try {
    history = JSON.parse(
      await readFile(new URL(`../data/${league}/history.json`, import.meta.url), "utf8"),
    );
  } catch {
    continue;
  }
  const games = expandHistory(history);
  assert.ok(games.length > 3000, `${league}: history holds thousands of games (${games.length})`);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const game of games) {
    sxy += game.spread * game.margin;
    sxx += game.spread * game.spread;
    syy += game.margin * game.margin;
  }
  const correlation = sxy / Math.sqrt(sxx * syy);
  assert.ok(
    correlation < -0.35,
    `${league}: spreads predict margins (r = ${correlation.toFixed(2)})`,
  );

  const calibration = JSON.parse(
    await readFile(new URL(`../data/${league}/calibration.json`, import.meta.url), "utf8"),
  );
  const model = resolveModel(calibration);
  const fitted = scoreModel(games, model);
  assert.ok(
    fitted.logLoss <= calibration.report.legacyCurve.logLoss + 1e-6,
    `${league}: the calibrated model does not lose to the legacy curve`,
  );
  // A touchdown favourite is priced the way the league's history says.
  const p7 = winProbFromSpread(-7, model);
  assert.ok(p7 > 0.65 && p7 < 0.78, `${league}: a -7 favourite wins ${(p7 * 100).toFixed(1)}%`);
}

console.log(
  "Calibration OK: a known sigma and slope are recovered, the moneyline earns weight only when " +
    "informative, projection error grows with the horizon, scoring behaves, history round-trips, " +
    "the season backtest reads snapshots, and each league's model beats the curve it replaced.",
);
