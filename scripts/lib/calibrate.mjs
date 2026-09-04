/**
 * Calibration of the probability model and the rating fit against history.
 *
 * Everything the board turns into a probability is a parameter here, and each
 * is fitted to the league's own past rather than set by hand:
 *
 *   margin    How margins scatter around the closing spread, and whether that
 *             scatter grows with the spread or the total. This is the curve a
 *             spread becomes a win probability through (core/probability.js).
 *   moneyline How much a de-vigged moneyline should count against the spread
 *             when a line carries both.
 *   horizon   How far a projection from fitted ratings misses the line the
 *             market eventually closes at, by weeks ahead - the uncertainty a
 *             projected week carries that a priced one does not - and how much
 *             of that miss belongs to the team rather than the game.
 *   rating    The weights the rating fit runs with, chosen walk-forward: fit on
 *             the weeks before, price the week after, keep what prices best.
 *
 * The tests are all out of sample by construction. A curve is scored on games
 * it was not fitted to only in the sense that the fit has three parameters and
 * thousands of games; the rating and horizon studies never see the week they
 * are scored on. Pure and environment-free: scripts/calibrate.mjs drives it,
 * scripts/validate-calibration.mjs checks it on a league whose answers are
 * known.
 */

import {
  DEFAULT_MODEL,
  resolveModel,
  winProbFromSpread,
  marginSigma,
  marketWinProb,
  normalCdf,
  clampProbability,
} from "../../src/js/core/probability.js";
import { DEFAULT_RATING_PARAMS, resolveRatingParams, fitForm } from "./rate.mjs";

/**
 * Bands the calibration is reported in. A survivor pool lives in the top ones,
 * so they are narrower there.
 */
export const BANDS = Object.freeze([
  0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.93, 0.95, 0.97, 0.98, 0.99, 1.0001,
]);

// ---------------------------------------------------------------------------
// The margin model.
// ---------------------------------------------------------------------------

/**
 * Fit sigma(spread, total) to a league's games.
 *
 * Two stages. The margins themselves fix the scale: each game's residual
 * (margin minus what the spread expected) is a draw from a normal whose
 * standard deviation the model gives, and the parameters that make those
 * draws most likely are found by coordinate search. Then the parameters are
 * nudged to make the wins and losses themselves most likely, because that is
 * what the board is scored on: a normal is a little thin in the tails, and the
 * second stage widens sigma exactly where the tails decide, on big favourites.
 *
 * @param {Array<object>} games Expanded history records.
 * @param {{totals?:boolean, referenceTotal?:number}} options `totals` false
 *   fixes totalSlope at zero, for a league whose totals are not priced.
 * @returns {{margin:object, stages:{fromMargins:object, fromResults:object}}}
 */
export function fitMarginModel(games, { totals = true, referenceTotal = null } = {}) {
  const usable = games.filter(
    (game) => Number.isFinite(game.spread) && Number.isFinite(game.margin),
  );
  const decided = usable.filter((game) => game.margin !== 0);
  const withTotals = totals ? usable.filter((game) => Number.isFinite(game.total)) : [];
  const reference =
    referenceTotal ??
    (withTotals.length
      ? round(mean(withTotals.map((game) => game.total)), 1)
      : DEFAULT_MODEL.referenceTotal);

  const modelFor = (sigma, slope, totalSlope) =>
    resolveModel({ margin: { sigma, slope, totalSlope, referenceTotal: reference, maxSigma: 40 } });

  // Stage one: the normal likelihood of the residuals.
  const marginObjective = ([sigma, slope, totalSlope]) => {
    const model = modelFor(sigma, slope, totalSlope);
    let total = 0;
    for (const game of usable) {
      const s = marginSigma(game.spread, model, game.total);
      const residual = game.margin + game.spread;
      total += -Math.log(s) - (residual * residual) / (2 * s * s);
    }
    return total;
  };
  // A total can widen the scatter, never narrow it: a shootout has more ways
  // to end than a slog. The bound keeps a small sample from fitting the other
  // sign to noise, and a league whose totals do not matter lands on zero.
  const totalBounds = totals && withTotals.length ? [0, 0.3] : [0, 0];
  const fromMargins = coordinateSearch(
    marginObjective,
    [13, 0.05, 0],
    [[6, 25], [0, 0.5], totalBounds],
  );

  // Stage two: the Bernoulli likelihood of who won, from the first stage.
  const resultObjective = ([sigma, slope, totalSlope]) => {
    const model = modelFor(sigma, slope, totalSlope);
    let total = 0;
    for (const game of decided) {
      const p = winProbFromSpread(game.spread, model, { total: game.total });
      total += Math.log(game.margin > 0 ? p : 1 - p);
    }
    return total;
  };
  const fromResults = coordinateSearch(resultObjective, fromMargins.point, [
    [6, 25],
    [0, 0.5],
    totalBounds,
  ]);

  const [sigma, slope, totalSlope] = fromResults.point;
  return {
    margin: {
      sigma: round(sigma, 2),
      slope: round(slope, 3),
      totalSlope: round(totalSlope, 3),
      referenceTotal: reference,
      maxSigma: DEFAULT_MODEL.maxSigma,
    },
    stages: {
      fromMargins: {
        sigma: round(fromMargins.point[0], 2),
        slope: round(fromMargins.point[1], 3),
        totalSlope: round(fromMargins.point[2], 3),
      },
      fromResults: {
        sigma: round(sigma, 2),
        slope: round(slope, 3),
        totalSlope: round(totalSlope, 3),
      },
    },
    games: usable.length,
    decided: decided.length,
  };
}

/**
 * Maximise `objective` over a box by cycling through the coordinates with a
 * golden-section line search. Three parameters and a smooth likelihood do not
 * need more than this, and it keeps the file free of a dependency.
 */
export function coordinateSearch(objective, start, bounds, { rounds = 8, tolerance = 1e-4 } = {}) {
  const point = [...start];
  let best = objective(point);
  for (let round = 0; round < rounds; round += 1) {
    let moved = 0;
    for (let i = 0; i < point.length; i += 1) {
      const [lo, hi] = bounds[i];
      if (lo === hi) {
        point[i] = lo;
        continue;
      }
      const value = goldenSection(
        (x) => {
          const trial = [...point];
          trial[i] = x;
          return objective(trial);
        },
        lo,
        hi,
        tolerance,
      );
      moved = Math.max(moved, Math.abs(value - point[i]));
      point[i] = value;
    }
    best = objective(point);
    if (moved < tolerance) break;
  }
  return { point, value: best };
}

/** Argmax of a unimodal function on [lo, hi]. */
function goldenSection(f, lo, hi, tolerance) {
  const ratio = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  let c = b - ratio * (b - a);
  let d = a + ratio * (b - a);
  let fc = f(c);
  let fd = f(d);
  while (b - a > tolerance) {
    if (fc > fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - ratio * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + ratio * (b - a);
      fd = f(d);
    }
  }
  return (a + b) / 2;
}

// ---------------------------------------------------------------------------
// Scoring.
// ---------------------------------------------------------------------------

/**
 * How well a set of probabilities did against what happened.
 *
 * @param {Array<{p:number, won:boolean}>} forecasts From the favourite's side or
 *   any side; `won` is whether the side `p` is for came through.
 * @returns {{n:number, logLoss:number, brier:number, bands:Array}}
 */
export function score(forecasts) {
  let logLoss = 0;
  let brier = 0;
  const bands = BANDS.slice(0, -1).map((low, index) => ({
    low,
    high: BANDS[index + 1],
    n: 0,
    predicted: 0,
    actual: 0,
  }));

  for (const { p, won } of forecasts) {
    const q = clampProbability(p);
    logLoss += -Math.log(won ? q : 1 - q);
    brier += (q - (won ? 1 : 0)) ** 2;
    // Reported from the likelier side, so every band reads as "how often did
    // a favourite this strong come through".
    const side = q >= 0.5 ? q : 1 - q;
    const came = q >= 0.5 ? won : !won;
    const band = bands.find((entry) => side >= entry.low && side < entry.high);
    if (band) {
      band.n += 1;
      band.predicted += side;
      band.actual += came ? 1 : 0;
    }
  }

  const n = forecasts.length;
  return {
    n,
    logLoss: n ? round(logLoss / n, 5) : null,
    brier: n ? round(brier / n, 5) : null,
    bands: bands
      .filter((band) => band.n > 0)
      .map((band) => ({
        low: band.low,
        high: Math.min(band.high, 1),
        n: band.n,
        predicted: round(band.predicted / band.n, 4),
        actual: round(band.actual / band.n, 4),
      })),
  };
}

/**
 * Score a model's spread curve on decided games, from the home side.
 *
 * @param {Array<object>} games
 * @param {object} model
 * @param {{moneyline?:boolean}} options With `moneyline`, score the blend
 *   the ingest would have produced where a fair moneyline exists.
 */
export function scoreModel(games, model, { moneyline = false } = {}) {
  const forecasts = [];
  for (const game of games) {
    if (!Number.isFinite(game.spread) || !Number.isFinite(game.margin) || game.margin === 0)
      continue;
    const p = moneyline
      ? marketWinProb({
          spread: game.spread,
          total: game.total,
          moneylineProb: game.homeFair,
          model,
        })
      : winProbFromSpread(game.spread, model, { total: game.total });
    forecasts.push({ p, won: game.margin > 0 });
  }
  return score(forecasts);
}

/**
 * The curve the board shipped with before calibration, kept so a report can
 * say what changed. Piecewise linear over favourite win rates by spread.
 */
export function legacyWinProb(spread) {
  const CURVE = [
    [0, 0.5],
    [3, 0.59],
    [7, 0.71],
    [10, 0.78],
    [14, 0.85],
    [17, 0.89],
    [20, 0.92],
    [25, 0.95],
    [30, 0.965],
    [35, 0.975],
    [42, 0.985],
    [50, 0.99],
  ];
  const points = Math.abs(spread);
  let probability = 0.99;
  for (let i = 0; i < CURVE.length - 1; i += 1) {
    const [x0, y0] = CURVE[i];
    const [x1, y1] = CURVE[i + 1];
    if (points >= x0 && points <= x1) {
      probability = y0 + ((points - x0) / (x1 - x0)) * (y1 - y0);
      break;
    }
  }
  return spread <= 0 ? probability : 1 - probability;
}

/** Score the legacy curve the same way, for the report. */
export function scoreLegacy(games) {
  const forecasts = [];
  for (const game of games) {
    if (!Number.isFinite(game.spread) || !Number.isFinite(game.margin) || game.margin === 0)
      continue;
    forecasts.push({ p: legacyWinProb(game.spread), won: game.margin > 0 });
  }
  return score(forecasts);
}

// ---------------------------------------------------------------------------
// The moneyline.
// ---------------------------------------------------------------------------

/**
 * How much weight the de-vigged moneyline earns against the spread.
 *
 * Tried on a grid, scored by log loss on the games that have both. The answer
 * is usually well below a half: the spread is the book's sharpest number and
 * the moneyline on a big favourite is rounded and biased, so the de-vigged
 * moneyline is worth having, but not worth trusting on its own.
 *
 * @returns {{weight:number, grid:Array<{weight:number, logLoss:number}>, n:number}}
 */
export function fitMoneylineWeight(games, model) {
  const both = games.filter(
    (game) =>
      Number.isFinite(game.spread) &&
      Number.isFinite(game.homeFair) &&
      Number.isFinite(game.margin) &&
      game.margin !== 0,
  );
  const grid = [];
  for (let weight = 0; weight <= 1.0001; weight += 0.05) {
    const trial = resolveModel({
      ...model,
      margin: model,
      moneyline: { weight, cap: model.moneylineCap },
    });
    grid.push({
      weight: round(weight, 2),
      logLoss: scoreModel(both, trial, { moneyline: true }).logLoss,
    });
  }
  const best = grid.reduce((a, b) => (b.logLoss < a.logLoss ? b : a), grid[0]);
  return { weight: best.weight, grid, n: both.length };
}

// ---------------------------------------------------------------------------
// The rating fit: horizon error and parameter tuning, walk-forward.
// ---------------------------------------------------------------------------

/**
 * A history season as the inputs the rating fit takes: a schedule keyed by
 * week, market lines, margins and efficiency margins keyed "<week>|<home>".
 */
export function seasonInputs(games) {
  const schedule = { weeks: {} };
  const lines = {};
  const scores = {};
  const stats = {};
  const teams = new Set();
  for (const game of games) {
    const week = String(game.week);
    (schedule.weeks[week] ??= []).push({
      home: game.home,
      away: game.away,
      neutral: game.neutral === 1,
    });
    lines[`${game.week}|${game.home}`] = { spread: game.spread, source: "market" };
    if (Number.isFinite(game.margin)) scores[`${game.week}|${game.home}`] = game.margin;
    if (Number.isFinite(game.homeEfficiency)) {
      stats[`${game.week}|${game.home}`] = { margin: game.homeEfficiency };
    }
    teams.add(game.home);
    teams.add(game.away);
  }
  return { schedule, lines, scores, stats, teams: [...teams] };
}

/** Everything before a week, out of a keyed map. */
function before(map, week) {
  return Object.fromEntries(
    Object.entries(map).filter(([mapKey]) => Number(mapKey.split("|")[0]) < week),
  );
}

/**
 * The season's own read on each team once it is over, regressed toward the
 * mean, as the prior the next season's walk-forward fits start from. The live
 * board starts from published preseason ratings, which are better than this;
 * `calibrate` measures both and scales the anchor between them.
 */
export const PRIOR_REGRESSION = 0.6;

/** A mean absolute error is this much of a standard deviation, for a normal. */
const MAE_TO_SD = Math.sqrt(Math.PI / 2);

function finalRatings(inputs, homeFieldPoints, params, teams) {
  const flat = Object.fromEntries(teams.map((team) => [team, 0]));
  const weeks = Object.keys(inputs.schedule.weeks).map(Number);
  const fitted = fitForm({
    schedule: inputs.schedule,
    lines: inputs.lines,
    scores: inputs.scores,
    stats: inputs.stats,
    base: flat,
    homeFieldPoints,
    throughWeek: Math.max(...weeks),
    params,
  });
  const ratings = fitted?.ratings ?? {};
  const level = mean(Object.values(ratings)) || 0;
  return Object.fromEntries(
    teams.map((team) => [
      team,
      ratings[team] === undefined ? 0 : (ratings[team] - level) * PRIOR_REGRESSION,
    ]),
  );
}

/**
 * Walk every season forward and record how far a projection made from the
 * ratings fitted through week w-1 missed the closing line of each game in the
 * weeks after, by horizon.
 *
 * Three more things fall out of the same walk. How far the prior itself
 * missed the opening week's lines, which is what the anchor is worth against.
 * How much worse a projection is when one of its sides has no line behind it
 * yet, which prices a team still on its preseason rating alone. And how much
 * of the error belongs to the team rather than the game.
 *
 * @param {Array<object>} games Expanded history, all seasons.
 * @param {object} options
 * @param {number} options.homeFieldPoints
 * @param {object} [options.params] Rating weights to walk with.
 * @param {number} [options.maxHorizon] Weeks ahead to project.
 * @param {number} [options.firstFitWeek] Earliest week to fit through: two
 *   means the first fit has one week of lines behind it, as the board's does.
 * @returns {{byHorizon:Array<{h:number, n:number, mae:number, rmse:number}>,
 *            horizon:{base:number, perWeek:number, teamShare:number, unseen:number},
 *            oneWeekMae:number, priorMae:number|null, seasons:number, fits:number}}
 */
export function horizonStudy(
  games,
  { homeFieldPoints = 2.5, params = DEFAULT_RATING_PARAMS, maxHorizon = 12, firstFitWeek = 2 } = {},
) {
  const weights = resolveRatingParams(params);
  const bySeason = new Map();
  for (const game of games) {
    if (!Number.isFinite(game.spread)) continue;
    (bySeason.get(game.season) ?? bySeason.set(game.season, []).get(game.season)).push(game);
  }
  const seasons = [...bySeason.keys()].sort((a, b) => a - b);

  const errors = []; // {h, e, home, away, fit, unseen}
  const priorErrors = [];
  let prior = null;
  let fits = 0;
  let seasonsUsed = 0;

  for (const season of seasons) {
    const seasonGames = bySeason.get(season);
    const inputs = seasonInputs(seasonGames);
    if (prior) {
      seasonsUsed += 1;
      const base = Object.fromEntries(inputs.teams.map((team) => [team, prior[team] ?? 0]));
      const weeks = Object.keys(inputs.schedule.weeks)
        .map(Number)
        .sort((a, b) => a - b);
      const first = weeks[0];
      const last = weeks.at(-1);

      // The prior against the opening week, before any line has moved it.
      for (const game of seasonGames) {
        if (game.week !== first) continue;
        const expected = base[game.home] - base[game.away] + (game.neutral ? 0 : homeFieldPoints);
        priorErrors.push(Math.abs(-expected - game.spread));
      }

      for (let fitWeek = firstFitWeek; fitWeek < last; fitWeek += 1) {
        const fitted = fitForm({
          schedule: inputs.schedule,
          lines: before(inputs.lines, fitWeek),
          scores: before(inputs.scores, fitWeek),
          stats: before(inputs.stats, fitWeek),
          base,
          homeFieldPoints,
          throughWeek: fitWeek - 1,
          params: weights,
        });
        if (!fitted) continue;
        fits += 1;
        const rating = (team) => fitted.ratings[team] ?? base[team];
        const seen = (team) => fitted.ratings[team] !== undefined;
        for (const game of seasonGames) {
          const h = game.week - (fitWeek - 1);
          if (h < 1 || h > maxHorizon) continue;
          const expected =
            rating(game.home) - rating(game.away) + (game.neutral ? 0 : homeFieldPoints);
          errors.push({
            h,
            e: -expected - game.spread,
            home: game.home,
            away: game.away,
            fit: fits,
            unseen: (seen(game.home) ? 0 : 1) + (seen(game.away) ? 0 : 1),
          });
        }
      }
    }
    prior = finalRatings(inputs, homeFieldPoints, weights, inputs.teams);
  }

  // The horizon curve is for games the fit has seen both sides of; the unseen
  // term below is what a side it has not adds.
  const seenErrors = errors.filter((entry) => entry.unseen === 0);
  const byHorizon = [];
  for (let h = 1; h <= maxHorizon; h += 1) {
    const at = seenErrors.filter((entry) => entry.h === h);
    if (at.length === 0) continue;
    const squares = at.map((entry) => entry.e * entry.e);
    byHorizon.push({
      h,
      n: at.length,
      mae: round(mean(at.map((entry) => Math.abs(entry.e))), 3),
      rmse: round(Math.sqrt(mean(squares)), 3),
    });
  }

  // variance(h) = base^2 + perWeek^2 * h, by weighted least squares on the
  // per-horizon mean squared error.
  const fitLine = leastSquares(byHorizon.map((row) => [row.h, row.rmse * row.rmse, row.n]));
  const base = Math.sqrt(Math.max(0, fitLine.intercept));
  const perWeek = Math.sqrt(Math.max(0, fitLine.slope));

  // Per side the fit has not seen: the extra mean squared error a week out.
  const mse = (list) => (list.length ? mean(list.map((entry) => entry.e * entry.e)) : null);
  const seenNext = mse(seenErrors.filter((entry) => entry.h === 1));
  const oneUnseen = mse(errors.filter((entry) => entry.h === 1 && entry.unseen === 1));
  const unseen =
    seenNext !== null && oneUnseen !== null ? Math.max(0, round(oneUnseen - seenNext, 2)) : 0;

  // How much of the error is the team's rather than the game's: the covariance
  // of two projections from the same fit that share a team, read from that
  // team's side, against the variance of one.
  let products = 0;
  let pairs = 0;
  const grouped = new Map();
  for (const entry of seenErrors) {
    for (const [team, sign] of [
      [entry.home, 1],
      [entry.away, -1],
    ]) {
      const groupKey = `${entry.fit}|${team}`;
      (grouped.get(groupKey) ?? grouped.set(groupKey, []).get(groupKey)).push(sign * entry.e);
    }
  }
  for (const list of grouped.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        products += list[i] * list[j];
        pairs += 1;
      }
    }
  }
  const variance = mean(seenErrors.map((entry) => entry.e * entry.e)) || 1;
  const teamShare = pairs
    ? Math.min(0.9, Math.max(0, (2 * products) / pairs / variance))
    : DEFAULT_MODEL.horizon.teamShare;

  return {
    byHorizon,
    horizon: {
      base: round(base, 2),
      perWeek: round(perWeek, 2),
      teamShare: round(teamShare, 2),
      unseen,
    },
    oneWeekMae: byHorizon[0]?.mae ?? null,
    priorMae: priorErrors.length ? round(mean(priorErrors), 3) : null,
    seasons: seasonsUsed,
    fits,
  };
}

/**
 * Choose the rating weights that price next week best, walk-forward over the
 * history. Coordinate search over a small grid: one parameter moves at a
 * time, a few rounds, the one-week-ahead mean absolute error against the
 * closing line decides. The efficiency weight is tuned only where the history
 * carries efficiency margins; the anchor's half-life is given, not searched,
 * because it follows from measured quantities (see calibrate).
 *
 * @returns {{params:object, mae:number, trials:Array<{params:object, mae:number}>}}
 */
export function tuneRatingParams(
  games,
  { homeFieldPoints = 2.5, start = DEFAULT_RATING_PARAMS, rounds = 2, anchorHalfLife = null } = {},
) {
  const GRID = {
    decay: [0.7, 0.78, 0.85, 0.92, 1],
    resultWeight: [0.1, 0.2, 0.35, 0.5, 0.75],
    anchor: [0.1, 0.2, 0.35, 0.5, 0.8, 1.2, 2],
    marginCap: [14, 21, 28, 35],
  };
  if (games.some((game) => Number.isFinite(game.homeEfficiency))) {
    GRID.efficiencyWeight = [0, 0.2, 0.45, 0.7, 1, 1.5];
  }
  const trials = [];
  const evaluate = (params) => {
    const cached = trials.find((trial) => sameParams(trial.params, params));
    if (cached) return cached.mae;
    const mae = horizonStudy(games, { homeFieldPoints, params, maxHorizon: 1 }).oneWeekMae;
    trials.push({ params: { ...params }, mae });
    return mae;
  };

  let current = { ...resolveRatingParams(start) };
  if (anchorHalfLife !== null) current.anchorHalfLife = anchorHalfLife;
  let best = evaluate(current);
  for (let round = 0; round < rounds; round += 1) {
    let moved = false;
    for (const [name, values] of Object.entries(GRID)) {
      for (const value of values) {
        const trial = { ...current, [name]: value };
        const mae = evaluate(trial);
        if (mae < best - 1e-9) {
          best = mae;
          current = trial;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return { params: current, mae: round(best, 3), trials };
}

function sameParams(a, b) {
  return Object.keys(DEFAULT_RATING_PARAMS).every((name) => a[name] === b[name]);
}

// ---------------------------------------------------------------------------
// Assembling the file.
// ---------------------------------------------------------------------------

/**
 * Everything one calibration run decides, as the document written to
 * data/<league>/calibration.json.
 *
 * The anchor needs one step the history cannot take on its own. The study's
 * prior is last season regressed toward the mean; the live board's is a
 * published preseason rating, and `livePriorMae` says how far that missed the
 * opening week's lines. The pull toward a prior is worth the inverse of its
 * error variance, so the tuned anchor is scaled by the ratio of the two, and
 * it fades over a half-life of that variance divided by how fast ratings
 * drift - both measured, neither chosen.
 *
 * @param {Array<object>} games Expanded history.
 * @param {object} options
 * @param {number} [options.homeFieldPoints]
 * @param {boolean} [options.totals]
 * @param {boolean} [options.tune]
 * @param {number|null} [options.livePriorMae] The live prior's error against
 *   the opening week's lines, in points; null keeps the history's anchor.
 * @param {Function} [options.log]
 */
export function calibrate(
  games,
  { homeFieldPoints = 2.5, totals = true, tune = true, livePriorMae = null, log = () => {} } = {},
) {
  log(`Fitting the margin model on ${games.length} games...`);
  const margin = fitMarginModel(games, { totals });
  const marginModel = resolveModel({ margin: margin.margin });

  log("Weighing the moneyline...");
  const moneyline = fitMoneylineWeight(games, marginModel);
  const model = resolveModel({
    margin: margin.margin,
    moneyline: { weight: moneyline.weight, cap: DEFAULT_MODEL.moneylineCap },
  });

  // A first walk with the defaults, for the prior's own error and the drift
  // that together set the anchor's half-life on the history.
  log("Measuring the prior and the drift...");
  const first = horizonStudy(games, { homeFieldPoints, params: DEFAULT_RATING_PARAMS });
  const historyVariance = first.priorMae ? (first.priorMae * MAE_TO_SD) ** 2 : null;
  const drift = first.horizon.perWeek > 0 ? first.horizon.perWeek ** 2 : null;
  const halfLifeHistory = historyVariance && drift ? clamp(historyVariance / drift, 0.25, 40) : 0;

  let rating = {
    params: { ...DEFAULT_RATING_PARAMS, anchorHalfLife: round(halfLifeHistory, 2) },
    mae: null,
    trials: [],
  };
  if (tune) {
    log("Tuning the rating fit walk-forward...");
    rating = tuneRatingParams(games, {
      homeFieldPoints,
      anchorHalfLife: round(halfLifeHistory, 2),
    });
  }

  log("Measuring projection error by horizon...");
  const horizon = horizonStudy(games, { homeFieldPoints, params: rating.params });

  // Scale the anchor to the live prior, and the half-life to its error.
  const prior = {
    historyMae: first.priorMae,
    liveMae: Number.isFinite(livePriorMae) ? round(livePriorMae, 3) : null,
    anchorHistory: rating.params.anchor,
    halfLifeHistory: round(halfLifeHistory, 2),
    anchorLive: rating.params.anchor,
    halfLifeLive: round(halfLifeHistory, 2),
  };
  const finalDrift = horizon.horizon.perWeek > 0 ? horizon.horizon.perWeek ** 2 : drift;
  if (Number.isFinite(livePriorMae) && livePriorMae > 0 && historyVariance && finalDrift) {
    const liveVariance = (livePriorMae * MAE_TO_SD) ** 2;
    prior.anchorLive = round(
      clamp((rating.params.anchor * historyVariance) / liveVariance, 0.05, 8),
      3,
    );
    prior.halfLifeLive = round(clamp(liveVariance / finalDrift, 0.1, 40), 2);
    // The doubt an unseen side adds is the prior's own error, so it scales the
    // same way: the history's weak prior makes an unseen team a near coin
    // flip, a published rating makes it merely uncertain.
    horizon.horizon.unseen = round((horizon.horizon.unseen * liveVariance) / historyVariance, 2);
  }
  const ratingParams = {
    ...rating.params,
    anchor: prior.anchorLive,
    anchorHalfLife: prior.halfLifeLive,
  };

  const spreadOnly = scoreModel(games, model);
  const withMoneyline = scoreModel(games, model, { moneyline: true });
  const legacy = scoreLegacy(games);

  return {
    margin: margin.margin,
    moneyline: { weight: moneyline.weight, cap: DEFAULT_MODEL.moneylineCap },
    horizon: horizon.horizon,
    rating: ratingParams,
    prior,
    report: {
      games: games.length,
      seasons: [...new Set(games.map((game) => game.season))].sort((a, b) => a - b),
      efficiencyGames: games.filter((game) => Number.isFinite(game.homeEfficiency)).length,
      margin: margin.stages,
      spreadOnly: { logLoss: spreadOnly.logLoss, brier: spreadOnly.brier },
      withMoneyline: { logLoss: withMoneyline.logLoss, brier: withMoneyline.brier, n: moneyline.n },
      legacyCurve: { logLoss: legacy.logLoss, brier: legacy.brier },
      bands: spreadOnly.bands,
      moneylineGrid: moneyline.grid,
      horizon: horizon.byHorizon,
      ratingTuning: { mae: rating.mae, trials: rating.trials.length, history: rating.params },
    },
  };
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/** Linear regression y = intercept + slope * x with weights. */
function leastSquares(rows) {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y, w] of rows) {
    sw += w;
    sx += w * x;
    sy += w * y;
    sxx += w * x * x;
    sxy += w * x * y;
  }
  const denominator = sw * sxx - sx * sx;
  if (denominator === 0) return { intercept: sy / (sw || 1), slope: 0 };
  const slope = (sw * sxy - sx * sy) / denominator;
  const intercept = (sy - slope * sx) / sw;
  return { intercept, slope };
}

export function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function round(value, places) {
  return Number(value.toFixed(places));
}

export { normalCdf };
