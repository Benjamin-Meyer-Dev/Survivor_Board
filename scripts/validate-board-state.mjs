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
import { buildBoard, lineKey, slotKey, searchesSettled } from "../src/js/core/plan.js";
import { CONFIG } from "../src/js/config.js";
import { confidenceTier, TIER_LABEL } from "../src/js/core/probability.js";
import { recommendPath } from "../src/js/core/recommend.js";
import { setSearchRunner } from "../src/js/core/search.js";

const readJson = async (name) =>
  JSON.parse(await readFile(new URL(`../data/nfl/${name}`, import.meta.url), "utf8"));

const [plan, odds, teams, schedule, ratings] = await Promise.all(
  ["plan.json", "odds.json", "teams.json", "schedule.json", "ratings.json"].map(readJson),
);

const build = (entry, sourceOdds = odds, allowSearch = true, inHand = null) =>
  buildBoard({
    plan,
    odds: sourceOdds,
    teams,
    schedule,
    ratings,
    entry,
    refreshSchedule: CONFIG.refresh,
    allowSearch,
    inHand,
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

// The coach names twice what a week needs, ranked: the calls that fill the
// slots, then a fallback behind each of them. What the slots show is the top of
// that list, the team list badges every name in it with its rank, and nothing
// in it is a team the board would refuse.
for (const week of empty.weeks.filter((entry) => entry.week >= empty.currentWeek)) {
  const open = week.picks.filter((pick) => !pick.status.locked).length;
  const ranked = week.coachRanked;
  assert.equal(ranked.length, open * 2, `week ${week.week}: twice what the week needs, ranked`);
  assert.deepEqual(
    ranked.map((option) => option.rank),
    ranked.map((_option, index) => index + 1),
    `week ${week.week}: the ranks run from one`,
  );
  assert.equal(
    new Set(ranked.map((option) => option.team)).size,
    ranked.length,
    `week ${week.week}: no team is ranked twice`,
  );
  assert.deepEqual(
    ranked.slice(0, open).map((option) => option.team),
    week.recommended.map((option) => option.team),
    `week ${week.week}: the calls in the slots are the top of the list`,
  );
  assert.ok(
    ranked.slice(open).every((option) => !option.result && !option.disabled),
    `week ${week.week}: the coach never falls back on a game that cannot be taken`,
  );
  // The team list is the other place the ranking shows, and the two must agree
  // to the number: a rank on a row the card does not name would be advice from
  // a plan the board is no longer showing.
  for (const pick of week.picks) {
    const badged = pick.options.filter((option) => option.coachRank !== null);
    assert.deepEqual(
      badged.map((option) => option.coachRank).sort((a, b) => a - b),
      ranked.map((option) => option.rank),
      `week ${week.week}: every rank is badged once in the team list`,
    );
    for (const option of badged) {
      const listed = ranked.find((entry) => entry.team === option.team);
      assert.ok(listed, `week ${week.week}: ${option.team} is badged with a rank it holds`);
      assert.equal(option.coachRank, listed.rank);
      assert.equal(
        option.isCoach,
        listed.rank <= open,
        `week ${week.week}: ${option.team} is a call or a fallback, never read as both`,
      );
    }
  }
}

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
// And the ranking behind it stands: a pick of your own is not a re-plan, so
// the coach's board for the week is the one it was, rank for rank, and the
// team list still badges the call that was passed over as the first of them.
assert.deepEqual(
  picked.weeks[0].coachRanked.map((option) => `${option.rank}:${option.team}`),
  empty.weeks[0].coachRanked.map((option) => `${option.rank}:${option.team}`),
  "a pick of your own leaves the coach's ranking where it was",
);
assert.equal(
  pickedSlot.options.find((option) => option.team === coachTeam)?.coachRank,
  1,
  "the call you passed over is still badged first in the team list",
);

// The preview says what locking would do. The rest of the season is re-solved
// around the pick, so the picked team is not also spent in a later week, and
// the number matches what a lock then produces (the full search can only
// improve on the preview's exact assignment, and rarely does).
const previewedTeams = picked.weeks.flatMap((week) =>
  week.picks.map((pick) => pick.onPath?.team ?? pick.team ?? pick.suggestion?.team).filter(Boolean),
);
assert.equal(
  new Set(previewedTeams).size,
  previewedTeams.length,
  "the previewed path never spends a team twice",
);
const lockedPending = build(
  { picks: { [key]: { locked: true } }, swaps: { [key]: pending } },
  withFeedResult,
);
assert.ok(
  picked.previewPathProbability <= lockedPending.pathProbability + 1e-9,
  "a lock can only improve on the preview",
);
assert.ok(
  lockedPending.pathProbability - picked.previewPathProbability < 0.002,
  `"if locked" (${picked.previewPathProbability}) says what the lock produces (${lockedPending.pathProbability})`,
);
assert.equal(
  picked.previewPending,
  false,
  "with nowhere to hand a search, the assignment is the preview",
);

// Where there is somewhere to run a search off the main thread - the browser's
// worker - the preview is the lock rehearsed: the full search, run around the
// pick as if it were locked and kept under the key the locked board will have.
// "If locked" is then the number the lock produces, to the digit, and the lock
// is answered from the rehearsal with no search owed. The quick assignment
// stands in until the rehearsal lands.
const rehearsedTeam = notTheCoachs[2].team;
const weighing = { picks: {}, swaps: { [key]: rehearsedTeam } };
setSearchRunner((request) => Promise.resolve(recommendPath(request)));
let rehearsing = build(weighing, withFeedResult);
assert.equal(rehearsing.previewPending, true, "the rehearsal is out and the assignment stands in");
assert.equal(typeof rehearsing.previewPathProbability, "number", "the stand-in has a number");
await searchesSettled({ rehearsals: true });
rehearsing = build(weighing, withFeedResult);
assert.equal(rehearsing.previewPending, false, "the rehearsal has landed");
setSearchRunner(null);
const rehearsedLock = build(
  { picks: { [key]: { locked: true } }, swaps: { [key]: rehearsedTeam } },
  withFeedResult,
  false,
);
assert.equal(rehearsedLock.recommendationPending, false, "the lock is answered from the rehearsal");
assert.equal(
  rehearsing.previewPathProbability,
  rehearsedLock.pathProbability,
  '"if locked" is the number the lock then shows',
);

// Two picks pending in two weeks, and the lock button on one of them. The lock
// locks the slot in hand and nothing else, so "if locked" has to price that
// lock alone: the other pick stays unlocked, and the coach plans past it. A
// rehearsal that held both priced a board no lock could produce - 0.8% against
// the 1.0% the lock then showed - which is the regression this holds.
const secondWeek = empty.weeks[1];
const secondKey = slotKey(secondWeek.week, 0);
const secondTeam = secondWeek.picks[0].options.find(
  (option) =>
    !option.disabled &&
    !option.result &&
    option.team !== rehearsedTeam &&
    option.team !== secondWeek.picks[0].suggestion?.team,
).team;
const twoPending = { picks: {}, swaps: { [key]: rehearsedTeam, [secondKey]: secondTeam } };
// The first slot in hand is the lock rehearsed above, and the second pick
// pending is no part of it: the same search, so the plan its lock made
// answers without another.
const inHand = build(twoPending, withFeedResult, true, { week: first.week, slot: first.slot });
assert.equal(inHand.previewPending, false, "the lock in hand was rehearsed before the second pick");
assert.equal(
  inHand.weeks[1].picks[0].team,
  secondTeam,
  "the other pick stays in its slot while the first is weighed",
);
assert.equal(inHand.weeks[1].picks[0].onPath.kind, "picked");
const lockedInHand = build(
  { picks: { [key]: { locked: true } }, swaps: twoPending.swaps },
  withFeedResult,
  false,
);
assert.equal(
  lockedInHand.recommendationPending,
  false,
  "locking the slot in hand is answered from its rehearsal",
);
assert.equal(
  inHand.previewPathProbability,
  lockedInHand.pathProbability,
  '"if locked" is the number locking the slot in hand then shows, another pick pending or not',
);
// The other slot in hand is a lock of its own, rehearsed as one: held alone,
// with the first pick left to the coach, and priced as its lock then is.
const secondInHand = { week: secondWeek.week, slot: 0 };
setSearchRunner((request) => Promise.resolve(recommendPath(request)));
let secondHeld = build(twoPending, withFeedResult, true, secondInHand);
assert.equal(secondHeld.previewPending, true, "the other lock is rehearsed on its own");
await searchesSettled({ rehearsals: true });
secondHeld = build(twoPending, withFeedResult, true, secondInHand);
assert.equal(secondHeld.previewPending, false, "and its rehearsal has landed");
setSearchRunner(null);
const lockedSecond = build(
  { picks: { [secondKey]: { locked: true } }, swaps: twoPending.swaps },
  withFeedResult,
  false,
);
assert.equal(lockedSecond.recommendationPending, false, "the second lock is answered the same way");
assert.equal(
  secondHeld.previewPathProbability,
  lockedSecond.pathProbability,
  '"if locked" follows the slot in hand: the second lock priced as its lock then shows',
);
// With no slot in hand - a week whose slot holds nothing to lock - every pick
// pending is held, as before: there is no lock button for the number to
// disagree with, and the ghosts are a path that could actually be locked.
const noneInHand = build(twoPending, withFeedResult, true, { week: empty.weeks[2].week, slot: 0 });
assert.deepEqual(
  new Set(
    noneInHand.weeks.flatMap((week) => week.picks.map((pick) => pick.onPath?.team).filter(Boolean)),
  ).size,
  noneInHand.weeks.flatMap((week) => week.picks.filter((pick) => pick.onPath)).length,
  "with no lock in hand the path on screen spends no team twice",
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
// One pick a week, and it is committed: there is no call left to make, so the
// coach ranks nothing live for the week - a fallback behind a decision already
// taken is not advice - and the list keeps the board the decision was taken on
// instead. This lock saved the call alone (an entry from before the ranking was
// kept with a lock), so the call is the one rank the week can vouch for.
assert.deepEqual(
  locked.weeks[0].coachRanked.map((option) => `${option.rank}:${option.team}`),
  [`1:${coachTeam}`],
  "a fully locked week keeps the coach's call as its first choice",
);
assert.equal(
  locked.weeks[0].picks[0].options.find((option) => option.team === coachTeam)?.coachRank,
  1,
  "and the team list badges it",
);
assert.ok(
  locked.weeks[0].picks[0].options
    .filter((option) => option.team !== coachTeam)
    .every((option) => option.coachRank === null),
  "and nothing else in it wears a rank",
);
// A lock made from the board carries the week's ranking as it stood (app.js),
// and the list keeps it rank for rank: the badges a pick was weighed against
// do not vanish when it is locked, and the lock itself keeps whatever rank the
// coach gave it - none, if the coach never ranked it.
const ranking = empty.weeks[0].coachRanked.map((option) => option.team);
const kept = build(
  {
    picks: { [key]: { locked: true, coachTeam, coachRanked: ranking, at: 1 } },
    swaps: { [key]: other },
  },
  withFeedResult,
);
assert.deepEqual(
  kept.weeks[0].coachRanked.map((option) => `${option.rank}:${option.team}`),
  empty.weeks[0].coachRanked.map((option) => `${option.rank}:${option.team}`),
  "a locked week keeps the ranking it was locked on",
);
assert.equal(
  kept.weeks[0].picks[0].options.find((option) => option.team === ranking[1])?.coachRank,
  2,
  "the coach's second choice is still badged second in the team list",
);
assert.equal(
  kept.weeks[0].picks[0].options.find((option) => option.team === other)?.coachRank,
  ranking.indexOf(other) + 1 || null,
  "the lock wears the rank the coach gave it, or none",
);
assert.ok(
  locked.weeks
    .filter((week) => week.week > first.week)
    .every((week) => week.coachRanked.length === week.picks.length * 2),
  "the weeks still open keep their full ranking",
);
assert.ok(
  locked.weeks.every((week) => week.coachRanked.every((option) => option.team !== other)),
  "and none of them falls back on the team the lock spent",
);

// The spread saved with a lock lets the board say which way the line has moved
// since, signed so a positive number is the pick's way in either pool; a lock
// that saved none says nothing. The kickoff the feed times a game with rides
// along on the option and on the pick.
assert.equal(lockedSlot.sinceLock, null, "a lock without a saved spread has no movement");
const sinceLockOf = (spread) =>
  build({ picks: { [key]: { locked: true, spread } }, swaps: { [key]: other } }, withFeedResult)
    .weeks[0].picks[0].sinceLock;
assert.equal(
  sinceLockOf(lockedSlot.spread + 1),
  1,
  "a line fallen since the lock is the pick's way",
);
assert.equal(
  sinceLockOf(lockedSlot.spread - 1),
  -1,
  "a line risen since the lock is against the pick",
);
assert.equal(sinceLockOf(lockedSlot.spread), 0, "a line that has not moved is flat");
const kickoffAt = "2026-09-13T20:25:00Z";
const withKickoff = structuredClone(odds);
withKickoff.updatedAt = odds.updatedAt + "-kickoff-check";
for (const [lineId, line] of Object.entries(withKickoff.lines)) {
  if (lineId.startsWith(first.week + "|")) line.kickoff = kickoffAt;
}
const timed = build({ picks: {}, swaps: { [key]: pending } }, withKickoff);
assert.equal(timed.weeks[0].picks[0].kickoff, kickoffAt, "a pick carries its game's kickoff");
assert.ok(
  timed.weeks[0].options.some((option) => option.kickoff === kickoffAt),
  "the week's options carry the kickoff the feed timed them with",
);
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
// stays teams that can actually be taken. The feed may already carry finals
// for the week - it does once the season is under way - so the settled row is
// checked against the games still to come rather than for last place.
const rowsWhenFree = settled.weeks[0].picks[0].options;
const firstPlayed = rowsWhenFree.findIndex((option) => option.result);
assert.ok(
  firstPlayed >= 0 && rowsWhenFree.slice(firstPlayed).every((option) => option.result),
  "a played game nobody holds sinks below every game still to be played",
);
assert.ok(
  rowsWhenFree.slice(firstPlayed).some((option) => option.team === settledTeam),
  "and the settled fixture is among the played games at the bottom",
);
assert.equal(
  rowsWhenFree.filter((option) => option.result).length,
  empty.weeks[0].picks[0].options.filter((option) => option.result).length + 1,
  "only the settled fixture is newly marked settled",
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
assert.ok(
  out.weeks.filter((week) => week.week !== fatal).every((week) => week.coachRanked.length === 0),
  "and nothing ranked either: in review the coach has stood down",
);
assert.deepEqual(
  out.weeks[fatal - 1].coachRanked.map((option) => option.team),
  out.weeks[fatal - 1].recommended.map((option) => option.team),
  "but the week the run ended on keeps the call it was decided against, as history",
);
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
assert.equal(heldByLock.reason, "Other Slot");
assert.equal(heldByLock.siblingLocked, true, "and the row knows the hold is a lock");
const heldByPick = buildCollege({ picks: {}, swaps: { [lockKey]: lockedSide } }, cfbOdds)
  .weeks.find((week) => week.week === openWeek.week)
  .picks[1].options.find((option) => option.team === lockedSide);
assert.equal(heldByPick.disabled, true, "a team picked in the other slot cannot be taken here");
assert.equal(heldByPick.reason, "Other Slot");
assert.equal(heldByPick.siblingLocked, false, "but an unlocked pick is not a lock");

// The ghost in the other slot is solved around the pick, so it never names
// the team just picked, whatever the coach had called for that slot before.
const weighingSide = buildCollege(
  { picks: {}, swaps: { [lockKey]: lockedSide } },
  cfbOdds,
).weeks.find((week) => week.week === openWeek.week);
assert.notEqual(
  weighingSide.picks[1].suggestion?.team,
  lockedSide,
  "the other slot's ghost never names the team just picked",
);
assert.ok(weighingSide.picks[1].suggestion, "and the other slot still gets a suggestion");

// ---------------------------------------------------------------------------
// A league that picks losers: the same board, wanting the opposite result.
//
// The rule comes from the league (see core/rules.js), the season's files are
// the same ones the winners board is built from, and nothing below
// src/js/core/objective.js knows the difference. So what is checked here is
// that the turn happens exactly once - the probabilities are mirrored, the
// list is ordered the other way, and a recorded final reads as what it did to
// the entry rather than as what the team did.
// ---------------------------------------------------------------------------

/** One pick a week, no forgiveness, and the pick has to lose. */
const LOSERS_RULES = { objective: "lose", picksPerWeek: 1, buyBacks: 0, buyBackWeeks: [] };

const buildLosers = (entry, sourceOdds = odds) =>
  buildBoard({
    plan,
    // The same season files: same fixtures, same lines, same finals.
    odds: sourceOdds,
    teams,
    schedule,
    ratings,
    entry: { ...entry, rules: LOSERS_RULES },
    refreshSchedule: CONFIG.refresh,
  });

const losers = buildLosers(nothing());
assert.equal(losers.rules.objective, "lose", "the objective reaches the board");
assert.equal(losers.rules.picksPerWeek, 1, "one pick a week");
assert.equal(losers.rules.buyBacks, 0, "and no forgiveness");
assert.equal(losers.buyBack, null, "a pool with no buy back shows no buy back cell");

const losersWeek = losers.weeks.find((week) => week.week === losers.currentWeek);
const winnersWeek = empty.weeks.find((week) => week.week === empty.currentWeek);
const winnersProb = new Map(winnersWeek.options.map((option) => [option.team, option.winProb]));

// Every option is the other side of the same number, and the spread it is
// quoted at is untouched: the market's statement about the game does not
// change because of which pool is reading it.
const winnersSpread = new Map(winnersWeek.options.map((option) => [option.team, option.spread]));
for (const option of losersWeek.options) {
  assert.ok(
    Math.abs(option.winProb - (1 - winnersProb.get(option.team))) < 1e-12,
    `${option.team}: a losers option is one minus the winners option`,
  );
  assert.equal(option.spread, winnersSpread.get(option.team), `${option.team}: same spread`);
}

// Best pick first in both, which is opposite ends of the same list.
assert.ok(
  losersWeek.options[0].spread > 0 && winnersWeek.options[0].spread < 0,
  "the list opens on the biggest underdog here and the biggest favourite there",
);
for (let index = 1; index < losersWeek.options.length; index += 1) {
  assert.ok(
    losersWeek.options[index - 1].spread >= losersWeek.options[index].spread,
    "a losers list runs from the biggest underdog down",
  );
}

// The coach takes the pool at its word: it never calls a favourite here, and
// the season it plans is a season of underdogs.
const losersCall = losersWeek.picks[0].suggestion;
assert.ok(losersCall, "the coach suggests a team for the open slot");
assert.ok(losersCall.spread > 0, `the coach's call (${losersCall.team}) is an underdog`);
for (const week of losers.weeks) {
  for (const call of week.pathRecommendation) {
    assert.ok(call.spread > 0, `week ${week.week}: ${call.team} is an underdog on the path`);
  }
}

// A recorded final, read by both pools. The feed says whether the team won its
// game; the entry that needed it to lose survives on exactly the other answer,
// and the elimination follows the entry rather than the game.
const target = losersWeek.options[0];
const settledOdds = (result) => ({
  ...odds,
  updatedAt: `${odds.updatedAt}-losers-${result}`,
  results: { ...odds.results, [lineKey(losersWeek.week, target.team)]: result },
});
const lockOn = {
  picks: { [slotKey(losersWeek.week, 0)]: { locked: true } },
  swaps: { [slotKey(losersWeek.week, 0)]: target.team },
};

const teamLost = buildLosers(lockOn, settledOdds("L"));
const lostPick = teamLost.weeks.find((week) => week.week === losersWeek.week).picks[0];
assert.equal(lostPick.status.result, "W", "the team losing is this pool's win");
assert.equal(lostPick.status.resultSource, "final", "and it came from the feed");
assert.equal(teamLost.eliminated, false, "so the run continues");
assert.equal(teamLost.record.won, 1, "and it counts as a win on the record");
assert.equal(teamLost.record.lost, 0);

const teamWon = buildLosers(lockOn, settledOdds("W"));
const wonPick = teamWon.weeks.find((week) => week.week === losersWeek.week).picks[0];
assert.equal(wonPick.status.result, "L", "the team winning is this pool's loss");
assert.equal(teamWon.eliminated, true, "with no buy back, that ends the run");
assert.equal(teamWon.eliminatedWeek, losersWeek.week);

// The same two finals on the winners board say the opposite, which is the
// whole of the difference between the pools.
const winnersOnLoss = build(lockOn, settledOdds("L"));
assert.equal(
  winnersOnLoss.weeks.find((week) => week.week === losersWeek.week).picks[0].status.result,
  "L",
  "the same final is a loss for a pool that needed the team to win",
);

console.log(
  "Board state OK: slots are user-picked, coach plans stay advisory, locks own burns and results, " +
    "a played game leaves its week's menu and any unlocked pick on it, a week short of games " +
    "holds one pick, the other slot's lock shows in the list, a pending pick previews the season its lock would give, " +
    "the coach ranks twice what a week needs and the team list agrees to the number, a lock keeps the ranks it was made on, " +
    "a rehearsed lock says its number ahead of time, " +
    "a fatal loss puts the board in review, and the losers pool mirrors every number and every final.",
);
