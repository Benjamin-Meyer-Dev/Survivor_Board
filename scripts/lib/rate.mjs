/**
 * Team ratings fitted from what the daily pull has actually seen.
 *
 * The board prices the current week off the market and every week after it off
 * power ratings (see core/probability.js projectSpread). Those ratings shipped
 * once, before the season, and never moved - so the optimiser planned weeks 2
 * to 13 on numbers that knew nothing about the season being played. This is
 * what moves them.
 *
 * Three kinds of observation, all from data the refresh job collects:
 *
 *   1. A market line we pulled. `odds.json` accumulates them - the keys are
 *      "<week>|<team>" and old weeks are never dropped - so by mid-season
 *      there is a line for every eligible team in every week played. A line is
 *      the market's own view of one matchup, which already has every result so
 *      far priced into it. This is the strong signal.
 *   2. A final margin. Worth much less on its own: the spread of a single
 *      game's margin around its expectation is a couple of touchdowns, so one
 *      blowout says far less about a team than a fresh line does. It earns its
 *      place by being early - margins land on Saturday night, the next week's
 *      lines are not posted until midweek, and the days in between are exactly
 *      when the plan for the rest of the season wants re-checking.
 *   3. An efficiency margin, when a stats pull is on disk (data/<league>/
 *      stats.json, see scripts/lib/stats.mjs): the same game read through
 *      expected points added per play rather than the scoreboard, which strips
 *      out the fumble that bounced the wrong way and the punt-return score. It
 *      is on the points scale, so it enters the same equation as a margin, and
 *      it is the layer the advanced statistics live in - separately weighted,
 *      separately measurable, and absent without changing anything else.
 *
 * A line and a margin say the same kind of thing - how many points better one
 * team is than another, at a given site - so both become one equation:
 *
 *   rating[team] - rating[opponent] + homeField = expected margin
 *
 * Those equations are pairwise, and the board needs absolute numbers to price
 * a matchup nobody has posted a line for. Solving the set for the ratings that
 * best explain them is what turns "the market had Iowa by 10 at home" into a
 * number that can price Iowa at Nebraska in week 9. Strength of schedule falls
 * out of it: beating a team the market rates highly moves a rating more than
 * beating one it does not, because both sides of every game are solved at once.
 *
 * The weights are parameters, not constants. `DEFAULT_RATING_PARAMS` is the
 * starting point; `scripts/calibrate.mjs` tunes them walk-forward on the
 * league's history (fit on the weeks before, price the week after, keep what
 * priced it best) and writes the result to data/<league>/calibration.json,
 * which the refresh job reads. Pure and environment-free, so the refresh job,
 * the calibration and the tests share it.
 */

/**
 * The weights the fit runs with when a league's calibration.json names none.
 *
 *   marketWeight     Weight of one market line. The unit the others are in.
 *   resultWeight     One final margin, against a line's 1. Deliberately
 *                    modest: a margin is noisy, and within days the market has
 *                    read the same game and posted a line that supersedes it.
 *   efficiencyWeight One efficiency margin. Less noisy than the scoreboard, so
 *                    it earns a little more than a raw margin, still well short
 *                    of a line.
 *   decay            Share of its weight an observation keeps per week of age.
 *                    Teams are not the same in November as in September; at
 *                    0.85 a five-week-old line counts about half a fresh one.
 *   marginCap        Margins are capped here, in points, before use. Running
 *                    up 70 does not make a team 70 points better than its
 *                    opponent, it makes the last quarter meaningless.
 *   anchor           Pull of a team's starting rating, in market lines, when
 *                    the season opens. Not a preseason blend: pairwise
 *                    observations fix the gaps between teams but not the
 *                    level they all sit at, so something has to pin that, and
 *                    a team with one observation should not be defined by it.
 *                    At 0.35 the first line a team gets moves it three
 *                    quarters of the way (see scripts/validate-ratings-fit.mjs).
 *                    A prior as good as the market itself earns far more; a
 *                    published preseason rating earns less.
 *   anchorHalfLife   Weeks over which that pull halves. A preseason rating is
 *                    as good as it will ever be in week 1 and drifts from the
 *                    truth after that, so the pull toward it fades: at age t
 *                    weeks it is anchor / (1 + t / anchorHalfLife). Zero keeps
 *                    it constant. The calibration sets it from the prior's
 *                    own error and how fast ratings drift.
 */
export const DEFAULT_RATING_PARAMS = Object.freeze({
  marketWeight: 1,
  resultWeight: 0.35,
  efficiencyWeight: 0.45,
  decay: 0.85,
  marginCap: 24,
  anchor: 0.35,
  anchorHalfLife: 0,
});

/** The pull toward the prior after `age` weeks of season, given the params. */
export function anchorAt(params, age) {
  const { anchor, anchorHalfLife } = resolveRatingParams(params);
  if (!(anchorHalfLife > 0) || !(age > 0)) return anchor;
  return anchor / (1 + age / anchorHalfLife);
}

/** Fill in whatever a calibration file leaves out. */
export function resolveRatingParams(params) {
  if (!params) return DEFAULT_RATING_PARAMS;
  const out = { ...DEFAULT_RATING_PARAMS };
  for (const key of Object.keys(DEFAULT_RATING_PARAMS)) {
    if (Number.isFinite(params[key])) out[key] = params[key];
  }
  return Object.freeze(out);
}

/** Iterations of the solver, and the movement at which it stops early. */
const MAX_PASSES = 400;
const TOLERANCE = 0.0005;

/**
 * Everything one pull knows about one game, as an equation.
 *
 * @typedef {{a:string, b:string, hfa:number, value:number, weight:number,
 *            kind:"market"|"result"|"efficiency", week:number}} Observation
 *   `a` is the team the value is from the point of view of: value is how many
 *   points better than `b` this game says it is, before home field.
 */

/**
 * Turn a league's accumulated pulls into observations.
 *
 * @param {object} args
 * @param {object} args.schedule data/<league>/schedule.json
 * @param {object} args.lines    odds.json `lines`, keyed "<week>|<team>"
 * @param {object} args.scores   odds.json `scores`, signed margins by the same key
 * @param {object} [args.stats]  stats.json `games`, `{margin}` by the same key
 * @param {object} args.base     Starting ratings, and the FBS membership test
 * @param {number} args.homeFieldPoints
 * @param {number} args.throughWeek The week the league is on, for recency
 * @param {object} [args.params] Weights, see DEFAULT_RATING_PARAMS
 * @returns {Observation[]}
 */
export function observationsFrom({
  schedule,
  lines = {},
  scores = {},
  stats = {},
  base,
  homeFieldPoints = 2.5,
  throughWeek = 1,
  params = DEFAULT_RATING_PARAMS,
}) {
  const weights = resolveRatingParams(params);
  const observations = [];
  const cap = (value) => Math.max(-weights.marginCap, Math.min(weights.marginCap, value));

  for (const [weekKey, games] of Object.entries(schedule.weeks ?? {})) {
    const week = Number(weekKey);
    // A week yet to be played has neither margins nor, beyond the current one,
    // lines. Ageing is measured from the week the league is on.
    const age = Math.max(0, throughWeek - week);
    const recency = weights.decay ** age;

    for (const game of games) {
      const { home, away } = game;
      // Both ends need a rating to be solved for. An opponent missing from the
      // base map is outside the league we price - FCS, in college - and its
      // game says nothing we can use.
      if (!(home in base) || !(away in base)) continue;

      const hfa = game.neutral ? 0 : homeFieldPoints;

      // One equation per game per kind, from the home team's point of view.
      // Both sides of a conference game are priced, and the two lines are the
      // same fact mirrored, so taking one keeps a divisional game from
      // counting double against a non-conference one.
      const homeLine = lines[key(week, home)];
      const awayLine = lines[key(week, away)];
      const market =
        homeLine?.source === "market"
          ? -homeLine.spread
          : awayLine?.source === "market"
            ? awayLine.spread
            : null;

      if (market !== null) {
        observations.push({
          a: home,
          b: away,
          hfa,
          value: market,
          weight: weights.marketWeight * recency,
          kind: "market",
          week,
        });
      }

      const margin = sided(scores[key(week, home)], scores[key(week, away)]);
      if (margin !== null) {
        observations.push({
          a: home,
          b: away,
          hfa,
          value: cap(margin),
          weight: weights.resultWeight * recency,
          kind: "result",
          week,
        });
      }

      const efficiency = sided(stats[key(week, home)]?.margin, stats[key(week, away)]?.margin);
      if (efficiency !== null && weights.efficiencyWeight > 0) {
        observations.push({
          a: home,
          b: away,
          hfa,
          value: cap(efficiency),
          weight: weights.efficiencyWeight * recency,
          kind: "efficiency",
          week,
        });
      }
    }
  }

  return observations;
}

/** A signed number recorded from either team's side, read from the home side. */
function sided(fromHome, fromAway) {
  if (typeof fromHome === "number" && Number.isFinite(fromHome)) return fromHome;
  if (typeof fromAway === "number" && Number.isFinite(fromAway)) return -fromAway;
  return null;
}

/**
 * Solve the observations for the ratings that best explain them.
 *
 * Weighted least squares with a pull toward each team's starting rating,
 * solved by cycling over the teams rather than with a matrix: a few hundred
 * teams and a few hundred equations converge in milliseconds, and it keeps
 * this file dependency-free like the rest of the repo.
 *
 * @param {object} args
 * @param {Observation[]} args.observations
 * @param {object} args.base Starting ratings by team.
 * @param {object} [args.params]
 * @returns {{ratings:Object<string,number>, observations:Object<string,number>,
 *            games:number, passes:number}} `ratings` holds only the teams the
 *   pull has actually seen; everyone else keeps the rating they came with, so
 *   the caller can treat the result as an overlay.
 */
export function solveRatings({
  observations,
  base,
  params = DEFAULT_RATING_PARAMS,
  throughWeek = 1,
}) {
  // The prior is a week old for every week the season has played past the
  // first, and its pull fades with that age (see anchorHalfLife).
  const anchor = anchorAt(params, Math.max(0, throughWeek - 1));

  // Which equations touch each team, so a pass over one team is local.
  const touching = new Map();
  for (const observation of observations) {
    for (const team of [observation.a, observation.b]) {
      if (!touching.has(team)) touching.set(team, []);
      touching.get(team).push(observation);
    }
  }

  const rating = {};
  for (const team of touching.keys()) rating[team] = base[team];

  // Sorted, so the sweep order - and therefore the answer - does not depend on
  // the order the schedule happened to list its games in.
  const teams = [...touching.keys()].sort();

  let passes = 0;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    passes = pass + 1;
    let moved = 0;

    for (const team of teams) {
      let numerator = anchor * base[team];
      let denominator = anchor;

      for (const observation of touching.get(team)) {
        const { a, b, hfa, value, weight } = observation;
        // Rearranged for whichever side this team is: the equation is
        // rating[a] - rating[b] + hfa = value.
        const target = team === a ? value + ratingOf(b) - hfa : ratingOf(a) + hfa - value;
        numerator += weight * target;
        denominator += weight;
      }

      const next = numerator / denominator;
      moved = Math.max(moved, Math.abs(next - rating[team]));
      rating[team] = next;
    }

    if (moved < TOLERANCE) break;
  }

  const counts = {};
  const ratings = {};
  for (const team of teams) {
    counts[team] = touching.get(team).length;
    ratings[team] = Number(rating[team].toFixed(2));
  }

  return {
    ratings,
    observations: counts,
    games: observations.length,
    passes,
  };

  /** A team with no equations of its own is fixed at the rating it came with. */
  function ratingOf(team) {
    return rating[team] ?? base[team];
  }
}

/**
 * One league's fitted ratings, ready to write to data/<league>/form.json.
 *
 * @param {object} args As observationsFrom, plus `updatedAt` for the file.
 * @returns {object} The form document, or null when the pull has seen nothing
 *   yet - there is no point writing a file that says only "no data".
 */
export function fitForm({
  schedule,
  lines,
  scores,
  stats,
  base,
  homeFieldPoints = 2.5,
  throughWeek = 1,
  params = DEFAULT_RATING_PARAMS,
  updatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
}) {
  const weights = resolveRatingParams(params);
  const observations = observationsFrom({
    schedule,
    lines,
    scores,
    stats,
    base,
    homeFieldPoints,
    throughWeek,
    params: weights,
  });
  if (observations.length === 0) return null;

  const solved = solveRatings({ observations, base, params: weights, throughWeek });
  const count = (kind) => observations.filter((o) => o.kind === kind).length;

  return {
    $comment:
      "Written by .github/workflows/refresh-odds.yml. Never edit by hand - your change " +
      "will be overwritten on the next run. Ratings fitted to the market lines, final " +
      "margins and efficiency margins the daily pull has collected, and used to price the " +
      "weeks the market has not posted yet. Teams the pull has not seen are absent and keep " +
      "their ratings.json value.",
    updatedAt,
    throughWeek,
    homeFieldPoints,
    params: weights,
    fit: {
      marketLines: count("market"),
      margins: count("result"),
      efficiency: count("efficiency"),
      teams: Object.keys(solved.ratings).length,
      passes: solved.passes,
    },
    observations: solved.observations,
    ratings: solved.ratings,
  };
}

/**
 * Does the fit actually predict better than the ratings the league shipped
 * with? Fit everything up to the most recent week that has lines, then score
 * both against that week - which the fit has never seen.
 *
 * This is the number that matters. Explaining lines you were fitted to is easy
 * and means nothing; pricing next week's game before the market does is the
 * whole job. The refresh run logs it, and flags the fit when it loses, so a
 * model quietly going wrong says so rather than being taken on trust.
 *
 * @returns {{week:number, fitted:number, base:number, count:number}|null} Null
 *   until two weeks have been pulled, when there is nothing to hold out.
 */
export function holdoutError({
  schedule,
  lines = {},
  scores = {},
  stats = {},
  base,
  homeFieldPoints = 2.5,
  params = DEFAULT_RATING_PARAMS,
}) {
  const priced = [
    ...new Set(
      Object.entries(lines)
        .filter(([, line]) => line?.source === "market")
        .map(([lineKey]) => Number(lineKey.split("|")[0])),
    ),
  ].sort((a, b) => a - b);
  if (priced.length < 2) return null;

  const week = priced.at(-1);
  const keep = (map, predicate) =>
    Object.fromEntries(
      Object.entries(map ?? {}).filter(([mapKey]) => predicate(Number(mapKey.split("|")[0]))),
    );

  // Everything the pull knew before that week: its lines and, since a margin
  // arrives after its own week's lines, its margins too.
  const fitted = fitForm({
    schedule,
    lines: keep(lines, (w) => w < week),
    scores: keep(scores, (w) => w < week),
    stats: keep(stats, (w) => w < week),
    base,
    homeFieldPoints,
    throughWeek: week - 1,
    params,
  });
  if (!fitted) return null;

  const held = keep(lines, (w) => w === week);
  const withFit = marketError({
    schedule,
    lines: held,
    base,
    overlay: fitted.ratings,
    homeFieldPoints,
  });
  const withBase = marketError({ schedule, lines: held, base, homeFieldPoints });
  if (!withFit || !withBase) return null;

  return { week, fitted: withFit.mae, base: withBase.mae, count: withFit.count };
}

/** The key `lines`, `scores` and `stats` all use. */
function key(week, team) {
  return `${week}|${team}`;
}

/**
 * How well a set of ratings explains the market lines in a pull, as the mean
 * absolute error in points. The refresh job logs the before and after so a run
 * says whether the fit is actually earning its place.
 *
 * @returns {{mae:number, count:number}|null} Null when there is nothing priced.
 */
export function marketError({ schedule, lines, base, overlay = {}, homeFieldPoints = 2.5 }) {
  const errors = [];

  for (const [weekKey, games] of Object.entries(schedule.weeks ?? {})) {
    const week = Number(weekKey);
    for (const game of games) {
      const { home, away } = game;
      if (!(home in base) || !(away in base)) continue;

      const line = lines?.[key(week, home)];
      const mirrored = lines?.[key(week, away)];
      const market =
        line?.source === "market"
          ? -line.spread
          : mirrored?.source === "market"
            ? mirrored.spread
            : null;
      if (market === null) continue;

      const rating = (team) => overlay[team] ?? base[team];
      const expected = rating(home) - rating(away) + (game.neutral ? 0 : homeFieldPoints);
      errors.push(Math.abs(expected - market));
    }
  }

  if (errors.length === 0) return null;
  return {
    mae: Number((errors.reduce((total, error) => total + error, 0) / errors.length).toFixed(2)),
    count: errors.length,
  };
}
