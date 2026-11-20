#!/usr/bin/env node
/**
 * Putting a played week right (core/amend.js).
 *
 * A missed lock is recorded on a final, a wrong lock is swapped for the team
 * actually played and takes that team's result rather than the old one's, and
 * a team taken back from a later week empties that week rather than spending
 * the team twice. A team an earlier week holds can never be corrected onto,
 * and a finished pool can be put right up to the week its run ended.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildBoard, slotKey } from "../src/js/core/plan.js";
import { CONFIG } from "../src/js/config.js";
import { amendable, amendEntry, amendImpact, fixableWeek } from "../src/js/core/amend.js";
import { atKickoff } from "./lib/feed.mjs";

const readJson = async (name) =>
  JSON.parse(await readFile(new URL(`../data/nfl/${name}`, import.meta.url), "utf8"));

const [plan, feed, teams, schedule, ratings] = await Promise.all(
  ["plan.json", "odds.json", "teams.json", "schedule.json", "ratings.json"].map(readJson),
);
const odds = atKickoff(feed);

const build = (entry) =>
  buildBoard({
    plan,
    odds,
    teams,
    schedule,
    ratings,
    entry,
    refreshSchedule: CONFIG.refresh,
    allowSearch: false,
  });

const nothing = () => ({ picks: {}, swaps: {} });
const lockOn = (entry, week, team, extra = {}) => {
  const key = slotKey(week, 0);
  return {
    ...entry,
    picks: { ...entry.picks, [key]: { locked: true, ...extra } },
    swaps: { ...entry.swaps, [key]: team },
  };
};
const slotOf = (board, week) => board.weeks.find((entry) => entry.week === week).picks[0];

const empty = build(nothing());
const played = empty.weeks.find((week) => week.week < empty.currentWeek);
assert.ok(played, "the feed has a played week before the one on the clock");
const later = empty.weeks.find((week) => week.week === empty.currentWeek);
assert.ok(later, "the season has a week on the clock");

// A team with a final in the played week and a game still to play in the week
// on the clock: the one a correction can take back from a later week.
const both = played.picks[0].options.find(
  (option) =>
    option.result &&
    later.picks[0].options.some((other) => other.team === option.team && !other.result),
);
assert.ok(both, "some team played the earlier week and plays the week on the clock");
const other = played.picks[0].options.find(
  (option) => option.result && option.team !== both.team && option.opponent !== both.team,
);
assert.ok(other, "the played week has a second final to swap from");

// Without a correction, a final cannot be picked: that is what this mends.
assert.equal(slotOf(empty, played.week).team, null, "a missed week holds nothing");
assert.ok(
  slotOf(empty, played.week).options.find((option) => option.team === both.team).disabled,
  "a final is not an ordinary pick",
);

// 1. A missed lock, recorded after the fact, holds and takes the feed's result.
{
  const { entry, displaced } = amendEntry(nothing(), empty, {
    week: played.week,
    slot: 0,
    team: both.team,
    by: "test",
    at: 1,
  });
  assert.deepEqual(displaced, []);
  const slot = slotOf(build(entry), played.week);
  assert.equal(slot.team, both.team);
  assert.equal(slot.status.locked, true);
  assert.equal(slot.status.result, both.result, "the result is the game's own");
  assert.equal(entry.picks[slotKey(played.week, 0)].amended.from, null);
}

// 2. A wrong lock, swapped: the old team's hand-tapped result goes with it.
{
  const wrong = lockOn(nothing(), played.week, other.team, { result: "L", spread: -3 });
  const board = build(wrong);
  assert.equal(slotOf(board, played.week).status.result, "L");
  const impact = amendImpact(board, { week: played.week, slot: 0, team: both.team });
  assert.equal(impact.replacing, other.team);
  const { entry } = amendEntry(wrong, board, { week: played.week, slot: 0, team: both.team });
  const slot = slotOf(build(entry), played.week);
  assert.equal(slot.team, both.team);
  assert.equal(slot.status.result, both.result, "not the old lock's result");
  assert.equal(entry.picks[slotKey(played.week, 0)].amended.from, other.team);
  assert.equal(entry.picks[slotKey(played.week, 0)].spread, null, "nor its line");
}

// 3. A team a later week has locked: that week loses it, and it is spent once.
{
  const ahead = lockOn(nothing(), later.week, both.team);
  const board = build(ahead);
  const option = slotOf(board, played.week).options.find((entry) => entry.team === both.team);
  assert.equal(option.spentWeek, later.week);
  assert.ok(amendable(slotOf(board, played.week), option), "a later week's team can be taken");
  const { entry, displaced } = amendEntry(ahead, board, {
    week: played.week,
    slot: 0,
    team: both.team,
  });
  assert.deepEqual(displaced, [{ week: later.week, slot: 0, team: both.team, locked: true }]);
  const after = build(entry);
  assert.equal(slotOf(after, later.week).team, null, "the later week is emptied");
  assert.equal(after.spentTeams[both.team], played.week);
  assert.deepEqual(after.conflicts, []);
}

// 4. A team an earlier week holds is never a correction.
{
  const board = build(lockOn(nothing(), played.week, both.team));
  const slot = slotOf(board, later.week);
  const option = slot.options.find((entry) => entry.team === both.team);
  assert.equal(option.spentWeek, played.week);
  assert.equal(amendable(slot, option), false);
  assert.equal(amendable(slot, { ...option, isCurrent: true }), false, "nor the slot's own team");
}

// 5. A finished pool can be put right up to the week that ended it.
{
  const loser = played.picks[0].options.find((option) => option.result === "L");
  assert.ok(loser, "the played week has a loss to lock");
  const board = build(lockOn(nothing(), played.week, loser.team));
  assert.equal(board.eliminated, true);
  assert.equal(fixableWeek(board, played.week), true);
  assert.equal(fixableWeek(board, played.week + 1), false);
  const winner = played.picks[0].options.find(
    (option) => option.result === "W" && option.team !== loser.team,
  );
  const { entry } = amendEntry(lockOn(nothing(), played.week, loser.team), board, {
    week: played.week,
    slot: 0,
    team: winner.team,
  });
  assert.equal(build(entry).eliminated, false, "the correction puts the pool back in");
}

console.log(`Amend OK: week ${played.week} corrected against week ${later.week}.`);
