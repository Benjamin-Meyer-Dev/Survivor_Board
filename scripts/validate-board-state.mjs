#!/usr/bin/env node
/**
 * Regression checks for the boundary between coach advice and user picks.
 *
 * The coach suggests; it never picks. A slot holds a team only when a user put
 * one there, a team is spent only when a user locked it, and the coach plans
 * the rest of the season around the locks and nothing else.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildBoard, lineKey, slotKey } from "../src/js/core/plan.js";
import { CONFIG } from "../src/js/config.js";
import { confidenceTier, TIER_LABEL } from "../src/js/core/probability.js";

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

const nothing = () => ({ picks: {}, swaps: {} });

// Close favourites and actual underdogs must never share the same warning.
assert.equal(confidenceTier(0.645, plan.tiers), "close");
assert.equal(TIER_LABEL.close, "Close Call");
assert.equal(confidenceTier(0.5, plan.tiers), "close");
assert.equal(confidenceTier(0.499, plan.tiers), "danger");
assert.equal(TIER_LABEL.danger, "Upset Alert");

// An untouched board: no team in any slot, nothing spent, and a suggestion
// standing in for every open slot.
const empty = build(nothing());
const first = empty.weeks[0].picks[0];
assert.equal(first.team, null, "an untouched slot holds no team");
assert.equal(first.status.picked, false);
assert.equal(first.status.locked, false);
assert.equal(empty.spentCount, 0, "coach suggestions must not spend teams");
assert.equal(empty.pickedCount, 0);
assert.ok(first.suggestion?.team, "the coach suggests a team for an open slot");
assert.equal(first.onPath?.kind, "coach", "the path shows the suggestion as the coach's");
assert.equal(
  empty.weeks[0].pathTier,
  confidenceTier(empty.weeks[0].pathWinProb, plan.tiers),
  "the combined weekly probability uses the same confidence scale",
);
assert.ok(empty.plannedCount > 0, "the coach path is represented separately");
assert.equal(
  empty.weeks.at(-1).seasonWinProb,
  empty.pathProbability,
  "the last cumulative week matches season survival",
);
assert.ok(
  first.options.some((option) => option.isCoach && option.team === first.suggestion.team),
  "the coach's call is badged in the team list",
);

const key = slotKey(first.week, first.slot);
const coachTeam = first.suggestion.team;
// A team the coach did NOT suggest, so the two can be told apart below.
const other = first.options.find(
  (option) =>
    !option.disabled && option.team !== coachTeam && option.team !== plan.weeks[0].picks[0].team,
).team;

// Finals for both teams, so the feed has something to hand out.
const withFeedResult = structuredClone(odds);
withFeedResult.updatedAt = `${odds.updatedAt}-state-check`;
withFeedResult.results[lineKey(first.week, coachTeam)] = "W";
withFeedResult.results[lineKey(first.week, other)] = "W";

// A feed result cannot turn a suggestion into a pick.
const advised = build(nothing(), withFeedResult);
assert.equal(advised.weeks[0].picks[0].team, null, "the feed cannot pick a team");
assert.equal(advised.weeks[0].picks[0].status.result, null, "advice cannot receive a result");

// Picking a team is not locking it: nothing is spent, no result lands, and the
// coach's plan does not move.
const picked = build({ picks: {}, swaps: { [key]: other } }, withFeedResult);
const pickedSlot = picked.weeks[0].picks[0];
assert.equal(pickedSlot.team, other, "the slot holds the team the user picked");
assert.equal(pickedSlot.status.picked, true);
assert.equal(pickedSlot.status.locked, false);
assert.equal(pickedSlot.onPath.kind, "picked");
assert.equal(picked.spentCount, 0, "an unlocked pick spends nothing");
assert.equal(picked.pickedTeams[other], first.week, "an unlocked pick is marked as picked");
assert.equal(pickedSlot.status.result, null, "an unlocked pick receives no feed result");
assert.equal(pickedSlot.isRecommended, false, "a pick the coach did not make is not badged");
assert.deepEqual(
  picked.recommendation.picks,
  advised.recommendation.picks,
  "the coach re-plans on a lock, not on a pick",
);
assert.equal(
  picked.pathProbability,
  advised.pathProbability,
  "an unlocked pick must not change committed season survival",
);
assert.equal(typeof picked.previewPathProbability, "number");
assert.equal(
  picked.weeks.at(-1).seasonWinProb,
  picked.previewPathProbability,
  "cumulative survival previews an unlocked pick",
);
assert.ok(
  pickedSlot.options.some((option) => option.isCoach && option.team === coachTeam),
  "the coach's call stays badged while a different team is picked",
);

// Locking commits: the team is spent, the final lands, and the coach plans the
// rest of the season around it.
const locked = build(
  { picks: { [key]: { locked: true } }, swaps: { [key]: other } },
  withFeedResult,
);
const lockedSlot = locked.weeks[0].picks[0];
assert.equal(lockedSlot.team, other);
assert.equal(lockedSlot.status.locked, true);
assert.equal(lockedSlot.onPath.kind, "locked");
assert.equal(locked.spentCount, 1, "a locked pick spends its team");
assert.equal(locked.spentTeams[other], first.week);
assert.equal(lockedSlot.status.result, "W", "locked picks receive feed results");
assert.equal(lockedSlot.status.resultSource, "final");
assert.equal(locked.previewPathProbability, null, "the preview is adopted and cleared on lock");
assert.equal(
  locked.weeks.at(-1).seasonWinProb,
  locked.pathProbability,
  "cumulative survival adopts the locked path",
);
assert.equal(locked.plannedTeams[other], undefined, "a locked team is not a coach-plan team");
assert.equal(locked.pickedTeams[other], undefined, "a locked team is no longer merely picked");
assert.equal(lockedSlot.isRecommended, false, "a locked team earns no coach badge");
assert.ok(
  locked.weeks[0].recommended.some((option) => option.team === other),
  "the coach's weekly call honours the lock",
);
assert.ok(
  locked.weeks.slice(1).every((week) => week.recommended.every((option) => option.team !== other)),
  "the coach builds the future path around the lock",
);
assert.ok(
  locked.weeks
    .slice(1)
    .every((week) =>
      week.picks.every(
        (pick) => pick.options.find((option) => option.team === other)?.disabled ?? true,
      ),
    ),
  "a locked team is unavailable in every other week",
);

// Entries saved before slots were user-picked locked the authored plan's team
// without storing it. That is still a lock on that team.
const legacy = build({ picks: { [key]: { locked: true } }, swaps: {} });
assert.equal(
  legacy.weeks[0].picks[0].team,
  plan.weeks[0].picks[0].team,
  "a legacy lock resolves to the authored plan's team",
);
assert.equal(legacy.weeks[0].picks[0].status.locked, true);

console.log(
  "Board state OK: slots are user-picked, coach plans stay advisory, locks own burns and results.",
);
