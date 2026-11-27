#!/usr/bin/env node
/**
 * The coach's ghost run for a pool that is out (core/ghost.js).
 *
 * On the NFL board as it stands: a pool that starts in week 9 and loses it,
 * then the ghost played on the way app.js plays it - a call for each week
 * since, each made from the board as it stood when its week began - and the
 * board read back with those calls kept. What has to hold:
 *
 *   - the weeks owed are the weeks since the loss, and none once kept
 *   - no hindsight: a call is the same whatever its week's results turned out
 *     to be, and is made with no line the books had not posted yet
 *   - no team twice: a ghost call never spends a team the pool locked or an
 *     earlier ghost call took, and the plan for the weeks ahead spends none of
 *     them either
 *   - the board draws the calls with how they went, and its record and the
 *     coach's scorecard count them
 *   - two phones keeping calls for different weeks both keep theirs
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { buildBoard, lineKey, slotKey } from "../src/js/core/plan.js";
import { ghostCallFrom, ghostInputs, ghostOwed, kickedOff } from "../src/js/core/ghost.js";
import { mergeEntries } from "../src/js/store/merge.js";
import { CONFIG } from "../src/js/config.js";

const read = async (name) =>
  JSON.parse(await readFile(new URL(`../data/nfl/${name}`, import.meta.url), "utf8"));
const [plan, odds, teams, schedule, ratings, calibration, form] = await Promise.all(
  [
    "plan.json",
    "odds.json",
    "teams.json",
    "schedule.json",
    "ratings.json",
    "calibration.json",
    "form.json",
  ].map((name) => read(name).catch(() => null)),
);

// A pool that starts in week 9 and locks a team that lost there.
const lossWeek = 9;
const loser = Object.entries(odds.results)
  .find(([key, result]) => key.startsWith(`${lossWeek}|`) && result === "L")?.[0]
  .split("|")[1];
assert.ok(loser, "the feed has a week-9 loser to lose with");
const entry = {
  picks: { [slotKey(lossWeek, 0)]: { locked: true } },
  swaps: { [slotKey(lossWeek, 0)]: loser },
  rules: { startWeek: lossWeek },
};
const inputs = (given) => ({
  plan,
  odds,
  teams,
  schedule,
  ratings,
  calibration,
  form,
  entry: given,
  refreshSchedule: CONFIG.refresh,
});

const out = buildBoard(inputs(entry));
assert.equal(out.eliminated, true);
assert.equal(out.eliminatedWeek, lossWeek);
assert.equal(out.ghost, null, "no ghost until a call is kept");
const owed = ghostOwed(out, entry);
assert.deepEqual(
  owed,
  Array.from({ length: odds.currentWeek - lossWeek }, (_, index) => lossWeek + 1 + index),
  "every week since the loss is owed a call",
);

// Played on, as app.js plays it.
const kept = { ...entry, ghost: {} };
for (const week of owed) {
  const asOf = ghostInputs(inputs(kept), week);
  assert.equal(asOf.odds.currentWeek, week);
  assert.deepEqual(asOf.odds.results, {}, "no result reaches the call");
  assert.ok(
    Object.keys(asOf.odds.lines).every((key) => Number(key.split("|")[0]) <= week),
    "and no line the books had not posted by then",
  );
  const board = buildBoard(asOf);
  assert.equal(board.eliminated, false, "the ghost's board is a board still playing");
  const call = ghostCallFrom(board, week);
  assert.ok(call, `a call for week ${week}`);
  assert.ok(!call.teams.includes(loser), "never the team the pool lost with");
  for (const earlier of Object.values(kept.ghost)) {
    for (const team of call.teams) assert.ok(!earlier.teams.includes(team), "no team twice");
  }
  if (week < odds.currentWeek) {
    assert.equal(call.live, false, "a past week's call is rebuilt, and says so");
    assert.equal(kickedOff(call), true);
  }
  kept.ghost[week] = call;
}
const onTheClock = kept.ghost[odds.currentWeek];
assert.deepEqual(
  ghostOwed(buildBoard(inputs(kept)), kept),
  onTheClock && !kickedOff(onTheClock) ? [odds.currentWeek] : [],
  "and once kept, only a live call still to kick off is owed again",
);

// No hindsight: the same week's call with its results turned upside down.
const lastPlayed = owed.filter((week) => week < odds.currentWeek).at(-1);
if (lastPlayed) {
  const flipped = {
    ...odds,
    results: Object.fromEntries(
      Object.entries(odds.results).map(([key, result]) => [key, result === "W" ? "L" : "W"]),
    ),
  };
  const before = {
    ...kept,
    ghost: Object.fromEntries(
      Object.entries(kept.ghost).filter(([week]) => Number(week) < lastPlayed),
    ),
  };
  const straight = ghostCallFrom(buildBoard(ghostInputs(inputs(before), lastPlayed)), lastPlayed);
  const upsideDown = ghostCallFrom(
    buildBoard(ghostInputs({ ...inputs(before), odds: flipped }, lastPlayed)),
    lastPlayed,
  );
  assert.deepEqual(upsideDown.teams, straight.teams, "a call does not know how its week went");
}

// The board read back with the calls kept.
const ghosted = buildBoard(inputs(kept));
assert.ok(ghosted.ghost, "the board knows its ghost");
for (const week of owed) {
  const shown = ghosted.weeks.find((entry) => entry.week === week);
  assert.deepEqual(
    shown.pathRecommendation.map((option) => option.team),
    kept.ghost[week].teams,
    `week ${week} draws the ghost's call`,
  );
  assert.ok(shown.picks[0].suggestion?.ghost, "as the slot's ghost pick");
  const result = odds.results[lineKey(week, kept.ghost[week].teams[0])] ?? null;
  assert.equal(shown.ghost.result, result, "with how it went");
}
const record = ghosted.ghostRecord;
assert.equal(record.weeks, owed.length);
assert.equal(record.won + record.lost + record.pending, owed.length);
const firstLoss = owed.find(
  (week) => odds.results[lineKey(week, kept.ghost[week].teams[0])] === "L",
);
assert.equal(record.outWeek, firstLoss ?? null, "out at its own first loss, or still in");
assert.ok(ghosted.coachRecord, "and the coach's calls are graded");
assert.equal(
  ghosted.coachRecord.weeks.filter((week) => week.ghost).length,
  record.won + record.lost,
  "every played ghost week among them",
);

// The plan for the weeks ahead spends nothing the ghost has.
const spent = new Set(Object.values(kept.ghost).flatMap((call) => call.teams));
for (const [week, picked] of Object.entries(ghosted.recommendation.picks ?? {})) {
  if (Number(week) <= odds.currentWeek) continue;
  for (const team of picked) assert.ok(!spent.has(team), `week ${week} plans no ghost team`);
}

// Two phones, two weeks: both calls kept.
const [weekA, weekB] = owed;
const base = { ...entry };
const mine = { ...entry, ghost: { [weekA]: kept.ghost[weekA] } };
const theirs = { ...entry, ghost: { [weekB]: kept.ghost[weekB] } };
assert.deepEqual(
  Object.keys(mergeEntries(base, mine, theirs).ghost)
    .map(Number)
    .sort((a, b) => a - b),
  [weekA, weekB].sort((a, b) => a - b),
);
assert.equal(mergeEntries(base, base, base).ghost, undefined, "and none appears from nowhere");

console.log(
  `Ghost OK: a pool out in week ${lossWeek} plays on as the coach's ghost - ` +
    `${record.won}-${record.lost}${record.outWeek ? `, out in week ${record.outWeek}` : ", still in"} - ` +
    `with every call made blind to its week's result and no team spent twice.`,
);
