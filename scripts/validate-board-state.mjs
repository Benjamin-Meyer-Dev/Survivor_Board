#!/usr/bin/env node
/** Regression checks for the boundary between coach advice and user picks. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildBoard, lineKey, slotKey } from "../src/js/core/plan.js";
import { CONFIG } from "../src/js/config.js";

const readJson = async (name) =>
  JSON.parse(await readFile(new URL(`../data/nfl/${name}`, import.meta.url), "utf8"));

const [plan, odds, teams, schedule, ratings] = await Promise.all(
  ["plan.json", "odds.json", "teams.json", "schedule.json", "ratings.json"].map(readJson),
);

const build = (entry, sourceOdds = odds) =>
  buildBoard({
    plan,
    odds: sourceOdds,
    teams,
    schedule,
    ratings,
    entry,
    refreshSchedule: CONFIG.refresh,
  });

const empty = build({ picks: {}, swaps: {} });
assert.equal(empty.spentCount, 0, "coach suggestions must not spend teams");
assert.equal(empty.weeks[0].picks[0].status.selected, false);
assert.ok(empty.plannedCount > 0, "the coach path should be represented separately");

const first = empty.weeks[0].picks[0];
const withFeedResult = structuredClone(odds);
withFeedResult.updatedAt = `${odds.updatedAt}-state-check`;
withFeedResult.results[lineKey(first.week, first.team)] = "W";

const advised = build({ picks: {}, swaps: {} }, withFeedResult);
assert.equal(advised.weeks[0].picks[0].status.result, null, "advice cannot receive a result");
assert.equal(advised.weeks[0].picks[0].status.selected, false, "the feed cannot select a pick");

const selected = build(
  {
    picks: { [slotKey(first.week, first.slot)]: { locked: true } },
    swaps: {},
  },
  withFeedResult,
);
assert.equal(selected.spentCount, 1, "a user selection must spend its team");
assert.equal(selected.spentTeams[first.team], first.week);
assert.equal(selected.weeks[0].picks[0].status.selected, true);
assert.equal(selected.weeks[0].picks[0].status.result, "W", "selected picks receive feed results");
assert.equal(
  selected.plannedTeams[first.team],
  undefined,
  "selected teams are not coach-plan teams",
);
assert.ok(
  selected.weeks[0].recommended.some((pick) => pick.team === first.team),
  "the coach must honor a selected team in its weekly call",
);
assert.ok(
  selected.weeks
    .slice(1)
    .every((week) => week.recommended.every((pick) => pick.team !== first.team)),
  "the coach must build the future path around selected teams",
);

console.log("Board state OK: coach plans stay advisory; user selections own burns and results.");
