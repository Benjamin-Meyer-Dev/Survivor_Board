#!/usr/bin/env node
/**
 * Regression checks for the boundary between coach advice and user picks.
 *
 * The coach suggests; it never picks. A slot holds a team only when a user put
 * one there, a team is spent only when a user locked it, and the coach plans
 * the rest of the season around the locks and nothing else.
 *
 * A played game is the one thing on the board the feed settles on its own, and
 * only for the week it was played in: it leaves that week's menu, the coach's
 * pool, and any slot that had picked it without locking it, and it still takes
 * a lock to spend the team or mark the entry.
 *
 * What is left of a week is what the coach has to work with, so a week can hold
 * fewer picks than the pool asks for: one fixture left is one call, and both
 * sides of a game are never taken together.
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
assert.equal(TIER_LABEL.close, "Close call");
assert.equal(confidenceTier(0.5, plan.tiers), "close");
assert.equal(confidenceTier(0.499, plan.tiers), "danger");
assert.equal(TIER_LABEL.danger, "Upset alert");

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
// Two teams the coach did NOT suggest, so advice and choice can be told apart
// below. The authored plan is excluded as well: it seeds the optimiser, so its
// team is not reliably a team the coach passed over.
const notTheCoachs = first.options.filter(
  (option) =>
    !option.disabled &&
    !option.result &&
    option.team !== coachTeam &&
    option.team !== plan.weeks[0].picks[0].team,
);
// `other` is given a final below, so it is the team the lock and the
// played-game rules are tested on. `pending` keeps its game ahead of it, which
// is what an ordinary unlocked pick looks like.
const other = notTheCoachs[0].team;
const pending = notTheCoachs[1].team;

// A final for the team that gets picked and locked below, so the feed has
// something to hand out. Only that one: a settled game leaves the coach's pool
// (see the settled-option checks further down), and settling the coach's own
// call here would be testing that rule rather than this one.
const withFeedResult = structuredClone(odds);
withFeedResult.updatedAt = `${odds.updatedAt}-state-check`;
withFeedResult.results[lineKey(first.week, other)] = "W";

// A feed result cannot turn a suggestion into a pick.
const advised = build(nothing(), withFeedResult);
assert.equal(advised.weeks[0].picks[0].team, null, "the feed cannot pick a team");
assert.equal(advised.weeks[0].picks[0].status.result, null, "advice cannot receive a result");

// Picking a team is not locking it: nothing is spent, no result lands, and the
// coach's plan does not move.
const picked = build({ picks: {}, swaps: { [key]: pending } }, withFeedResult);
const pickedSlot = picked.weeks[0].picks[0];
assert.equal(pickedSlot.team, pending, "the slot holds the team the user picked");
assert.equal(pickedSlot.status.picked, true);
assert.equal(pickedSlot.status.locked, false);
assert.equal(pickedSlot.onPath.kind, "picked");
assert.equal(picked.spentCount, 0, "an unlocked pick spends nothing");
assert.equal(picked.pickedTeams[pending], first.week, "an unlocked pick is marked as picked");
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
  { picks: { [key]: { locked: true, coachTeam } }, swaps: { [key]: other } },
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
  locked.weeks[0].pathRecommendation.some((option) => option.team === other),
  "the optimized path honours the lock",
);
assert.ok(
  locked.weeks[0].recommended.some((option) => option.team === coachTeam),
  "the displayed coach call stays on the pre-lock suggestion",
);
assert.ok(
  locked.weeks[0].recommended.every((option) => option.team !== other),
  "the locked team is not relabelled as the coach's suggestion",
);
assert.ok(
  locked.weeks.slice(1).every((week) => week.recommended.every((option) => option.team !== other)),
  "the coach builds the future path around the lock",
);

// A pick nobody locked is a bet on a game still to come. Once that game has
// been played there is nothing left to commit to, so the slot is open again and
// the coach's suggestion stands in - the alternative is a slot holding a team
// the board will not let anyone lock, priced off a line that is history.
const abandoned = build({ picks: {}, swaps: { [key]: other } }, withFeedResult);
const abandonedSlot = abandoned.weeks[0].picks[0];
assert.equal(abandonedSlot.team, null, "an unlocked pick whose game has been played is no pick");
assert.equal(abandonedSlot.status.picked, false);
assert.equal(abandonedSlot.status.result, null, "and it takes no result: nothing was committed");
assert.equal(
  abandonedSlot.suggestion?.team,
  advised.weeks[0].picks[0].suggestion.team,
  "the slot falls back to the coach, exactly as if it had never been picked",
);
assert.equal(abandonedSlot.onPath.kind, "coach");
assert.equal(abandoned.pickedTeams[other], undefined, "and it no longer counts as picked");
assert.equal(abandoned.spentCount, 0, "a pick nobody locked still spends nothing");
assert.equal(abandoned.previewPathProbability, null, "there is nothing left to preview");
assert.equal(
  abandoned.pathProbability,
  advised.pathProbability,
  "dropping it leaves season survival where the coach had it",
);

// A played game is off the menu for its own week, whoever picked it and
// whether or not anyone did. That is a fact about the fixture rather than
// about an entry, so unlike a pick's result it needs no lock behind it.
const settledWeek = first.week;
const settledTeam = empty.weeks[0].options.find((option) => option.team !== coachTeam).team;
// A later week this team plays again, to show the block is per week.
const laterWeek = empty.weeks
  .slice(1)
  .find((week) => week.options.some((option) => option.team === settledTeam));
assert.ok(laterWeek, "the fixture needs a team that plays more than once");

const withSettled = structuredClone(odds);
withSettled.updatedAt = `${odds.updatedAt}-settled-check`;
withSettled.results[lineKey(settledWeek, settledTeam)] = "L";

const settled = build(nothing(), withSettled);
const settledRow = settled.weeks[0].picks[0].options.find((option) => option.team === settledTeam);
assert.equal(settledRow.result, "L", "a played game carries its result into the list");
assert.equal(settledRow.disabled, true, "a played game cannot be picked");
assert.equal(settledRow.reason, "Lost", "the row says how it went in place of its line");
assert.equal(settledRow.isCoach, false, "the coach never advises a game already played");
assert.ok(
  settled.weeks[0].recommended.every((option) => option.team !== settledTeam),
  "a played game is no candidate for its week",
);
assert.equal(
  settled.spentCount,
  0,
  "a played game nobody locked spends nothing: only a lock burns a team",
);
assert.equal(
  settled.weeks[0].picks[0].status.result,
  null,
  "a played game does not put a result on a slot nobody picked",
);

const laterRow = settled.weeks
  .find((week) => week.week === laterWeek.week)
  .picks[0].options.find((option) => option.team === settledTeam);
assert.equal(laterRow.result, null, "the block is that week's game, not the team");
assert.equal(laterRow.disabled, false, "a played game leaves the team's other weeks alone");

// A row nobody holds sinks once its game is played, so the top of the list
// stays teams that can actually be taken.
const rowsWhenFree = settled.weeks[0].picks[0].options;
assert.equal(
  rowsWhenFree.at(-1).team,
  settledTeam,
  "a played game nobody holds sinks to the bottom of the list",
);
assert.equal(
  rowsWhenFree.filter((option) => option.result).length,
  1,
  "only the settled fixture is marked settled",
);

// A locked slot's own team is the exception: it keeps the place the spread
// order gave it even once its game is final, so the row does not move out from
// under the thumb that locked it. Only a locked slot can be in this position -
// an unlocked pick on a played game is no longer in the slot at all.
const pickedKey = slotKey(settledWeek, 0);
const heldEntry = { picks: { [pickedKey]: { locked: true } }, swaps: { [pickedKey]: settledTeam } };
const indexOf = (board) =>
  board.weeks[0].picks[0].options.findIndex((option) => option.team === settledTeam);
assert.equal(
  indexOf(build(heldEntry, withSettled)),
  indexOf(build(heldEntry, odds)),
  "the slot's own team holds its place in the list when its game goes final",
);
const heldRow = build(heldEntry, withSettled).weeks[0].picks[0].options.find(
  (option) => option.team === settledTeam,
);
assert.equal(heldRow.isCurrent, true);
assert.equal(heldRow.result, "L", "the slot's own row still shows how the game went");
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

// A loss in a forgiving week costs the buy back, not the run.
const forgiving = plan.rules.buyBackWeeks[0];
const forgivingSlot = empty.weeks[forgiving - 1].picks[0];
const forgivingTeam = forgivingSlot.options.find((option) => !option.disabled).team;
const softLoss = structuredClone(odds);
softLoss.updatedAt = `${odds.updatedAt}-soft-loss`;
softLoss.results[lineKey(forgiving, forgivingTeam)] = "L";
const bought = build(
  {
    picks: { [slotKey(forgiving, 0)]: { locked: true } },
    swaps: { [slotKey(forgiving, 0)]: forgivingTeam },
  },
  softLoss,
);
assert.equal(bought.eliminated, false, "a buy back covers a loss in a forgiving week");
assert.equal(bought.buyBack.used, 1);
assert.equal(bought.eliminatedWeek, null);
assert.equal(bought.elimination, null);

// A loss nothing covers ends the run, and the board goes into review: the week
// is named, the coach stands down without a search, and later weeks are open
// to nothing.
const fatal = plan.weeks.find((week) => !plan.rules.buyBackWeeks.includes(week.week)).week;
const fatalSlot = empty.weeks[fatal - 1].picks[0];
const fatalTeam = fatalSlot.options.find((option) => !option.disabled).team;
const hardLoss = structuredClone(odds);
hardLoss.updatedAt = `${odds.updatedAt}-hard-loss`;
hardLoss.results[lineKey(fatal, fatalTeam)] = "L";
const out = build(
  { picks: { [slotKey(fatal, 0)]: { locked: true } }, swaps: { [slotKey(fatal, 0)]: fatalTeam } },
  hardLoss,
);
assert.equal(out.eliminated, true, "an uncovered loss eliminates");
assert.equal(out.eliminatedWeek, fatal, "the fatal week is named");
assert.deepEqual(
  out.elimination.losses.map((loss) => loss.team),
  [fatalTeam],
  "the fatal loss is named",
);
assert.equal(out.pathProbability, 0);
assert.equal(out.recommendationPending, false, "review waits on no search");
assert.deepEqual(out.recommendation.picks, {}, "the coach stands down in review");
assert.equal(out.weeks[fatal].picks[0].suggestion, null, "no suggestion for a week never played");
assert.equal(out.weeks[fatal - 1].picks[0].status.result, "L");

// A week can run out of games before it runs out of slots. Two picks a week is
// the college pool's rule, so that is the board these checks need: late on a
// Saturday one fixture is left and both slots are open. The coach has one call
// to make rather than two, and the week's numbers still stand - one pick is all
// the week can hold, not a plan that came back short.
const readCollege = async (name) =>
  JSON.parse(await readFile(new URL(`../data/cfb/${name}`, import.meta.url), "utf8"));

const [cfbPlan, cfbOdds, cfbTeams, cfbSchedule, cfbRatings] = await Promise.all(
  ["plan.json", "odds.json", "teams.json", "schedule.json", "ratings.json"].map(readCollege),
);

assert.equal(cfbPlan.rules.picksPerWeek, 2, "the college pool takes two picks a week");

const buildCollege = (entry, sourceOdds) =>
  buildBoard({
    plan: cfbPlan,
    odds: sourceOdds,
    teams: cfbTeams,
    schedule: cfbSchedule,
    ratings: cfbRatings,
    entry,
    refreshSchedule: CONFIG.refresh,
  });

const college = buildCollege(nothing(), cfbOdds);
const openWeek = college.weeks.find((week) => week.week === college.currentWeek);
assert.equal(
  openWeek.pathRecommendation.length,
  2,
  "an open two-pick week has two calls to compare against",
);

/** The week with every game played but the fixture the given teams are in. */
const allButOne = (keep, stamp) => {
  const results = { ...cfbOdds.results };
  for (const option of openWeek.options) {
    if (!keep.includes(option.team)) results[lineKey(openWeek.week, option.team)] = "W";
  }
  return { ...cfbOdds, updatedAt: `${cfbOdds.updatedAt}-${stamp}`, results };
};

// One fixture left, and both of its teams are eligible for this pool. Two
// options, but they play each other: one of them loses, so a pair of them is a
// certain loss and the coach takes the better side alone.
const derby = openWeek.options.find((option) =>
  openWeek.options.some((other) => other.team === option.opponent),
);
assert.ok(derby, "the fixture needs a game both of whose teams are eligible");

const oneGame = buildCollege(nothing(), allButOne([derby.team, derby.opponent], "one-game-left"));
const oneGameWeek = oneGame.weeks.find((week) => week.week === openWeek.week);
const sides = [derby.team, derby.opponent];
assert.equal(
  oneGameWeek.pathRecommendation.length,
  1,
  "one game left is one call, not two: the coach never takes both sides",
);
assert.ok(sides.includes(oneGameWeek.pathRecommendation[0].team));
assert.equal(
  oneGameWeek.picks[0].suggestion.team,
  oneGameWeek.pathRecommendation[0].team,
  "the one call fills the first open slot",
);
assert.equal(oneGameWeek.picks[1].suggestion, null, "and the other slot is left blank");
assert.equal(
  oneGameWeek.picks[0].suggestion.winProb,
  Math.max(...sides.map((team) => openWeek.options.find((o) => o.team === team).winProb)),
  "the side it takes is the favourite",
);
assert.ok(
  oneGame.recommendation.shortfalls.includes(openWeek.week),
  "the week reports itself short, so its numbers are not read as unfinished",
);
assert.ok(
  oneGameWeek.seasonWinProb > 0,
  "a week that cannot be filled keeps its cumulative survival",
);
assert.equal(
  oneGame.weeks.at(-1).seasonWinProb,
  oneGame.pathProbability,
  "and so does every week after it",
);
assert.ok(
  oneGameWeek.picks[0].options.every((option) => !option.isCoach || !option.result),
  "no played game wears the coach badge",
);

// The same rule with one slot already locked: the only team left is the locked
// team's own opponent, which cannot come through the game the lock has to win.
const lockedSide = sides[0];
const lockKey = slotKey(openWeek.week, 0);
const lockedDerby = buildCollege(
  { picks: { [lockKey]: { locked: true } }, swaps: { [lockKey]: lockedSide } },
  allButOne(sides, "locked-derby"),
);
const lockedDerbyWeek = lockedDerby.weeks.find((week) => week.week === openWeek.week);
assert.equal(lockedDerbyWeek.picks[0].team, lockedSide, "the lock holds its team");
assert.equal(
  lockedDerbyWeek.picks[1].suggestion,
  null,
  "the coach does not fill the other slot with the locked team's opponent",
);

// The other slot's list says how firmly its sibling holds a team: a locked
// team wears the padlock there, a merely picked one does not.
const heldByLock = lockedDerbyWeek.picks[1].options.find((option) => option.team === lockedSide);
assert.equal(heldByLock.disabled, true, "a team locked in the other slot cannot be taken here");
assert.equal(heldByLock.reason, "Other Slot This Week");
assert.equal(heldByLock.siblingLocked, true, "and the row knows the hold is a lock");
const heldByPick = buildCollege({ picks: {}, swaps: { [lockKey]: lockedSide } }, cfbOdds)
  .weeks.find((week) => week.week === openWeek.week)
  .picks[1].options.find((option) => option.team === lockedSide);
assert.equal(heldByPick.disabled, true, "a team picked in the other slot cannot be taken here");
assert.equal(heldByPick.reason, "Other Slot This Week");
assert.equal(heldByPick.siblingLocked, false, "but an unlocked pick is not a lock");

console.log(
  "Board state OK: slots are user-picked, coach plans stay advisory, locks own burns and results, " +
    "a played game leaves its week's menu and any unlocked pick on it, a week short of games " +
    "holds one pick, the other slot's lock shows in the list, a fatal loss puts the board in review.",
);
