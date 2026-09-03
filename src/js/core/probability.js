/**
 * Probability helpers.
 *
 * Pure functions, no DOM and no imports - this module is loaded by both the
 * browser app and the Node refresh script, so it must stay environment-free.
 */

/**
 * Straight-up win probability for a point spread.
 *
 * Piecewise-linear interpolation over historical favourite win rates. The
 * curve is shared by both leagues: they agree closely inside the range the NFL
 * actually produces, and the long tail past three touchdowns only ever comes
 * up in college.
 *
 * @param {number} spread Negative when the team is favoured.
 * @returns {number} Probability in [0.5, 0.99].
 */
export function winProbFromSpread(spread) {
  const points = Math.abs(spread);
  const favoured = spread <= 0;

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

  let probability = 0.99;
  for (let i = 0; i < CURVE.length - 1; i += 1) {
    const [x0, y0] = CURVE[i];
    const [x1, y1] = CURVE[i + 1];
    if (points >= x0 && points <= x1) {
      const t = x1 === x0 ? 0 : (points - x0) / (x1 - x0);
      probability = y0 + t * (y1 - y0);
      break;
    }
  }

  return favoured ? probability : 1 - probability;
}

/**
 * Convert an American moneyline to its implied probability, vig included.
 *
 * @param {number} moneyline e.g. -450 or +320
 * @returns {number}
 */
export function impliedFromMoneyline(moneyline) {
  if (moneyline < 0) {
    return -moneyline / (-moneyline + 100);
  }
  return 100 / (moneyline + 100);
}

/**
 * Remove the book's margin from a two-way market.
 *
 * @param {number} favouriteMoneyline
 * @param {number} underdogMoneyline
 * @returns {number} The favourite's fair win probability.
 */
export function devig(favouriteMoneyline, underdogMoneyline) {
  const a = impliedFromMoneyline(favouriteMoneyline);
  const b = impliedFromMoneyline(underdogMoneyline);
  const overround = a + b;
  return overround > 0 ? a / overround : a;
}

/**
 * Project a spread from two power ratings.
 *
 * @param {number} teamRating
 * @param {number} opponentRating
 * @param {boolean} isHome
 * @param {number} homeFieldPoints
 * @returns {number} Negative when the team is favoured.
 */
export function projectSpread(teamRating, opponentRating, isHome, homeFieldPoints = 2.5) {
  const edge = teamRating - opponentRating + (isHome ? homeFieldPoints : -homeFieldPoints);
  return -Number(edge.toFixed(1));
}

/**
 * Default tier cut-offs, as win probabilities. Equivalent to the old spread
 * thresholds of -20, -14 and -10 in college football.
 */
export const DEFAULT_TIERS = Object.freeze({ safe: 0.92, solid: 0.85, thin: 0.78 });

/**
 * Confidence bucket. Drives the colour scale and the chip label.
 *
 * Bucketed on win probability rather than on the spread itself, because the
 * same number means different things in different leagues: -14 is a routine
 * favourite in college and an enormous one in the NFL. Each league sets its
 * own cut-offs, so "Lock" means the same confidence on both boards even though
 * it takes twenty points to earn in one and twelve in the other.
 *
 * @param {number} winProb
 * @param {{safe:number, solid:number, thin:number}} tiers
 */
export function confidenceTier(winProb, tiers = DEFAULT_TIERS) {
  if (winProb >= tiers.safe) return "safe";
  if (winProb >= tiers.solid) return "solid";
  if (winProb >= tiers.thin) return "thin";
  // A close favourite is risky, but it is not an upset pick. Keep the red
  // alert semantically strict: only a team below even odds earns it.
  if (winProb >= 0.5) return "close";
  return "danger";
}

/** How a pick reads on the sideline, not just what the spread says. */
export const TIER_LABEL = Object.freeze({
  safe: "Lock",
  solid: "Solid",
  thin: "Shaky",
  close: "Close call",
  danger: "Upset alert",
});
