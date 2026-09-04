#!/usr/bin/env node
/**
 * Checks on the ratings the daily pull fits (scripts/lib/rate.mjs).
 *
 * The fit exists for one job: price a matchup the market has not posted, so
 * the optimiser can plan the weeks after this one on numbers that know what
 * has happened this season. So that is what is tested here, on a synthetic
 * league whose true ratings are known - can it recover them from lines alone,
 * and then price a game it has never seen a line for?
 *
 * The rest guards the ways a fit like this goes quietly wrong: one blowout
 * running away with a rating, a team nobody has played being invented, the
 * answer depending on the order the schedule lists its games in, and the board
 * behaving differently when the file is not there at all.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { fitForm, holdoutError, marketError, observationsFrom } from "./lib/rate.mjs";
import { buildBoard, lineKey } from "../src/js/core/plan.js";
import { projectSpread } from "../src/js/core/probability.js";
import { CONFIG } from "../src/js/config.js";
import { LEAGUE_IDS } from "../src/js/leagues.js";

// ---------------------------------------------------------------------------
// A synthetic league with known answers.
// ---------------------------------------------------------------------------

const TRUE = { Anchors: 20, Bears: 10, Comets: 0, Dukes: -10, Eagles: -20, Foxes: 5 };
const HFA = 2.5;
/** Every team starts level, so anything the fit gets right it got from the lines. */
const FLAT = Object.fromEntries(Object.keys(TRUE).map((team) => [team, 0]));

/** The line a book would post: negative when the home team is favoured. */
const trueLine = (home, away, neutral = false) => -(TRUE[home] - TRUE[away] + (neutral ? 0 : HFA));

/**
 * A single round robin over five weeks, home and away alternating so home
 * field is not confounded with strength - what mid-season looks like, and the
 * point at which the fit is expected to be carrying the board. Anchors against
 * Eagles is deliberately held out of it.
 */
const PAIRS = [
  [
    ["Anchors", "Bears"],
    ["Comets", "Foxes"],
    ["Dukes", "Eagles"],
  ],
  [
    ["Comets", "Anchors"],
    ["Bears", "Dukes"],
    ["Foxes", "Eagles"],
  ],
  [
    ["Anchors", "Dukes"],
    ["Foxes", "Bears"],
    ["Eagles", "Comets"],
  ],
  [
    ["Bears", "Comets"],
    ["Dukes", "Foxes"],
  ],
  [
    ["Foxes", "Anchors"],
    ["Eagles", "Bears"],
    ["Comets", "Dukes"],
  ],
];

const syntheticSchedule = { weeks: {} };
const syntheticLines = {};
for (const [index, games] of PAIRS.entries()) {
  const week = index + 1;
  syntheticSchedule.weeks[String(week)] = games.map(([home, away]) => ({ home, away }));
  for (const [home, away] of games) {
    syntheticLines[lineKey(week, home)] = {
      spread: trueLine(home, away),
      source: "market",
      winProb: 0.5,
    };
  }
}
// Week 6 is on the schedule but has no line, and these two have not met: this
// is the game the board would have to project, and the reason the fit exists.
syntheticSchedule.weeks["6"] = [{ home: "Anchors", away: "Eagles" }];

const fitted = fitForm({
  schedule: syntheticSchedule,
  lines: syntheticLines,
  base: FLAT,
  homeFieldPoints: HFA,
  throughWeek: 5,
});

assert.ok(fitted, "five weeks of lines is something to fit");
assert.equal(fitted.fit.marketLines, 14, "one equation per game, not one per priced side");
assert.equal(fitted.fit.margins, 0, "no finals were recorded in this fixture");
assert.ok(
  Object.values(fitted.ratings).every(Number.isFinite),
  "every fitted rating is a real number",
);

// Ratings are only ever used as differences, so the level is arbitrary: what
// has to be right is the gap between two teams. A round robin of lines should
// carry a gap most of the way from a starting rating that is flat wrong - and
// never past it: regularisation is allowed to be short, never to exaggerate.
const gap = (a, b) => fitted.ratings[a] - fitted.ratings[b];
const trueGap = (a, b) => TRUE[a] - TRUE[b];
for (const [a, b] of [
  ["Anchors", "Eagles"],
  ["Anchors", "Comets"],
  ["Bears", "Dukes"],
  ["Foxes", "Comets"],
]) {
  const truth = trueGap(a, b);
  const error = Math.abs(gap(a, b) - truth);
  const detail = `${a} over ${b}: fitted ${gap(a, b).toFixed(1)} against a true ${truth}`;
  assert.ok(error <= 0.2 * Math.abs(truth) + 1, `${detail} (off by ${error.toFixed(1)})`);
  assert.ok(Math.abs(gap(a, b)) <= Math.abs(truth) + 0.5, `${detail} - overshot`);
}
assert.ok(
  fitted.ratings.Anchors > fitted.ratings.Bears &&
    fitted.ratings.Bears > fitted.ratings.Comets &&
    fitted.ratings.Comets > fitted.ratings.Dukes &&
    fitted.ratings.Dukes > fitted.ratings.Eagles,
  "the fit puts the league in the right order",
);

// The product claim: price week 6, which no line in the fixture covers, between
// two teams that have not met.
const projectedFromFit = projectSpread(fitted.ratings.Anchors, fitted.ratings.Eagles, true, HFA);
const projectedFromFlat = projectSpread(FLAT.Anchors, FLAT.Eagles, true, HFA);
const truth = trueLine("Anchors", "Eagles");
assert.ok(
  Math.abs(projectedFromFit - truth) < Math.abs(projectedFromFlat - truth),
  "the fit prices an unposted game closer to the truth than the ratings it started from",
);
assert.ok(
  Math.abs(projectedFromFit - truth) <= 0.2 * Math.abs(truth) + 1,
  `week 6 projected ${projectedFromFit} against a true ${truth}`,
);

// ---------------------------------------------------------------------------
// The ways a fit like this goes wrong.
// ---------------------------------------------------------------------------

// A team the pull has never seen is not invented: it is absent, and the board
// falls back to the rating it shipped with.
assert.equal(fitted.ratings.Foxes !== undefined, true, "Foxes played, so Foxes was fitted");
const unplayed = fitForm({
  schedule: { weeks: { 1: [{ home: "Anchors", away: "Bears" }] } },
  lines: { [lineKey(1, "Anchors")]: { spread: -10, source: "market" } },
  base: FLAT,
  homeFieldPoints: HFA,
  throughWeek: 1,
});
assert.deepEqual(
  Object.keys(unplayed.ratings).sort(),
  ["Anchors", "Bears"],
  "only the teams in an observation are fitted",
);
assert.equal(unplayed.observations.Anchors, 1);

// One blowout must not run away with a rating. A 70-point win is capped, so it
// moves a team no further than a 24-point win does.
const marginOnly = (points) =>
  fitForm({
    schedule: { weeks: { 1: [{ home: "Anchors", away: "Bears" }] } },
    scores: { [lineKey(1, "Anchors")]: points },
    base: FLAT,
    homeFieldPoints: HFA,
    throughWeek: 1,
  }).ratings.Anchors;
assert.equal(marginOnly(70), marginOnly(24), "a margin past the cap says nothing more");
assert.ok(marginOnly(24) > marginOnly(10), "a bigger win inside the cap still says more");
assert.ok(
  marginOnly(24) < 24,
  "a single game moves a rating part of the way, not all of it: it is one game",
);

// A market line outweighs a margin, because within days the market has read
// the same game and posted a line that supersedes it.
const fromLine = fitForm({
  schedule: { weeks: { 1: [{ home: "Anchors", away: "Bears" }] } },
  lines: { [lineKey(1, "Anchors")]: { spread: -20, source: "market" } },
  base: FLAT,
  homeFieldPoints: HFA,
  throughWeek: 1,
}).ratings.Anchors;
const fromMargin = marginOnly(20 + HFA);
assert.ok(
  fromLine > fromMargin,
  `a line should move a rating further than one margin saying the same thing (${fromLine} vs ${fromMargin})`,
);

// Older observations count for less, so a week-1 line is not still arguing
// about a team in week 12.
const staleWeight = observationsFrom({
  schedule: syntheticSchedule,
  lines: syntheticLines,
  base: FLAT,
  homeFieldPoints: HFA,
  throughWeek: 4,
});
const week1 = staleWeight.find((o) => o.week === 1).weight;
const week4 = staleWeight.find((o) => o.week === 4).weight;
assert.ok(week4 > week1, "the most recent week carries the most weight");

// A projection is not an observation: only lines the market actually posted
// are learned from, or the fit would be fitting itself.
const projectedOnly = observationsFrom({
  schedule: { weeks: { 1: [{ home: "Anchors", away: "Bears" }] } },
  lines: { [lineKey(1, "Anchors")]: { spread: -10, source: "projected" } },
  base: FLAT,
  homeFieldPoints: HFA,
  throughWeek: 1,
});
assert.equal(projectedOnly.length, 0, "a projected line teaches the fit nothing");

// The answer must not depend on the order the schedule lists its games in.
const shuffled = {
  weeks: Object.fromEntries(
    Object.entries(syntheticSchedule.weeks).map(([week, games]) => [week, [...games].reverse()]),
  ),
};
const reordered = fitForm({
  schedule: shuffled,
  lines: syntheticLines,
  base: FLAT,
  homeFieldPoints: HFA,
  throughWeek: 5,
});
assert.deepEqual(reordered.ratings, fitted.ratings, "the fit is order-independent");

// Neutral sites get no home field, on the way in and the way out.
const neutral = observationsFrom({
  schedule: { weeks: { 1: [{ home: "Anchors", away: "Bears", neutral: true }] } },
  lines: { [lineKey(1, "Anchors")]: { spread: -10, source: "market" } },
  base: FLAT,
  homeFieldPoints: HFA,
  throughWeek: 1,
});
assert.equal(neutral[0].hfa, 0, "a neutral game is nobody's home game");

// The holdout needs two weeks of lines to say anything, and says the fit wins
// on a league whose ratings are stable.
assert.equal(
  holdoutError({
    schedule: syntheticSchedule,
    lines: Object.fromEntries(
      Object.entries(syntheticLines).filter(([key]) => key.startsWith("1|")),
    ),
    base: FLAT,
    homeFieldPoints: HFA,
  }),
  null,
  "one week of lines cannot be split into a fit and a test",
);
const held = holdoutError({
  schedule: syntheticSchedule,
  lines: syntheticLines,
  base: FLAT,
  homeFieldPoints: HFA,
});
assert.ok(held, "five weeks of lines can hold one out");
assert.equal(held.week, 5, "the most recent week pulled is the one held out");
assert.ok(
  held.fitted < held.base,
  `out of sample the fit should beat the ratings it started from (${held.fitted} vs ${held.base})`,
);

// ---------------------------------------------------------------------------
// Both real leagues.
// ---------------------------------------------------------------------------

for (const league of LEAGUE_IDS) {
  const read = async (name) =>
    JSON.parse(await readFile(new URL(`../data/${league}/${name}`, import.meta.url), "utf8"));
  const [plan, odds, teams, schedule, ratings] = await Promise.all(
    ["plan.json", "odds.json", "teams.json", "schedule.json", "ratings.json"].map(read),
  );

  const form = fitForm({
    schedule,
    lines: odds.lines,
    scores: odds.scores,
    base: ratings.ratings,
    homeFieldPoints: ratings.homeFieldPoints,
    throughWeek: odds.currentWeek ?? 1,
  });

  // Nothing pulled yet is a real state - a league whose season has not opened.
  if (!form) continue;

  assert.ok(
    Object.values(form.ratings).every(Number.isFinite),
    `${league}: every fitted rating is a real number`,
  );
  assert.ok(
    Object.keys(form.ratings).every((team) => team in ratings.ratings),
    `${league}: the fit never invents a team that is not in ratings.json`,
  );
  // A fit that has drifted this far from a published preseason rating is not a
  // read on form any more, it is a bug in the join.
  const drift = Object.entries(form.ratings).map(([team, rating]) =>
    Math.abs(rating - ratings.ratings[team]),
  );
  assert.ok(
    Math.max(...drift) < 30,
    `${league}: no team should move 30 points (worst ${Math.max(...drift).toFixed(1)})`,
  );

  const before = marketError({
    schedule,
    lines: odds.lines,
    base: ratings.ratings,
    homeFieldPoints: ratings.homeFieldPoints,
  });
  const after = marketError({
    schedule,
    lines: odds.lines,
    base: ratings.ratings,
    overlay: form.ratings,
    homeFieldPoints: ratings.homeFieldPoints,
  });
  assert.ok(
    after.mae <= before.mae,
    `${league}: the fit must explain the lines it was given at least as well as the base`,
  );

  // The board takes the overlay for the weeks the market has not posted, and
  // leaves the market-priced week exactly alone.
  const boardArgs = {
    plan,
    odds,
    teams,
    schedule,
    ratings,
    entry: { picks: {}, swaps: {} },
    refreshSchedule: CONFIG.refresh,
    allowSearch: false,
  };
  const plain = buildBoard(boardArgs);
  const withForm = buildBoard({ ...boardArgs, form });

  const priced = plain.weeks.find((week) => week.week === plain.currentWeek);
  const pricedWithForm = withForm.weeks.find((week) => week.week === plain.currentWeek);
  assert.deepEqual(
    pricedWithForm.options.map((option) => [option.team, option.spread]),
    priced.options.map((option) => [option.team, option.spread]),
    `${league}: a week the market has priced does not move when the ratings do`,
  );

  // Somewhere in the weeks ahead, a projection must have changed - otherwise
  // the overlay is not reaching the board at all.
  const later = plain.weeks.filter((week) => week.week > plain.currentWeek);
  const laterWithForm = withForm.weeks.filter((week) => week.week > plain.currentWeek);
  const moved = later.some((week, index) =>
    week.options.some((option, slot) => {
      const other = laterWithForm[index].options[slot];
      return other && other.spread !== option.spread;
    }),
  );
  assert.ok(moved, `${league}: the fitted ratings must reach the weeks the market has not posted`);

  // And the projections must still be projections: a fitted spread is a
  // number, not a NaN from a missed name.
  assert.ok(
    laterWithForm.every((week) => week.options.every((option) => Number.isFinite(option.spread))),
    `${league}: every projected spread is a real number`,
  );
}

console.log(
  "Ratings fit OK: lines recover known ratings and price an unposted game, margins are capped, " +
    "an unseen team keeps what it shipped with, the fit is order-independent and beats its own " +
    "starting point out of sample, and the board takes it only where the market is silent.",
);
