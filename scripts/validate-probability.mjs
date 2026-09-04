#!/usr/bin/env node
/**
 * Checks on the probability model (core/probability.js).
 *
 * The model is a normal margin around the spread with a league-specific
 * scatter, a de-vig that works book by book, and a horizon term that widens a
 * projected line the further ahead it is. These are the properties the board
 * relies on, whatever numbers a league's calibration.json lands on.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  DEFAULT_MODEL,
  resolveModel,
  winProbFromSpread,
  marginSigma,
  horizonVariance,
  devig,
  fairFromMoneylines,
  marketWinProb,
  isCappedPrice,
  normalCdf,
  logit,
  expit,
  confidenceTier,
} from "../src/js/core/probability.js";
import { LEAGUE_IDS } from "../src/js/leagues.js";

const close = (a, b, tolerance, message) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b}`);

// The normal CDF is the whole model, so it has to be right.
close(normalCdf(0), 0.5, 1e-7, "Phi(0)");
close(normalCdf(1), 0.8413447, 1e-6, "Phi(1)");
close(normalCdf(-1.96), 0.0249979, 1e-6, "Phi(-1.96)");
close(normalCdf(3), 0.9986501, 1e-6, "Phi(3)");
assert.equal(normalCdf(-9), 0);
assert.equal(normalCdf(9), 1);
close(expit(logit(0.83)), 0.83, 1e-12, "logit and expit invert each other");

// A pick-em is a coin flip, and the two sides of a game sum to one.
close(winProbFromSpread(0), 0.5, 1e-9, "pick-em");
for (const spread of [-3, -7.5, -14, -24.5, -40]) {
  close(
    winProbFromSpread(spread) + winProbFromSpread(-spread),
    1,
    1e-9,
    `both sides of ${spread} sum to one`,
  );
}

// More points is more probability, always, up to the clamp that keeps a
// probability off one; and never a certainty.
let previous = 0.5;
for (let points = 0.5; points <= 70; points += 0.5) {
  const p = winProbFromSpread(-points);
  assert.ok(
    p >= previous,
    `a ${points}-point favourite is no worse than a ${points - 0.5}-point one`,
  );
  if (previous < 0.999) {
    assert.ok(p > previous, `a ${points}-point favourite beats a ${points - 0.5}-point one`);
  }
  assert.ok(p <= 0.999, "no favourite is certain");
  previous = p;
}

// The college default keeps the tiers on a college scale: a Lock takes about
// three touchdowns, Solid two and a bit, Shaky a touchdown and a half. The
// history moved each a point or so further out than the curve the board
// shipped with, which is the calibration doing its job.
assert.equal(confidenceTier(winProbFromSpread(-12)), "thin");
assert.equal(confidenceTier(winProbFromSpread(-16)), "solid");
assert.equal(confidenceTier(winProbFromSpread(-22)), "safe");
assert.equal(confidenceTier(winProbFromSpread(-2)), "close");
assert.equal(confidenceTier(winProbFromSpread(3)), "danger");

// Sigma grows with the spread when the league says so, and a total above the
// reference widens it when the league prices totals.
const heteroscedastic = resolveModel({ margin: { sigma: 13, slope: 0.15 } });
assert.ok(marginSigma(-30, heteroscedastic) > marginSigma(-3, heteroscedastic));
const flat = resolveModel({ margin: { sigma: 13, slope: 0, totalSlope: 0 } });
assert.equal(marginSigma(-30, flat), marginSigma(-3, flat), "a zero slope is a fixed sigma");
const totals = resolveModel({
  margin: { sigma: 13, slope: 0, totalSlope: 0.05, referenceTotal: 45 },
});
assert.ok(
  winProbFromSpread(-7, totals, { total: 60 }) < winProbFromSpread(-7, totals, { total: 40 }),
  "a shootout makes a favourite less safe than a slog",
);
assert.equal(
  winProbFromSpread(-7, flat, { total: 60 }),
  winProbFromSpread(-7, flat, { total: 40 }),
  "without a total slope the total changes nothing",
);
const steep = resolveModel({ margin: { sigma: 14, slope: 0.5 } });
assert.equal(marginSigma(-90, steep), steep.maxSigma, "sigma is capped");

// A projected line is less certain the further out it is: the probability
// regresses toward even, and never past it.
assert.equal(horizonVariance(0), 0, "a market line carries no horizon error");
assert.ok(horizonVariance(6) > horizonVariance(1), "error grows with the horizon");
const now = winProbFromSpread(-14);
const soon = winProbFromSpread(-14, DEFAULT_MODEL, { weeksAhead: 1 });
const later = winProbFromSpread(-14, DEFAULT_MODEL, { weeksAhead: 8 });
assert.ok(now > soon && soon > later && later > 0.5, "a favourite in December is less of one");
assert.ok(
  winProbFromSpread(6, DEFAULT_MODEL, { weeksAhead: 8 }) >
    winProbFromSpread(6, DEFAULT_MODEL, { weeksAhead: 0 }),
  "and a projected underdog is less of one too",
);

// De-vig: a -200 / +170 pair is a 66.7% / 37.0% book that adds to more than
// one; the fair favourite is the share of the overround.
close(devig(-200, 170), 2 / 3 / (2 / 3 + 1 / 2.7), 1e-9, "proportional de-vig");
close(devig(-110, -110), 0.5, 1e-9, "a balanced book is a coin flip");

// Book by book, then in log-odds. Mixing one book's favourite with another's
// underdog lands on a probability neither posted.
const pairs = [
  { team: -450, opponent: 340 },
  { team: -500, opponent: 380 },
  { team: -430, opponent: 330 },
];
const fair = fairFromMoneylines(pairs, DEFAULT_MODEL);
assert.equal(fair.books, 3);
assert.equal(fair.capped, 0);
const eachBook = pairs.map((pair) => devig(pair.team, pair.opponent));
assert.ok(
  fair.probability > Math.min(...eachBook) && fair.probability < Math.max(...eachBook),
  "the consensus sits inside the books",
);
// A capped pair says "very likely" and nothing more, so it is left out, and a
// consensus of nothing but caps is no consensus.
assert.ok(isCappedPrice(-3000, DEFAULT_MODEL));
assert.ok(isCappedPrice(1800, resolveModel({ moneyline: { cap: 1500 } })));
assert.ok(!isCappedPrice(-450, DEFAULT_MODEL));
const withCap = fairFromMoneylines([...pairs, { team: -5000, opponent: 1600 }], DEFAULT_MODEL);
assert.equal(withCap.capped, 1);
close(withCap.probability, fair.probability, 1e-12, "a capped book changes nothing");
const onlyCaps = fairFromMoneylines([{ team: -10000, opponent: 2500 }], DEFAULT_MODEL);
assert.equal(onlyCaps.probability, null, "caps alone are no evidence");
assert.equal(fairFromMoneylines([{ team: -300 }], DEFAULT_MODEL).books, 0, "one side is no pair");

// The market probability blends the spread with the moneyline in log-odds and
// falls back to the spread alone when the moneyline is missing or capped.
const spreadOnly = marketWinProb({ spread: -10 });
assert.equal(spreadOnly, winProbFromSpread(-10));
const blended = marketWinProb({ spread: -10, moneylineProb: 0.9 });
assert.ok(blended > spreadOnly && blended < 0.9, "the blend sits between its two sources");
assert.equal(
  marketWinProb({
    spread: -10,
    moneylineProb: 0.9,
    model: resolveModel({ moneyline: { weight: 0 } }),
  }),
  spreadOnly,
  "a zero weight is the spread alone",
);
close(
  marketWinProb({
    spread: -10,
    moneylineProb: 0.9,
    model: resolveModel({ moneyline: { weight: 1 } }),
  }),
  0.9,
  1e-9,
  "a full weight is the moneyline alone",
);

// resolveModel fills gaps from the defaults and never yields a NaN.
const partial = resolveModel({ margin: { sigma: 13.1 }, horizon: { perWeek: 0.9 } });
assert.equal(partial.sigma, 13.1);
assert.equal(partial.slope, DEFAULT_MODEL.slope);
assert.equal(partial.horizon.perWeek, 0.9);
assert.equal(partial.horizon.base, DEFAULT_MODEL.horizon.base);
assert.equal(resolveModel(null), DEFAULT_MODEL);
assert.equal(resolveModel({ margin: { sigma: "x" } }).sigma, DEFAULT_MODEL.sigma);

// Each league that ships a calibration.json ships a usable one.
for (const league of LEAGUE_IDS) {
  let calibration = null;
  try {
    calibration = JSON.parse(
      await readFile(new URL(`../data/${league}/calibration.json`, import.meta.url), "utf8"),
    );
  } catch {
    continue;
  }
  const model = resolveModel(calibration);
  assert.ok(
    model.sigma >= 8 && model.sigma <= 20,
    `${league}: sigma ${model.sigma} is a football number`,
  );
  assert.ok(model.slope >= 0 && model.slope < 0.5, `${league}: slope ${model.slope}`);
  assert.ok(
    model.moneylineWeight >= 0 && model.moneylineWeight <= 1,
    `${league}: moneyline weight ${model.moneylineWeight}`,
  );
  assert.ok(model.horizon.base >= 0 && model.horizon.perWeek >= 0, `${league}: horizon`);
  assert.ok(
    model.horizon.unseen >= 0 && model.horizon.unseen < 50,
    `${league}: the unseen-side variance (${model.horizon.unseen}) is scaled to the live prior`,
  );
  if (model.horizon.unseen > 0) {
    assert.ok(
      winProbFromSpread(-10, model, { weeksAhead: 1, unseenSides: 2 }) <
        winProbFromSpread(-10, model, { weeksAhead: 1 }),
      `${league}: a game between two unseen teams is priced with more doubt`,
    );
  }
  if (calibration.rating) {
    assert.ok(
      calibration.rating.anchor > 0 && calibration.rating.anchorHalfLife >= 0,
      `${league}: the anchor and its half-life are set`,
    );
  }
  assert.ok(
    winProbFromSpread(-7, model) > 0.6 && winProbFromSpread(-7, model) < 0.8,
    `${league}: a touchdown favourite wins 60-80%`,
  );
  if (calibration.rating) {
    for (const [name, value] of Object.entries(calibration.rating)) {
      assert.ok(Number.isFinite(value) && value >= 0, `${league}: rating.${name} = ${value}`);
    }
  }
}

console.log(
  "Probability OK: normal CDF, symmetric monotone spread curve, tier scale, sigma by spread " +
    "and total, horizon widening, book-by-book de-vig with caps, log-odds blend, " +
    "calibration files resolve.",
);
