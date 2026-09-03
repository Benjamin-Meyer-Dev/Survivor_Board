/**
 * Survival probability, including buy backs.
 *
 * Without a buy back this is just the product of every unresolved pick's win
 * probability. With buy backs, losing in a designated week costs a buy back
 * rather than the season, so the entry also survives branches where some of
 * those weeks go down:
 *
 *   P = Prod(p_i over ordinary weeks) * Pr(at most k buy back weeks lost)
 *
 * That second factor is why weeks 1 and 2 are worth spending a weaker team on.
 * How many of the forgiving weeks lose is a Poisson binomial, so the tail is
 * built with a small DP rather than a closed form: it stays correct whether the
 * pool grants one buy back or three.
 *
 * Pure and environment free, so the same maths runs in the browser and in the
 * refresh script.
 */

/**
 * @param {object} args
 * @param {Array<{week:number, winProb:number, result:"W"|"L"|null}>} args.picks
 * @param {number[]} args.buyBackWeeks Weeks in which a loss can be bought back.
 * @param {number} args.buyBacks How many buy backs the pool grants in total.
 * @returns {{probability:number, eliminated:boolean, buyBacksUsed:number,
 *            buyBacksLeft:number, record:{won:number, lost:number}}}
 */
export function survival({ picks, buyBackWeeks = [], buyBacks = 0 }) {
  const forgiving = new Set(buyBackWeeks);
  const record = { won: 0, lost: 0 };

  let buyBacksUsed = 0;
  let eliminated = false;

  for (const pick of picks) {
    if (pick.result === "W") {
      record.won += 1;
    } else if (pick.result === "L") {
      record.lost += 1;
      // A loss in a forgiving week spends a buy back instead of ending it.
      if (forgiving.has(pick.week) && buyBacksUsed < buyBacks) {
        buyBacksUsed += 1;
      } else {
        eliminated = true;
      }
    }
  }

  const buyBacksLeft = Math.max(0, buyBacks - buyBacksUsed);

  if (eliminated) {
    return { probability: 0, eliminated: true, buyBacksUsed, buyBacksLeft, record };
  }

  const remaining = picks.filter((pick) => !pick.result);

  // A forgiving week is survived as a unit: with two picks in it, either both
  // hold or the week is lost and a buy back covers it.
  const byWeek = new Map();
  let strict = 1;

  for (const pick of remaining) {
    if (!forgiving.has(pick.week) || buyBacksLeft === 0) {
      strict *= pick.winProb;
      continue;
    }
    byWeek.set(pick.week, (byWeek.get(pick.week) ?? 1) * pick.winProb);
  }

  const probability = strict * atMostLost([...byWeek.values()], buyBacksLeft);

  return {
    probability: Math.min(1, probability),
    eliminated: false,
    buyBacksUsed,
    buyBacksLeft,
    record,
  };
}

/**
 * Pr(no more than `allowed` of these weeks are lost), given each week's own
 * chance of holding. Poisson binomial tail by DP over the weeks.
 */
function atMostLost(weekProbs, allowed) {
  if (weekProbs.length === 0) return 1;

  // dist[j] = probability exactly j of the weeks seen so far were lost.
  let dist = [1];

  for (const hold of weekProbs) {
    const next = new Array(dist.length + 1).fill(0);
    for (const [lost, chance] of dist.entries()) {
      next[lost] += chance * hold;
      next[lost + 1] += chance * (1 - hold);
    }
    // Anything past the allowance is already dead, so it never has to be
    // carried forward.
    dist = next.slice(0, allowed + 1);
  }

  return dist.reduce((total, chance) => total + chance, 0);
}
