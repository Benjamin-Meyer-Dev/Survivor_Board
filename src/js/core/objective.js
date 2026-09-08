/**
 * What a pick has to do.
 *
 * Two of the three pools run on the same NFL data and want opposite things
 * from it: the winners pool needs its team to win, the losers pool needs its
 * team to lose. Nothing else about them differs - one pick a week, no team
 * twice, the same 32 teams, the same lines.
 *
 * Everything downstream of core/plan.js reads one number per option,
 * `winProb`, and treats it as "the chance this pick carries the entry through
 * the week": the tiers, the optimiser's beam search, the survival maths, the
 * ladder, the burn board, the pool overlay. So the objective is applied once,
 * where the raw market and projected numbers enter the model, and nothing
 * below has to know which pool is open. The field keeps the name `winProb`
 * because what it means is unchanged - the chance the pick wins you the week -
 * and renaming it would have touched every module that reads it to say the
 * same thing.
 *
 * The spread is never flipped. It is the market's number about the game, not
 * about the entry, and a losers pool wants to read it as it stands: +9.5 is
 * what makes that team a good pick there.
 */

/** @typedef {"win"|"lose"} Objective */

/**
 * The objective a pool plays, read off plan.json's rules.
 *
 * Absent means win: the two straight-up pools predate the field, their plan
 * files do not carry it, and a pool that never says otherwise is a normal one.
 *
 * @param {object} [rules] plan.rules
 * @returns {Objective}
 */
export function objectiveOf(rules) {
  return rules?.objective === "lose" ? "lose" : "win";
}

/**
 * A team's win probability, as the chance the pick carries the week.
 *
 * @param {number} winProb The team's own chance of winning the game.
 * @param {Objective} objective
 * @returns {number}
 */
export function advanceProb(winProb, objective) {
  return objective === "lose" ? 1 - winProb : winProb;
}

/**
 * A recorded final, as what it did to the entry.
 *
 * odds.json records whether the team won ("W") or lost ("L"), which is a fact
 * about the game and the same for both NFL pools. A losers entry advances on
 * the loss, so the two are swapped for it and every reader downstream - the
 * record, the elimination, the row that says "Won" - goes on meaning "this
 * pick worked" without knowing which pool it is in.
 *
 * A game the feed has not settled, or one it left level, stays null in both.
 *
 * @param {"W"|"L"|null|undefined} result
 * @param {Objective} objective
 * @returns {"W"|"L"|null}
 */
export function advanceResult(result, objective) {
  if (!result) return null;
  if (objective !== "lose") return result;
  return result === "W" ? "L" : "W";
}

/**
 * Comparator that puts the best pick for the objective first: the biggest
 * favourite in a winners pool, the biggest underdog in a losers pool. Used
 * wherever a week's options are listed, so the top of the list is always the
 * safest thing the pool can take.
 *
 * @param {Objective} objective
 * @returns {(a: {spread:number}, b: {spread:number}) => number}
 */
export function bySpread(objective) {
  return objective === "lose" ? (a, b) => b.spread - a.spread : (a, b) => a.spread - b.spread;
}

/**
 * Which way a line has to move for a pick to be in danger, as the sign to
 * multiply a spread comparison by: a winners pick weakens as its spread rises
 * towards zero, a losers pick as its spread falls towards it.
 *
 * @param {Objective} objective
 * @returns {1|-1}
 */
export function dangerSign(objective) {
  return objective === "lose" ? -1 : 1;
}
