#!/usr/bin/env node
/**
 * The pool picker's read of a pool it is not showing must match the board.
 *
 * core/standing.js works out whether a run is over without building the board -
 * the rules, the locks and the recorded finals, and none of the pricing or the
 * search. That is the same question buildBoard answers at the end of a great
 * deal more work, and two answers to one question is exactly the kind of thing
 * that agrees on the day it is written and drifts afterwards. So every case
 * here is checked BOTH ways: what the board says, and what the picker says.
 *
 * The cases are the ones that actually separate the two readings - a loss no
 * buy back covers, a loss one does, a pick nobody locked, a result typed in
 * over the feed's, a losers pool where the finals mean the opposite, a lock
 * from before slots carried their team, and a week outside the pool's own run.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildBoard, lineKey, slotKey } from "../src/js/core/plan.js";
import { poolStanding } from "../src/js/core/standing.js";
import { CONFIG } from "../src/js/config.js";

const readJson = async (sport, name) =>
  JSON.parse(await readFile(new URL(`../data/${sport}/${name}`, import.meta.url), "utf8"));

const [plan, odds, teams, schedule, ratings] = await Promise.all(
  ["plan.json", "odds.json", "teams.json", "schedule.json", "ratings.json"].map((name) =>
    readJson("nfl", name),
  ),
);

/** A team the feed says lost its week-1 game, and one it says won. */
const finals = Object.entries(odds.results ?? {}).filter(([key]) => key.startsWith("1|"));
const LOSER = finals.find(([, result]) => result === "L")?.[0].split("|")[1];
const WINNER = finals.find(([, result]) => result === "W")?.[0].split("|")[1];
assert.ok(LOSER && WINNER, "week 1 has a recorded win and a recorded loss to read");

/**
 * Both readings of one entry, so every case below is one call and neither
 * reading can quietly stop being checked.
 */
function both(entry, { objective = "win", feed = odds } = {}) {
  const pool = { ...plan, rules: { ...plan.rules, objective } };
  const board = buildBoard({
    plan: pool,
    odds: feed,
    teams,
    schedule,
    ratings,
    entry,
    refreshSchedule: CONFIG.refresh,
    allowSearch: false,
  });
  const standing = poolStanding({ plan: pool, odds: feed, entry, objective });
  return { board, standing };
}

/** The two readings agree, and the one they agree on is the one expected. */
function agree(label, entry, expected, options) {
  const { board, standing } = both(entry, options);
  assert.equal(board.eliminated, expected.eliminated, `${label}: the board`);
  assert.equal(standing.eliminated, expected.eliminated, `${label}: the picker`);
  assert.equal(board.eliminatedWeek ?? null, expected.week ?? null, `${label}: the board's week`);
  assert.equal(
    standing.eliminatedWeek ?? null,
    expected.week ?? null,
    `${label}: the picker's week`,
  );
  assert.deepEqual(standing.record, board.record, `${label}: the record`);
  return { board, standing };
}

const lock = (week, slot, team, extra = {}) => ({
  picks: { [slotKey(week, slot)]: { locked: true, ...extra } },
  swaps: { [slotKey(week, slot)]: team },
});

/* An untouched pool is alive, with nothing on its record. */
agree("nothing locked", { picks: {}, swaps: {} }, { eliminated: false });

/* A locked pick the feed says lost ends the run, in the week it lost. */
agree("a locked loss", lock(1, 0, LOSER), { eliminated: true, week: 1 });

/* A locked pick the feed says won does not. */
agree("a locked win", lock(1, 0, WINNER), { eliminated: false });

/* A team put in a slot and never locked is not this entry's pick, whatever the
   feed says about its game - the feed cannot commit a choice for anybody. */
agree(
  "a pick nobody locked",
  { picks: {}, swaps: { [slotKey(1, 0)]: LOSER } },
  {
    eliminated: false,
  },
);

/* A result saved against a slot is a committed pick whether or not `locked` was
   saved with it: a game cannot be won or lost by a slot nobody picked, which is
   how core/plan.js reads it. */
agree(
  "a result with no lock saved beside it",
  { picks: { [slotKey(1, 0)]: { result: "L" } }, swaps: { [slotKey(1, 0)]: WINNER } },
  { eliminated: true, week: 1 },
);

/* A result typed in by hand stands over the feed's, in both directions. */
agree("a loss typed in over a win", lock(1, 0, WINNER, { result: "L" }), {
  eliminated: true,
  week: 1,
});
agree("a win typed in over a loss", lock(1, 0, LOSER, { result: "W" }), { eliminated: false });

/* A losers pool advances on the loss, so the two finals mean the opposite. */
agree(
  "a losers pool on the team that lost",
  lock(1, 0, LOSER),
  { eliminated: false },
  {
    objective: "lose",
  },
);
agree(
  "a losers pool on the team that won",
  lock(1, 0, WINNER),
  { eliminated: true, week: 1 },
  {
    objective: "lose",
  },
);

/* A buy back covers the loss in a week the pool forgives, and the next one
   ends the run. The second loss is written into a copy of the feed rather than
   looked for in it: the shipped odds are whatever the season has got to, and a
   case that only runs while week 2 happens to hold a loss is a case that stops
   running. A team with a week-2 line is one the board can price and resolve. */
const SECOND = Object.keys(odds.lines ?? {})
  .find((key) => key.startsWith("2|"))
  ?.split("|")[1];
assert.ok(SECOND, "week 2 has a priced team to record a final against");

const played = { ...odds, results: { ...odds.results, [lineKey(2, SECOND)]: "L" } };

agree(
  "a buy back covers the first loss and not the second",
  {
    picks: { [slotKey(1, 0)]: { locked: true }, [slotKey(2, 0)]: { locked: true } },
    swaps: { [slotKey(1, 0)]: LOSER, [slotKey(2, 0)]: SECOND },
    rules: { buyBacks: 1, buyBackWeeks: [1] },
  },
  { eliminated: true, week: 2 },
  { feed: played },
);

agree(
  "a buy back covers the only loss",
  {
    picks: { [slotKey(1, 0)]: { locked: true } },
    swaps: { [slotKey(1, 0)]: LOSER },
    rules: { buyBacks: 1, buyBackWeeks: [1] },
  },
  { eliminated: false },
  { feed: played },
);

/* A buy back is spent on the week it covers, not saved for a later one: a pool
   that forgives week 2 and loses week 1 is out in week 1. */
agree(
  "a buy back that does not cover the week the loss came in",
  {
    picks: { [slotKey(1, 0)]: { locked: true } },
    swaps: { [slotKey(1, 0)]: LOSER },
    rules: { buyBacks: 1, buyBackWeeks: [2] },
  },
  { eliminated: true, week: 1 },
);

/* A lock saved before slots carried their team means the plan's own pick for
   that slot, which is how core/plan.js reads it too. Whichever way that pick's
   game went, the two readings have to go the same way. */
const authored = plan.weeks[0].picks[0].team;
const authoredResult = odds.results?.[lineKey(1, authored)] ?? null;
agree(
  "a legacy lock with no team named",
  { picks: { [slotKey(1, 0)]: { locked: true } }, swaps: {} },
  { eliminated: authoredResult === "L", week: authoredResult === "L" ? 1 : null },
);

/* A week outside the pool's own run is not the pool's to be eliminated in: a
   pool that starts in week 2 never played week 1, whatever is saved against it. */
agree(
  "a loss in a week the pool does not play",
  { ...lock(1, 0, LOSER), rules: { startWeek: 2 } },
  { eliminated: false },
);

/* And the losers pool's objective is the kind's, not the entry's: a stored
   override cannot turn a winners pool into a losers pool behind the picker,
   which is the rule the home page reads rules by too. */
const overridden = { ...lock(1, 0, LOSER), rules: { objective: "lose" } };
assert.equal(
  poolStanding({ plan, odds, entry: overridden, objective: "win" }).eliminated,
  true,
  "a stored objective does not change the kind the league was made with",
);

console.log(
  "Standing OK: the picker's read of a pool matches the board's for an untouched pool, a locked win and a locked loss, a pick nobody locked, results typed in either way, both objectives, a buy back spent and not, a legacy lock, a week outside the pool's run, and an objective the entry tried to override.",
);
