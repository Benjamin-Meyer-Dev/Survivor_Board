/**
 * Probability helpers.
 *
 * Pure functions, no DOM and no imports - this module is loaded by both the
 * browser app and the Node scripts, so it must stay environment-free.
 *
 * The model is a normal margin around the spread. A team favoured by `s`
 * points wins when its margin comes in above zero, and the margin is spread
 * around the line with a standard deviation that the history of each league
 * fixes (scripts/calibrate.mjs writes it to data/<league>/calibration.json):
 *
 *   P(win) = Phi(|s| / sigma(s, total))
 *
 * Two things widen that sigma. College margins scatter more around a big line
 * than a small one, so sigma grows with the spread (`slope`); the NFL's does
 * not, and its slope is near zero. And a spread the board has projected for a
 * week the market has not posted yet is itself uncertain - a rating fit today
 * will not be the closing line in six weeks - so the variance of that error,
 * growing with the horizon, is added in. That is what keeps a projected -35
 * in December from counting as the near-certainty a market -35 this Saturday
 * is.
 */

/**
 * The model the board runs with when a league ships no calibration.json.
 *
 * These are the college numbers: `core/` defaults to the college pool
 * throughout (see docs/CODE_STANDARDS.md). The NFL's calibration.json lowers
 * `slope` to almost nothing and `sigma` to the thirteen points its margins
 * actually scatter by. Every field is documented where it is used below.
 */
export const DEFAULT_MODEL = Object.freeze({
  /** Standard deviation of the margin around a pick-em line, in points. */
  sigma: 14.12,
  /** How much sigma grows per point of spread. College favourites are a
   *  little less reliable than a fixed sigma says; the NFL's are not. */
  slope: 0.03,
  /** How much sigma grows per point the game total sits above `referenceTotal`.
   *  A shootout scatters margins more than a slog. Zero when totals are not
   *  priced. */
  totalSlope: 0.005,
  referenceTotal: 54.9,
  /** Widest sigma allowed, so a 60-point spread does not run away. */
  maxSigma: 26,
  /**
   * The de-vigged moneyline against the spread, as a share of the evidence in
   * log-odds space, when a line carries both. The spread is the book's
   * sharpest number and a moneyline on a big favourite is rounded, capped and
   * carries the favourite-longshot bias, so the moneyline gets the smaller
   * say. Zero would ignore moneylines; one would ignore the spread.
   */
  moneylineWeight: 0.35,
  /**
   * A price this far from even is treated as capped: books stop pricing
   * -40 and -50 favourites apart and post their house maximum for both, so the
   * number says "very likely" and nothing more. Such a moneyline is dropped
   * and the spread carries the line alone.
   */
  moneylineCap: 2500,
  /**
   * Error of a projected spread against the line the market eventually
   * closes at, for a game `h` weeks ahead, as a variance in points squared:
   *
   *   variance(h) = base^2 + perWeek^2 * h
   *
   * `base` is what even next week's projection misses by (injuries, rest,
   * weather, the matchup itself); `perWeek` is how fast the ratings the
   * projection stands on drift away from the truth. `teamShare` is how much of
   * that variance belongs to the team rather than the game: a team the fit
   * has overrated is overrated in every week it plays, which is what makes
   * saving one strong team for December a correlated bet rather than a set
   * of independent ones (see core/scenarios.js). `unseen` is the variance a
   * projection carries per side the fit has never seen a line for - a team
   * still priced off its preseason rating alone, which in college is every
   * team that opened against an FCS side.
   */
  horizon: Object.freeze({ base: 2.42, perWeek: 2.52, teamShare: 0.84, unseen: 0 }),
});

/**
 * Merge a league's calibration.json into the defaults, so a file that names
 * only some fields still yields a complete model. Unknown fields are ignored.
 *
 * @param {object|null} calibration The parsed data/<league>/calibration.json.
 * @returns {object} A complete, frozen model.
 */
export function resolveModel(calibration) {
  if (!calibration) return DEFAULT_MODEL;
  const margin = calibration.margin ?? calibration;
  const number = (value, fallback) => (Number.isFinite(value) ? value : fallback);
  return Object.freeze({
    sigma: number(margin.sigma, DEFAULT_MODEL.sigma),
    slope: number(margin.slope, DEFAULT_MODEL.slope),
    totalSlope: number(margin.totalSlope, DEFAULT_MODEL.totalSlope),
    referenceTotal: number(margin.referenceTotal, DEFAULT_MODEL.referenceTotal),
    maxSigma: number(margin.maxSigma, DEFAULT_MODEL.maxSigma),
    moneylineWeight: number(
      calibration.moneyline?.weight ?? calibration.moneylineWeight,
      DEFAULT_MODEL.moneylineWeight,
    ),
    moneylineCap: number(
      calibration.moneyline?.cap ?? calibration.moneylineCap,
      DEFAULT_MODEL.moneylineCap,
    ),
    horizon: Object.freeze({
      base: number(calibration.horizon?.base, DEFAULT_MODEL.horizon.base),
      perWeek: number(calibration.horizon?.perWeek, DEFAULT_MODEL.horizon.perWeek),
      teamShare: number(calibration.horizon?.teamShare, DEFAULT_MODEL.horizon.teamShare),
      unseen: number(calibration.horizon?.unseen, DEFAULT_MODEL.horizon.unseen),
    }),
  });
}

/**
 * Standard deviation of a game's margin around its spread.
 *
 * @param {number} spread Either sign; only its size matters.
 * @param {object} model
 * @param {number|null} total The game total, when the market has one.
 */
export function marginSigma(spread, model = DEFAULT_MODEL, total = null) {
  let sigma = model.sigma + model.slope * Math.abs(spread);
  if (Number.isFinite(total) && model.totalSlope) {
    sigma += model.totalSlope * (total - model.referenceTotal);
  }
  return Math.min(model.maxSigma, Math.max(6, sigma));
}

/**
 * Variance of a projected spread's error against the closing line, for a game
 * this many weeks ahead. Zero for a game the market has priced.
 */
export function horizonVariance(weeksAhead, model = DEFAULT_MODEL, unseenSides = 0) {
  if (!(weeksAhead > 0)) return 0;
  const { base, perWeek, unseen = 0 } = model.horizon;
  return base * base + perWeek * perWeek * weeksAhead + unseen * Math.max(0, unseenSides);
}

/**
 * Straight-up win probability for a point spread.
 *
 * @param {number} spread Negative when the team is favoured.
 * @param {object} model From resolveModel(), or the college default.
 * @param {{total?:number|null, weeksAhead?:number}} context The game total if
 *   the market has one, and how many weeks ahead the game is when the spread
 *   is a projection rather than a market line (0, the default, for a line).
 * @returns {number} Probability in [0.001, 0.999].
 */
export function winProbFromSpread(spread, model = DEFAULT_MODEL, context = {}) {
  const { total = null, weeksAhead = 0, unseenSides = 0 } = context;
  const sigma = marginSigma(spread, model, total);
  const scale = Math.sqrt(sigma * sigma + horizonVariance(weeksAhead, model, unseenSides));
  // A projection h weeks out is the spread plus an error of that variance, and
  // averaging Phi over the error is Phi at the widened scale. Half a point is
  // the push a spread on a whole number would land on; the margin is treated
  // as continuous, which the data bears out to well under a percent.
  return clampProbability(normalCdf(-spread / scale));
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
 * Whether a price is at a book's house maximum rather than a considered
 * number. Both signs: a -3000 favourite implies a +1500-or-so dog, and either
 * side being capped means the pair is.
 */
export function isCappedPrice(moneyline, model = DEFAULT_MODEL) {
  return Number.isFinite(moneyline) && Math.abs(moneyline) >= model.moneylineCap;
}

/**
 * One fair probability from several books' two-sided moneylines.
 *
 * Each book is de-vigged on its own pair first - a book's favourite and its
 * underdog price share one margin, and taking a median of each side across
 * books (as the ingest once did) mixes margins from different books and lands
 * on a number no book actually posted. The fair probabilities are then
 * averaged in log-odds space, where a 97% and a 99% are as far apart as they
 * deserve to be, and a capped pair is left out altogether.
 *
 * @param {Array<{team:number, opponent:number}>} pairs One entry per book.
 * @param {object} model
 * @returns {{probability:number|null, books:number, capped:number}}
 */
export function fairFromMoneylines(pairs, model = DEFAULT_MODEL) {
  let sum = 0;
  let books = 0;
  let capped = 0;
  for (const pair of pairs) {
    if (!Number.isFinite(pair?.team) || !Number.isFinite(pair?.opponent)) continue;
    if (isCappedPrice(pair.team, model) || isCappedPrice(pair.opponent, model)) {
      capped += 1;
      continue;
    }
    sum += logit(clampProbability(devig(pair.team, pair.opponent)));
    books += 1;
  }
  return { probability: books ? expit(sum / books) : null, books, capped };
}

/**
 * The win probability a market line carries, from the spread and, when the
 * books priced one that means something, the moneyline.
 *
 * @param {object} args
 * @param {number} args.spread Negative when favoured.
 * @param {number|null} [args.total]
 * @param {number|null} [args.moneylineProb] Fair probability from fairFromMoneylines.
 * @param {object} [args.model]
 * @returns {number}
 */
export function marketWinProb({
  spread,
  total = null,
  moneylineProb = null,
  model = DEFAULT_MODEL,
}) {
  const fromSpread = winProbFromSpread(spread, model, { total });
  if (!Number.isFinite(moneylineProb) || model.moneylineWeight <= 0) return fromSpread;
  const weight = Math.min(1, model.moneylineWeight);
  return clampProbability(
    expit((1 - weight) * logit(fromSpread) + weight * logit(clampProbability(moneylineProb))),
  );
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

/** Standard normal cumulative distribution, to about 1e-7. */
export function normalCdf(x) {
  if (x < -8) return 0;
  if (x > 8) return 1;
  // Abramowitz and Stegun 7.1.26 on the complementary error function.
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** log(p / (1 - p)) */
export function logit(p) {
  return Math.log(p / (1 - p));
}

/** 1 / (1 + e^-x) */
export function expit(x) {
  return 1 / (1 + Math.exp(-x));
}

/** Keep a probability strictly inside (0, 1) so logs and logits stay finite. */
export function clampProbability(p) {
  return Math.min(0.999, Math.max(0.001, p));
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
