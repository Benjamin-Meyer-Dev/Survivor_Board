#!/usr/bin/env node
/**
 * The pool rules a board can be given from the settings sheet.
 *
 * Two halves. First core/rules.js on its own: what it does with an override
 * that is missing, absurd, hand-edited or from an older version of the app.
 * The rules arrive from a shared document that anything may have written, and
 * the promise is that no value in it can produce a board that does not work -
 * so every clamp is checked here rather than trusted in the UI, which is only
 * one of the ways a rule can arrive.
 *
 * Then the same overrides through buildBoard, because a clamped rule that does
 * not reach the model is no rule at all: the objective has to re-price the
 * week, the picks-per-week has to change what a week holds, and the buy back
 * has to decide whether a loss ends the run.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { buildBoard, rulesOf, lineKey, slotKey } from "../src/js/core/plan.js";
import {
  mergeRules,
  sameRules,
  onlyEditable,
  EDITABLE_RULES,
  MAX_PICKS_PER_WEEK,
  MAX_BUY_BACKS,
} from "../src/js/core/rules.js";
import { CONFIG } from "../src/js/config.js";
import {} from "../src/js/sports.js";

// ---------------------------------------------------------------------------
// core/rules.js
// ---------------------------------------------------------------------------

const weeks18 = Array.from({ length: 18 }, (_, index) => index + 1);
const nflRules = { picksPerWeek: 1, buyBacks: 1, buyBackWeeks: [1, 2] };

// Nothing saved: the plan's own rules, untouched.
assert.deepEqual(mergeRules(nflRules, null, weeks18), {
  objective: "win",
  picksPerWeek: 1,
  buyBacks: 1,
  buyBackWeeks: [1, 2],
});

// An override wins, key by key, and says nothing about the keys it omits.
assert.equal(mergeRules(nflRules, { objective: "lose" }, weeks18).objective, "lose");
assert.equal(mergeRules(nflRules, { objective: "lose" }, weeks18).picksPerWeek, 1);
assert.equal(mergeRules(nflRules, { picksPerWeek: 3 }, weeks18).picksPerWeek, 3);
assert.equal(mergeRules(nflRules, { objective: "sideways" }, weeks18).objective, "win");
assert.equal(mergeRules({}, {}, weeks18).picksPerWeek, 2, "the default pool takes two a week");

// Picks a week has a floor of one - a week that holds nothing is not a pool -
// and a ceiling the sheet also offers.
assert.equal(mergeRules(nflRules, { picksPerWeek: 0 }, weeks18).picksPerWeek, 1);
assert.equal(mergeRules(nflRules, { picksPerWeek: -4 }, weeks18).picksPerWeek, 1);
assert.equal(mergeRules(nflRules, { picksPerWeek: 99 }, weeks18).picksPerWeek, MAX_PICKS_PER_WEEK);
assert.equal(mergeRules(nflRules, { picksPerWeek: 2.7 }, weeks18).picksPerWeek, 2);
assert.equal(mergeRules(nflRules, { picksPerWeek: "3" }, weeks18).picksPerWeek, 3);
assert.equal(mergeRules(nflRules, { picksPerWeek: "many" }, weeks18).picksPerWeek, 1);
assert.equal(mergeRules(nflRules, { picksPerWeek: null }, weeks18).picksPerWeek, 1);

// Buy back weeks: only weeks the season has, each once, in order.
assert.deepEqual(mergeRules(nflRules, { buyBackWeeks: [3, 1, 3] }, weeks18).buyBackWeeks, [1, 3]);
assert.deepEqual(mergeRules(nflRules, { buyBackWeeks: [19, 0, -2] }, weeks18).buyBackWeeks, []);
assert.deepEqual(
  mergeRules(nflRules, { buyBackWeeks: "week one" }, weeks18).buyBackWeeks,
  [1, 2],
  "an override that is not a list at all is no override: the plan's weeks stand",
);
assert.deepEqual(
  mergeRules(nflRules, { buyBackWeeks: [2, 1] }, []).buyBackWeeks,
  [1, 2],
  "with no calendar to check against, the weeks are taken as given",
);

// A buy back needs a week to spend itself in, so the weeks are its ceiling.
// This is the one rule the two fields can contradict, and it can only resolve
// one way: a cushion that could never apply is not a cushion.
assert.equal(mergeRules(nflRules, { buyBacks: 3, buyBackWeeks: [] }, weeks18).buyBacks, 0);
assert.equal(mergeRules(nflRules, { buyBacks: 3, buyBackWeeks: [1] }, weeks18).buyBacks, 1);
assert.equal(mergeRules(nflRules, { buyBacks: -1 }, weeks18).buyBacks, 0);
assert.equal(
  mergeRules(nflRules, { buyBacks: 99, buyBackWeeks: weeks18 }, weeks18).buyBacks,
  MAX_BUY_BACKS,
);

// Anything else in the document is not a rule and is ignored, so a future key
// or a stray edit cannot arrive as one.
assert.deepEqual(
  Object.keys(mergeRules(nflRules, { nonsense: true }, weeks18)).sort(),
  [...EDITABLE_RULES].sort(),
);
assert.deepEqual(
  Object.keys(onlyEditable(mergeRules(nflRules, null, weeks18))).sort(),
  [...EDITABLE_RULES].sort(),
);

// Same rules, said two ways.
const base = mergeRules(nflRules, null, weeks18);
assert.equal(sameRules(base, mergeRules(nflRules, { buyBackWeeks: [2, 1] }, weeks18)), true);
assert.equal(sameRules(base, mergeRules(nflRules, { buyBackWeeks: [1] }, weeks18)), false);
assert.equal(sameRules(base, mergeRules(nflRules, { objective: "lose" }, weeks18)), false);
assert.equal(sameRules(base, { ...base, tiers: { safe: 0.9 } }), true, "tiers are not a rule");

// ---------------------------------------------------------------------------
// Through the board.
// ---------------------------------------------------------------------------

const read = async (league, name) =>
  JSON.parse(await readFile(new URL(`../data/${league}/${name}`, import.meta.url), "utf8"));

const load = async (league) => {
  const [plan, odds, teams, schedule, ratings] = await Promise.all(
    ["plan.json", "odds.json", "teams.json", "schedule.json", "ratings.json"].map((name) =>
      read(league, name),
    ),
  );
  return { plan, odds, teams, schedule, ratings };
};

const nfl = await load("nfl");
const cfb = await load("cfb");

const boardFor = (league, entry, odds = league.odds) =>
  buildBoard({ ...league, odds, entry, refreshSchedule: CONFIG.refresh });

const nothing = () => ({ picks: {}, swaps: {} });
const withRules = (rules) => ({ ...nothing(), rules });

// A pool with nothing saved runs its plan's rules and says so.
const plain = boardFor(nfl, nothing());
assert.deepEqual(onlyEditable(plain.rules), onlyEditable(plain.ruleDefaults));
assert.equal(plain.rulesCustom, false, "an untouched pool is not running its own rules");
assert.deepEqual(onlyEditable(plain.ruleDefaults), onlyEditable(rulesOf(nfl.plan)));

// The objective, changed from the board: the same turn the losers pool gets
// from its plan file (see core/objective.js), from a saved rule instead.
const flipped = boardFor(nfl, withRules({ objective: "lose" }));
assert.equal(flipped.rules.objective, "lose");
assert.equal(flipped.rulesCustom, true, "and the board knows the pool has its own rules");

const openWeek = (board) => board.weeks.find((week) => week.week === board.currentWeek);
const plainWeek = openWeek(plain);
const flippedWeek = openWeek(flipped);
const plainProb = new Map(plainWeek.options.map((option) => [option.team, option.winProb]));
for (const option of flippedWeek.options) {
  assert.ok(
    Math.abs(option.winProb - (1 - plainProb.get(option.team))) < 1e-12,
    `${option.team}: a flipped board prices the other side of the same number`,
  );
}
assert.ok(
  flippedWeek.options[0].spread > 0 && plainWeek.options[0].spread < 0,
  "and its list opens on the biggest underdog",
);
// The coach follows the rule it was given rather than the one its plan ships.
// Without the buy back, because a forgiving week is meant to take a pick that
// probably fails - in a losers pool that is a favourite, and it would read
// here as the objective not having landed.
const flippedHard = boardFor(nfl, withRules({ objective: "lose", buyBacks: 0, buyBackWeeks: [] }));
for (const week of flippedHard.weeks) {
  for (const call of week.pathRecommendation) {
    assert.ok(call.spread > 0, `week ${week.week}: ${call.team} is an underdog on the path`);
  }
}
assert.ok(flippedHard.recommendation.pathProbability > 0, "and the season it plans is a real one");

// A rule change is a different search, and the memo has to know it. The
// signature used to carry the buy backs and the week but not the objective,
// so flipping a pool to picking losers came back out of the cache with the
// plan it had made for picking winners: the same teams, at one minus their
// probabilities, which is exactly the plan those rules should never produce.
const winnersAgain = boardFor(nfl, nothing());
const callsOf = (board) =>
  board.weeks.flatMap((week) => week.pathRecommendation.map((call) => call.team));
assert.deepEqual(
  callsOf(winnersAgain),
  callsOf(plain),
  "the same rules do come back out of the cache",
);
assert.notDeepEqual(callsOf(flippedHard), callsOf(plain), "and different rules never do");
for (const week of winnersAgain.weeks) {
  for (const call of week.pathRecommendation) {
    assert.ok(
      call.spread < 0 || week.isBuyBack,
      `week ${week.week}: back on the plan's rules, ${call.team} is a favourite again`,
    );
  }
}

// Picks a week, raised on a one-pick pool: the week holds two slots, both of
// them pickable, and the coach fills both.
const doubled = boardFor(nfl, withRules({ picksPerWeek: 2 }));
assert.equal(doubled.rules.picksPerWeek, 2);
for (const week of doubled.weeks) {
  assert.equal(week.picks.length, 2, `week ${week.week} holds two slots`);
}
const doubledWeek = openWeek(doubled);
assert.equal(doubledWeek.pathRecommendation.length, 2, "the coach calls both slots");
assert.notEqual(
  doubledWeek.pathRecommendation[0].team,
  doubledWeek.pathRecommendation[1].team,
  "and never the same team twice in one week",
);

// Picks a week, lowered on a two-pick pool. A pick saved in the slot that goes
// away is kept, not deleted: the entry is keyed by week and slot, so the rule
// changes what the board shows rather than what it holds.
const cfbWeek = openWeek(boardFor(cfb, nothing()));
const [firstTeam, secondTeam] = cfbWeek.options.slice(0, 2).map((option) => option.team);
const bothSlots = {
  picks: {
    [slotKey(cfbWeek.week, 0)]: { locked: true },
    [slotKey(cfbWeek.week, 1)]: { locked: true },
  },
  swaps: {
    [slotKey(cfbWeek.week, 0)]: firstTeam,
    [slotKey(cfbWeek.week, 1)]: secondTeam,
  },
};

const twoOfTwo = boardFor(cfb, bothSlots);
assert.equal(twoOfTwo.spentCount, 2, "two locks spend two teams");

const oneOfTwo = boardFor(cfb, { ...bothSlots, rules: { picksPerWeek: 1 } });
const narrowed = oneOfTwo.weeks.find((week) => week.week === cfbWeek.week);
assert.equal(narrowed.picks.length, 1, "the week shows one slot");
assert.equal(narrowed.picks[0].team, firstTeam, "and it is the first one");
assert.equal(oneOfTwo.spentCount, 1, "a slot the rules do not hold spends nothing");
assert.equal(oneOfTwo.spentTeams[secondTeam], undefined, "so the team it held is available again");
assert.ok(
  narrowed.picks[0].options.some((option) => option.team === secondTeam && !option.disabled),
  "and pickable",
);

// Raised back: the pick that was hidden is exactly where it was.
const restored = boardFor(cfb, { ...bothSlots, rules: { picksPerWeek: 2 } });
const restoredWeek = restored.weeks.find((week) => week.week === cfbWeek.week);
assert.equal(restoredWeek.picks[1].team, secondTeam, "the hidden pick comes back with the slot");
assert.equal(restoredWeek.picks[1].status.locked, true, "still locked");
assert.equal(restored.spentCount, 2);

// Buy backs, through the survival maths. One loss in a covered week, read by
// three rule sets: the plan's, one that stops covering that week, and one that
// grants no buy back at all.
const lossWeek = openWeek(plain).week;
const losingTeam = openWeek(plain).options[0].team;
const lostOdds = {
  ...nfl.odds,
  updatedAt: `${nfl.odds.updatedAt}-settings`,
  results: { ...nfl.odds.results, [lineKey(lossWeek, losingTeam)]: "L" },
};
const lostEntry = {
  picks: { [slotKey(lossWeek, 0)]: { locked: true } },
  swaps: { [slotKey(lossWeek, 0)]: losingTeam },
};

const covered = boardFor(
  nfl,
  { ...lostEntry, rules: { buyBacks: 1, buyBackWeeks: [lossWeek] } },
  lostOdds,
);
assert.equal(covered.eliminated, false, "a covered loss does not end the run");
assert.equal(covered.buyBack.used, 1, "it spends the buy back");
assert.equal(covered.buyBack.left, 0);

const elsewhere = boardFor(
  nfl,
  { ...lostEntry, rules: { buyBacks: 1, buyBackWeeks: [lossWeek === 18 ? 17 : lossWeek + 1] } },
  lostOdds,
);
assert.equal(elsewhere.eliminated, true, "a buy back on another week covers nothing");

const none = boardFor(nfl, { ...lostEntry, rules: { buyBacks: 0, buyBackWeeks: [] } }, lostOdds);
assert.equal(none.eliminated, true, "and a pool with none is out on the first loss");
assert.equal(none.buyBack, null, "with no cushion to show on the strip");
assert.equal(none.eliminatedWeek, lossWeek);

// The weeks marked forgiving are the ones the deck badges, whatever the plan
// said.
const movedWeeks = boardFor(nfl, withRules({ buyBacks: 1, buyBackWeeks: [4, 5] }));
assert.deepEqual(
  movedWeeks.weeks.filter((week) => week.isBuyBack).map((week) => week.week),
  [4, 5],
);

// A document nobody sane wrote. Every value is refused and the board still
// builds, plans and prices.
const junk = boardFor(
  nfl,
  withRules({
    objective: 42,
    picksPerWeek: "lots",
    buyBacks: "one",
    buyBackWeeks: [99, "three", null],
    somethingElse: { deeply: "wrong" },
  }),
);
assert.equal(junk.rules.objective, "win");
assert.equal(junk.rules.picksPerWeek, 1);
assert.equal(junk.rules.buyBacks, 0);
assert.deepEqual(junk.rules.buyBackWeeks, []);
assert.equal(junk.rulesCustom, true, "it is still not the plan's rules");
assert.ok(openWeek(junk).picks[0].suggestion?.team, "and the coach still has a call");

console.log(
  "Settings OK: pool rules merge over the plan and clamp to a coherent set, a buy back " +
    "cannot outnumber the weeks it covers, junk in the shared entry cannot break a board, " +
    "and the objective, the slots and the buy backs all reach the model.",
);
