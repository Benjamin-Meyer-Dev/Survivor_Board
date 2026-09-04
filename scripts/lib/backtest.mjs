/**
 * The season's own backtest: what the board said, against what happened.
 *
 * The calibration (scripts/lib/calibrate.mjs) answers from history; this
 * answers from the season under way, as it accumulates, and it can only
 * because the refresh job keeps an immutable snapshot of every run
 * (data/<league>/snapshots/). Three questions:
 *
 *   1. Were the win probabilities the board showed right? Every market line in
 *      every snapshot whose game has since been played is a forecast, scored
 *      by log loss and Brier and laid out by band, closing lines and opening
 *      lines apart, against the spread-only model and the old curve.
 *   2. Did the projections the board planned on hold up? Each snapshot carries
 *      the fitted ratings of its day; the spreads they imply for the weeks
 *      ahead are compared with the lines those weeks eventually closed at, by
 *      weeks ahead, against the horizon curve the calibration promised.
 *   3. Did the rating fit earn its place? Week by week, the fit through the
 *      weeks before prices the week after, against the ratings the league
 *      shipped with and against itself without margins and without the
 *      efficiency layer, so each layer's contribution is measured rather than
 *      assumed.
 *
 * And the coach's own record: which calls the frontier made and how they went.
 *
 * Pure and environment-free: scripts/backtest.mjs reads the files and prints.
 */

import {
  winProbFromSpread,
  marketWinProb,
  resolveModel,
  horizonVariance,
} from "../../src/js/core/probability.js";
import { fitForm, marketError, resolveRatingParams } from "./rate.mjs";
import { score, legacyWinProb } from "./calibrate.mjs";

/** "<week>|<team>" apart. */
function splitKey(key) {
  const [week, team] = key.split("|");
  return { week: Number(week), team };
}

/**
 * The forecasts the board made for games now decided, one per (week, team),
 * from the last snapshot that priced the line (closing) and the first
 * (opening).
 *
 * @param {Array<object>} snapshots Sorted by `at`.
 * @param {object} results odds.json `results`.
 * @param {object} model
 * @returns {{closing:object, opening:object, spreadOnly:object, legacy:object,
 *            moneylineOnly:object, n:number}}
 */
export function scoreSeasonLines(snapshots, results, model) {
  const first = new Map();
  const last = new Map();
  for (const snapshot of snapshots) {
    for (const [key, line] of Object.entries(snapshot.lines ?? {})) {
      if (line?.source !== "market") continue;
      if (!first.has(key)) first.set(key, line);
      last.set(key, line);
    }
  }

  const decided = (map) => {
    const rows = [];
    for (const [key, line] of map) {
      const result = results?.[key];
      if (result !== "W" && result !== "L") continue;
      rows.push({ key, line, won: result === "W" });
    }
    return rows;
  };

  const closing = decided(last);
  const opening = decided(first);
  const withProb = (rows, probabilityOf) =>
    score(rows.map(({ line, won }) => ({ p: probabilityOf(line), won })));

  return {
    n: closing.length,
    closing: withProb(closing, (line) => line.winProb),
    opening: withProb(opening, (line) => line.winProb),
    spreadOnly: withProb(closing, (line) =>
      winProbFromSpread(line.spread, model, { total: line.total ?? null }),
    ),
    moneylineOnly: withProb(
      closing.filter(({ line }) => Number.isFinite(line.moneylineProb)),
      (line) => line.moneylineProb,
    ),
    legacy: withProb(closing, (line) => legacyWinProb(line.spread)),
    blend: withProb(closing, (line) =>
      marketWinProb({
        spread: line.spread,
        total: line.total ?? null,
        moneylineProb: line.moneylineProb ?? null,
        model,
      }),
    ),
  };
}

/**
 * How far the projections the board planned on missed the lines the market
 * eventually closed at, by weeks ahead.
 *
 * Each snapshot's fitted ratings project every game in the weeks after the
 * snapshot's week; the closing line is the last snapshot's line for that game,
 * where there is one.
 */
export function scoreSeasonProjections({ snapshots, schedule, ratings, model }) {
  const closing = new Map();
  for (const snapshot of snapshots) {
    for (const [key, line] of Object.entries(snapshot.lines ?? {})) {
      if (line?.source === "market") closing.set(key, line.spread);
    }
  }
  const homeFieldPoints = ratings.homeFieldPoints ?? 2.5;
  const byHorizon = new Map();

  for (const snapshot of snapshots) {
    const overlay = snapshot.form?.ratings ?? {};
    const rating = (team) => overlay[team] ?? ratings.ratings[team];
    for (const [weekKey, games] of Object.entries(schedule.weeks ?? {})) {
      const week = Number(weekKey);
      const h = week - snapshot.week;
      if (h < 1) continue;
      for (const game of games) {
        if (!(game.home in ratings.ratings) || !(game.away in ratings.ratings)) continue;
        const market = closing.has(`${week}|${game.home}`)
          ? closing.get(`${week}|${game.home}`)
          : closing.has(`${week}|${game.away}`)
            ? -closing.get(`${week}|${game.away}`)
            : null;
        if (market === null) continue;
        const expected =
          rating(game.home) - rating(game.away) + (game.neutral ? 0 : homeFieldPoints);
        const error = -expected - market;
        (byHorizon.get(h) ?? byHorizon.set(h, []).get(h)).push(error);
      }
    }
  }

  const rows = [];
  for (const h of [...byHorizon.keys()].sort((a, b) => a - b)) {
    const errors = byHorizon.get(h);
    const mse = errors.reduce((total, e) => total + e * e, 0) / errors.length;
    rows.push({
      h,
      n: errors.length,
      mae: round(errors.reduce((total, e) => total + Math.abs(e), 0) / errors.length, 2),
      rmse: round(Math.sqrt(mse), 2),
      promised: round(Math.sqrt(horizonVariance(h, model)), 2),
    });
  }
  return rows;
}

/**
 * Week by week, does the fit through the weeks before price the week after
 * better than the shipped ratings, and what does each layer add?
 *
 * @returns {Array<{week:number, n:number, shipped:number, fit:number,
 *   noMargins:number, noEfficiency:number}>}
 */
export function walkForwardFit({ schedule, odds, stats, ratings, params }) {
  const weights = resolveRatingParams(params);
  const priced = [
    ...new Set(
      Object.entries(odds.lines ?? {})
        .filter(([, line]) => line?.source === "market")
        .map(([key]) => splitKey(key).week),
    ),
  ].sort((a, b) => a - b);

  const keep = (map, predicate) =>
    Object.fromEntries(Object.entries(map ?? {}).filter(([key]) => predicate(splitKey(key).week)));
  const homeFieldPoints = ratings.homeFieldPoints ?? 2.5;
  const rows = [];

  for (const week of priced) {
    if (week === priced[0]) continue;
    const held = keep(odds.lines, (w) => w === week);
    const inputs = {
      schedule,
      lines: keep(odds.lines, (w) => w < week),
      scores: keep(odds.scores, (w) => w < week),
      stats: keep(stats?.games ?? {}, (w) => w < week),
      base: ratings.ratings,
      homeFieldPoints,
      throughWeek: week - 1,
    };
    const errorWith = (overlay) =>
      marketError({ schedule, lines: held, base: ratings.ratings, overlay, homeFieldPoints });

    const full = fitForm({ ...inputs, params: weights });
    const noMargins = fitForm({ ...inputs, params: { ...weights, resultWeight: 0 } });
    const noEfficiency = fitForm({ ...inputs, params: { ...weights, efficiencyWeight: 0 } });
    const shipped = errorWith({});
    if (!shipped) continue;
    rows.push({
      week,
      n: shipped.count,
      shipped: shipped.mae,
      fit: full ? errorWith(full.ratings).mae : null,
      noMargins: noMargins ? errorWith(noMargins.ratings).mae : null,
      noEfficiency: noEfficiency ? errorWith(noEfficiency.ratings).mae : null,
    });
  }
  return rows;
}

/**
 * The coach's record: the call each week's closing snapshot made, and how it
 * went.
 */
export function coachRecord(snapshots, results) {
  const closingByWeek = new Map();
  for (const snapshot of snapshots) closingByWeek.set(snapshot.week, snapshot);
  const rows = [];
  for (const [week, snapshot] of [...closingByWeek.entries()].sort((a, b) => a[0] - b[0])) {
    const frontier = snapshot.recommendation?.frontier;
    const call = frontier?.candidates?.find((candidate) => candidate.chosen);
    const teams = call?.teams ?? snapshot.recommendation?.picks?.[week] ?? [];
    if (!teams.length) continue;
    const outcomes = teams.map((team) => results?.[`${week}|${team}`] ?? null);
    rows.push({
      week,
      teams,
      weekWinProb: call?.weekWinProb ?? null,
      outcome: outcomes.every((o) => o === "W")
        ? "W"
        : outcomes.some((o) => o === "L")
          ? "L"
          : null,
    });
  }
  return rows;
}

/** Whole report for one league. */
export function backtest({ snapshots, odds, schedule, ratings, stats, calibration }) {
  const model = resolveModel(calibration);
  const sorted = [...snapshots].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return {
    snapshots: sorted.length,
    lines: scoreSeasonLines(sorted, odds.results ?? {}, model),
    projections: scoreSeasonProjections({ snapshots: sorted, schedule, ratings, model }),
    fit: walkForwardFit({ schedule, odds, stats, ratings, params: calibration?.rating }),
    coach: coachRecord(sorted, odds.results ?? {}),
  };
}

function round(value, places) {
  return Number(value.toFixed(places));
}
