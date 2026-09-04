/**
 * Futures the season might have, for choosing a pick that holds up in most of
 * them rather than in the one the point estimates describe.
 *
 * Every week after this one is priced off a projection, and the calibration
 * says how far a projection misses the line the market eventually posts: a
 * variance that grows with the weeks ahead (core/probability.js horizonVariance)
 * and that belongs mostly to the team rather than the game (`teamShare`). A
 * team the fit has overrated is overrated in every week it plays. That is what
 * makes "save Iowa for November" a single correlated bet, and what a scenario
 * has to carry: one draw per team that moves all of its games together, plus
 * an independent draw per game.
 *
 * The draws are seeded, so the same board always produces the same futures:
 * the refresh job and the browser agree, a test can pin an answer, and the
 * recommendation does not flicker between renders.
 *
 * Pure and environment-free.
 */

import { horizonVariance, winProbFromSpread } from "./probability.js";

/**
 * How many weeks ahead a future realises the lines for. One: the week after
 * this one is priced when its pick is made, and nothing after it is.
 */
export const FORESIGHT_WEEKS = 1;

/**
 * A small, fast, seedable generator (mulberry32). Not for anything
 * cryptographic; for reproducible futures.
 *
 * @param {number} seed Any 32-bit integer.
 * @returns {() => number} Uniform on [0, 1).
 */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draws from a uniform generator, by Box-Muller. */
export function gaussianFrom(random) {
  let spare = null;
  return () => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = random();
    while (v === 0) v = random();
    const radius = Math.sqrt(-2 * Math.log(u));
    const angle = 2 * Math.PI * v;
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

/**
 * One future for the weeks given: every projected option re-priced off a
 * spread the market might actually close at.
 *
 * Market lines are left alone. A projected option's spread moves by a team
 * component - the difference of its two teams' draws, scaled to `teamShare`
 * of the horizon variance - and a game component for the rest. Both sides of
 * one game move together, in opposite directions, so the two options for a
 * game stay each other's mirror. The horizon term is then left out of the
 * re-pricing, because the draw is that uncertainty being realised.
 *
 * Only the weeks inside `foresight` are drawn. A pick is made knowing the
 * lines for the week in hand and projections for the rest, so a future in
 * which the whole season's lines are known and the season re-planned around
 * them overstates how much a team kept in hand is worth: it credits foresight
 * nobody has. With a foresight of one, the future realises next week's lines,
 * the weeks after keep their projections (already widened for their horizon),
 * and re-planning inside the future is the re-planning a real week allows.
 *
 * @param {object} args
 * @param {Array<{week:number, options:Array<object>}>} args.weeks Weeks to
 *   perturb. Each option needs `team`, `opponent`, `spread`, `source` and
 *   `weeksAhead` (see core/plan.js weekOptions); `total` is used if present.
 * @param {object} args.model From resolveModel().
 * @param {() => number} args.random A seeded uniform generator.
 * @param {number} [args.foresight] Weeks ahead whose lines the future realises.
 * @returns {Array<{week:number, options:Array<object>}>} The same shape, with
 *   `winProb` replaced by the scenario's and `spread` by the drawn spread.
 */
export function perturbWeeks({ weeks, model, random, foresight = FORESIGHT_WEEKS }) {
  const gaussian = gaussianFrom(random);
  const teamDraw = new Map();
  const drawFor = (team) => {
    if (!teamDraw.has(team)) teamDraw.set(team, gaussian());
    return teamDraw.get(team);
  };
  const { teamShare } = model.horizon;

  return weeks.map((week) => {
    const gameDraw = new Map();
    const options = week.options.map((option) => {
      if (option.source === "market" || !(option.weeksAhead > 0)) return option;
      if (option.weeksAhead > foresight) return option;
      const variance = horizonVariance(option.weeksAhead, model, option.unseenSides ?? 0);
      if (variance <= 0) return option;

      // One draw per game, keyed on the pair, handed out with the sign of the
      // side asking for it.
      const gameKey = [option.team, option.opponent].sort().join("|");
      if (!gameDraw.has(gameKey)) gameDraw.set(gameKey, gaussian());
      const sign = option.team < option.opponent ? 1 : -1;

      const teamPart = Math.sqrt((teamShare * variance) / 2);
      const gamePart = Math.sqrt((1 - teamShare) * variance);
      // A team drawn better than rated is favoured by more, so its spread
      // moves down; its opponent's draw moves it the other way.
      const error =
        teamPart * (drawFor(option.opponent) - drawFor(option.team)) +
        gamePart * sign * gameDraw.get(gameKey);
      const spread = option.spread + error;

      return {
        ...option,
        spread,
        winProb: winProbFromSpread(spread, model, { total: option.total ?? null }),
      };
    });
    return { ...week, options };
  });
}

/**
 * `count` futures for the weeks given, all from one seed, so every candidate
 * pick is judged against the same set of them (common random numbers keep
 * the comparison between candidates far steadier than the futures themselves).
 */
export function scenarioSet({ weeks, model, count, seed = 20260904, foresight = FORESIGHT_WEEKS }) {
  const scenarios = [];
  for (let index = 0; index < count; index += 1) {
    const random = seededRandom(seed + index * 7919);
    scenarios.push(perturbWeeks({ weeks, model, random, foresight }));
  }
  return scenarios;
}
