/**
 * Team ratings fitted from what the daily pull has actually seen.
 *
 * The board prices the current week off the market and every week after it off
 * power ratings (see core/probability.js projectSpread). Those ratings shipped
 * once, before the season, and never moved - so the optimiser planned weeks 2
 * to 13 on numbers that knew nothing about the season being played. This is
 * what moves them.
 *
 * Two kinds of observation, both from data the refresh job already collects:
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
 * Pure and environment-free, so the refresh job and the tests share it.
 */

/**
 * Weight of one market line. The unit the other weights are measured in.
 */
const MARKET_WEIGHT = 1;

/**
 * Weight of one final margin, against a market line's 1.
 *
 * Deliberately modest. A margin is noisy, and within a few days the market has
 * read the same game and posted a line that supersedes it. Enough to move a
 * rating over a weekend, not enough for one 60-point Saturday to rewrite the
 * back half of the season.
 */
const RESULT_WEIGHT = 0.35;

/**
 * How much of its weight an observation keeps per week of age.
 *
 * Teams are not the same in November as in September, so the fit leans on what
 * it saw most recently: at 0.85 a line from five weeks ago counts about half of
 * one posted this week. Without this a week-1 line would still be arguing
 * about a team in week 12.
 */
const DECAY = 0.85;

/**
 * Margins are capped before they are used, in points.
 *
 * Running up 70 does not make a team 70 points better than its opponent, it
 * makes the last quarter meaningless. The cap is where a margin stops carrying
 * information about strength.
 */
const MARGIN_CAP = 24;

/**
 * Pull of a team's starting rating, in market lines.
 *
 * Not a preseason blend. It is here for two narrower reasons: pairwise
 * observations fix the gaps between teams but not the level they all sit at,
 * so something has to pin that, and a team with one observation should not be
 * defined by it. At 0.35 the first line a team gets moves it three quarters of
 * the way and four weeks of lines carry it 83-99% of the way from a starting
 * rating that is flat wrong (see scripts/validate-ratings-fit.mjs), so within a
 * month the season's own numbers own the rating. Lower would chase noise; a
 * team the pull has never seen has no equations at all and simply keeps what it
 * came with.
 */
const ANCHOR = 0.35;

/** Iterations of the solver, and the movement at which it stops early. */
const MAX_PASSES = 400;
const TOLERANCE = 0.0005;

/**
 * Everything one pull knows about one game, as an equation.
 *
 * @typedef {{a:string, b:string, hfa:number, value:number, weight:number,
 *            kind:"market"|"result", week:number}} Observation
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
 * @param {object} args.base     Starting ratings, and the FBS membership test
 * @param {number} args.homeFieldPoints
 * @param {number} args.throughWeek The week the league is on, for recency
 * @returns {Observation[]}
 */
export function observationsFrom({
  schedule,
  lines = {},
  scores = {},
  base,
  homeFieldPoints = 2.5,
  throughWeek = 1,
}) {
  const observations = [];

  for (const [weekKey, games] of Object.entries(schedule.weeks ?? {})) {
    const week = Number(weekKey);
    // A week yet to be played has neither margins nor, beyond the current one,
    // lines. Ageing is measured from the week the league is on.
    const age = Math.max(0, throughWeek - week);
    const recency = DECAY ** age;

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
          weight: MARKET_WEIGHT * recency,
          kind: "market",
          week,
        });
      }

      const homeMargin = scores[key(week, home)];
      const awayMargin = scores[key(week, away)];
      const margin =
        typeof homeMargin === "number"
          ? homeMargin
          : typeof awayMargin === "number"
            ? -awayMargin
            : null;

      if (margin !== null) {
        observations.push({
          a: home,
          b: away,
          hfa,
          value: Math.max(-MARGIN_CAP, Math.min(MARGIN_CAP, margin)),
          weight: RESULT_WEIGHT * recency,
          kind: "result",
          week,
        });
      }
    }
  }

  return observations;
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
 * @returns {{ratings:Object<string,number>, observations:Object<string,number>,
 *            games:number, passes:number}} `ratings` holds only the teams the
 *   pull has actually seen; everyone else keeps the rating they came with, so
 *   the caller can treat the result as an overlay.
 */
export function solveRatings({ observations, base }) {
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
      let numerator = ANCHOR * base[team];
      let denominator = ANCHOR;

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
 * @param {object} args As observationsFrom, plus `source` for the note in the file.
 * @returns {object} The form document, or null when the pull has seen nothing
 *   yet - there is no point writing a file that says only "no data".
 */
export function fitForm({
  schedule,
  lines,
  scores,
  base,
  homeFieldPoints = 2.5,
  throughWeek = 1,
  updatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
}) {
  const observations = observationsFrom({
    schedule,
    lines,
    scores,
    base,
    homeFieldPoints,
    throughWeek,
  });
  if (observations.length === 0) return null;

  const solved = solveRatings({ observations, base });
  const marketCount = observations.filter((o) => o.kind === "market").length;

  return {
    $comment:
      "Written by .github/workflows/refresh-odds.yml. Never edit by hand - your change " +
      "will be overwritten on the next run. Ratings fitted to the market lines and final " +
      "margins the daily pull has collected, and used to price the weeks the market has " +
      "not posted yet. Teams the pull has not seen are absent and keep their ratings.json " +
      "value.",
    updatedAt,
    throughWeek,
    homeFieldPoints,
    fit: {
      marketLines: marketCount,
      margins: observations.length - marketCount,
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
export function holdoutError({ schedule, lines = {}, scores = {}, base, homeFieldPoints = 2.5 }) {
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
    base,
    homeFieldPoints,
    throughWeek: week - 1,
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

/** The key both `lines` and `scores` use in odds.json. */
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
