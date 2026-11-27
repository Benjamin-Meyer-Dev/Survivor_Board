#!/usr/bin/env node
/**
 * A pool that plays on into the NFL playoffs (core/playoffs.js).
 *
 * Four layers, each checked on its own and then through the board:
 *
 *   1. The bracket, solved. On fields small enough to work out by hand, the
 *      solver's value is the value, the round-by-round chances it reports
 *      multiply back to it, a team it never takes costs nothing to spend, and
 *      a Super Bowl with both sides spent is a run that cannot finish.
 *   2. The field. The seeds the posted wild card games give away agree with
 *      the seeding the simulations use, pairing and all.
 *   3. The feed. Playoff games are found in the market's events by their
 *      dates, never past the number a round has, and kept once found.
 *   4. The board. A pool nobody extends is untouched; a pool that is extended
 *      plays every round it takes, projects the ones not yet set, never names a
 *      team twice, saves teams for January, and - once the bracket is set -
 *      calls a real game and drops the teams that have been knocked out.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { buildBoard, slotKey, lineKey, withPlayoffGames } from "../src/js/core/plan.js";
import {
  postseasonFor,
  seedsFromBracket,
  simulateFields,
  validSeeds,
} from "../src/js/core/playoffs.js";
import { resolveModel } from "../src/js/core/probability.js";
import { mergeRules } from "../src/js/core/rules.js";
import { POOL_KINDS } from "../src/js/sports.js";
import { CONFIG } from "../src/js/config.js";
import { findPlayoffGames } from "./lib/playoffs.mjs";
import { teamResolver } from "./lib/odds-api.mjs";
import { atKickoff } from "./lib/feed.mjs";

const close = (a, b, message, tolerance = 1e-9) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} against ${b}`);

// ---------------------------------------------------------------------------
// 1. The bracket, solved, on fields small enough to check by hand.
// ---------------------------------------------------------------------------

// Fourteen teams, seven a conference, every one rated the same, so a game no
// line has been posted for is a coin flip wherever it is played.
const toy = {};
for (const conference of ["AFC", "NFC"]) {
  for (let seed = 1; seed <= 7; seed += 1) toy[`${conference[0]}${seed}`] = `${conference} East`;
}
const toySeeds = {
  AFC: ["A1", "A2", "A3", "A4", "A5", "A6", "A7"],
  NFC: ["N1", "N2", "N3", "N4", "N5", "N6", "N7"],
};
assert.ok(validSeeds(toySeeds, toy));
assert.ok(!validSeeds({ ...toySeeds, AFC: toySeeds.NFC }, toy), "seeds in the wrong conference");

// The wild card and divisional rounds played: the home sides through, then
// the top two seeds, so the conference games are 1 v 2 on both sides.
const played = {
  19: ["A2|A7", "A3|A6", "A4|A5", "N2|N7", "N3|N6", "N4|N5"].map((pair) => {
    const [home, away] = pair.split("|");
    return { home, away, winner: home, pHome: 0.5 };
  }),
  20: ["A1|A4", "A2|A3", "N1|N4", "N2|N3"].map((pair) => {
    const [home, away] = pair.split("|");
    return { home, away, winner: home, pHome: 0.5 };
  }),
};
const toySpec = (rounds, games = played) => ({
  rounds: [
    { week: 19, round: "wildcard", inRun: rounds.includes(19) },
    { week: 20, round: "divisional", inRun: rounds.includes(20) },
    { week: 21, round: "conference", inRun: rounds.includes(21) },
    { week: 22, round: "superbowl", inRun: rounds.includes(22) },
  ],
  teams: toy,
  regular: [],
  games,
  seeds: toySeeds,
  rating: Object.fromEntries(Object.keys(toy).map((team) => [team, 80])),
  homeField: 0,
  currentWeek: 21,
});
const model = resolveModel(null);
const solve = (rounds, games = played, extra = {}) =>
  postseasonFor(toySpec(rounds, games), { model, picksPerWeek: 1, from: 21, ...extra });

// The conference round and the Super Bowl, every game a coin flip. Whoever is
// taken in the conference round wins it to get on, and is then one of the two
// sides of the Super Bowl - so the Super Bowl pick is the other side, and the
// run is a half times a half.
const lastTwo = solve([21, 22]);
close(lastTwo.value(new Set()), 0.25, "two coin flips");
close(lastTwo.value(new Set(["A1"])), 0.25, "one AFC side spent: take the other, then the NFC");
close(
  lastTwo.value(new Set(["A1", "A2"])),
  0,
  "both AFC sides spent: whoever is taken meets an AFC side in the Super Bowl with nothing left",
);
const rounds = lastTwo.project(new Set());
assert.deepEqual(
  rounds.map((round) => round.week),
  [21, 22],
);
close(
  rounds.reduce((product, round) => product * round.winProb, 1),
  lastTwo.value(new Set()),
  "the rounds' chances multiply to the bracket's value",
);
assert.equal(rounds[0].reach, 1, "the first round is reached by every run that gets to January");

// The Super Bowl alone, posted at 60/40: the favourite is the call, spending
// it leaves the underdog, spending both leaves nothing - and the underdog,
// never taken while the favourite is there, costs nothing to spend.
const final = {
  ...played,
  21: [
    { home: "A1", away: "A2", winner: "A1", pHome: 0.5 },
    { home: "N1", away: "N2", winner: "N1", pHome: 0.5 },
  ],
  22: [{ home: "A1", away: "N1", winner: null, pHome: 0.6 }],
};
const superBowl = postseasonFor(toySpec([22], final), { model, picksPerWeek: 1, from: 22 });
close(superBowl.value(new Set()), 0.6, "the favourite");
close(superBowl.value(new Set(["A1"])), 0.4, "the underdog, with the favourite spent");
close(superBowl.value(new Set(["A1", "N1"])), 0, "both sides spent: no pick to make");
const prices = superBowl.prices(new Set());
close(prices.get("A1"), Math.log(0.6 / 0.4), "spending the favourite costs what it gave");
assert.equal(prices.get("N1") ?? 0, 0, "a team the coach never takes costs nothing to spend");
assert.deepEqual(
  superBowl.rank(new Set()).map((choice) => choice.teams[0]),
  ["A1", "N1"],
  "the posted round ranks its picks by what they are worth",
);
// A lock in the round binds it, whatever the coach would rather.
const lockedFinal = postseasonFor(toySpec([22], final), {
  model,
  picksPerWeek: 1,
  from: 22,
  fixed: { 22: ["N1"] },
});
close(lockedFinal.value(new Set(["N1"])), 0.4, "a locked underdog is the underdog's chance");

// A game already played is no pick: a Super Bowl over with nothing locked in
// it is a pick never made, carried through rather than lost - the way a
// missed regular week is - and there is nothing left to rank.
const played22 = { ...final, 22: [{ home: "A1", away: "N1", winner: "A1", pHome: 0.6 }] };
const missed = postseasonFor(toySpec([22], played22), { model, picksPerWeek: 1, from: 22 });
close(missed.value(new Set()), 1, "a round played out unpicked is not a loss");
assert.equal(missed.rank(new Set()), null);
assert.equal(missed.project(new Set())[0].passed, true);
// ...but locked, it is the lock's: the favourite won, so the lock holds.
const lockedPlayed = postseasonFor(toySpec([22], played22), {
  model,
  picksPerWeek: 1,
  from: 22,
  fixed: { 22: ["A1"] },
});
close(lockedPlayed.value(new Set(["A1"])), 1, "a lock on the winner");

// A losers pool takes the side that loses: the underdog is the call there.
const losersFinal = postseasonFor(toySpec([22], final), {
  model,
  objective: "lose",
  picksPerWeek: 1,
  from: 22,
});
close(losersFinal.value(new Set()), 0.6, "picking the 40% side to lose");
assert.equal(losersFinal.rank(new Set())[0].teams[0], "N1");

// ---------------------------------------------------------------------------
// 2. The field: what the posted wild card games say against the seeding.
// ---------------------------------------------------------------------------

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
const divisionOf = {};
for (const [division, roster] of Object.entries(teams.conferences)) {
  for (const team of Object.keys(roster)) divisionOf[team] = division;
}

// The whole regular season played, the better side winning every game the
// feed has not settled - a finished season with real records in it.
const finished = { ...odds, results: { ...odds.results }, scores: { ...odds.scores } };
for (const [week, games] of Object.entries(schedule.weeks)) {
  for (const game of games) {
    if (finished.results[lineKey(week, game.home)]) continue;
    const homeWins = ratings.ratings[game.home] + 2 >= ratings.ratings[game.away];
    finished.results[lineKey(week, game.home)] = homeWins ? "W" : "L";
    finished.results[lineKey(week, game.away)] = homeWins ? "L" : "W";
    finished.scores[lineKey(week, game.home)] = homeWins ? 7 : -7;
    finished.scores[lineKey(week, game.away)] = homeWins ? -7 : 7;
  }
}
const regular = Object.entries(schedule.weeks).flatMap(([week, games]) =>
  games.map((game) => ({
    home: game.home,
    away: game.away,
    winner: finished.results[lineKey(week, game.home)] === "W" ? game.home : game.away,
    margin: finished.scores[lineKey(week, game.home)],
  })),
);
const fields = simulateFields({ teams: divisionOf, regular, count: 8 });
assert.ok(fields.length >= 1);
assert.ok(
  fields.every((field) => validSeeds(field.seeds, divisionOf)),
  "every simulated field is a bracket",
);
close(
  fields.reduce((total, field) => total + field.weight, 0),
  1,
  "the fields' weights",
);
const { seeds } = fields[0];
const wildcardOf = (field) =>
  ["AFC", "NFC"].flatMap((conference) => {
    const s = field[conference];
    return [
      { home: s[1], away: s[6] },
      { home: s[2], away: s[5] },
      { home: s[3], away: s[4] },
    ];
  });
const inferred = seedsFromBracket({ teams: divisionOf, regular, wildcard: wildcardOf(seeds) });
for (const conference of ["AFC", "NFC"]) {
  assert.equal(inferred[conference][0], seeds[conference][0], `${conference}: the bye`);
  assert.deepEqual(
    [...inferred[conference].slice(1, 4)].sort(),
    [...seeds[conference].slice(1, 4)].sort(),
    `${conference}: the hosts`,
  );
  // Whatever order the hosts come in, two still plays seven, three six, four five.
  for (let host = 1; host <= 3; host += 1) {
    const game = wildcardOf(seeds).find((g) => g.home === inferred[conference][host]);
    assert.equal(inferred[conference][8 - host - 1], game.away, `${conference}: pairing`);
  }
}
assert.equal(
  seedsFromBracket({ teams: divisionOf, regular, wildcard: wildcardOf(seeds).slice(1) }),
  null,
  "five games are not a wild card round",
);

// ---------------------------------------------------------------------------
// 3. The feed: playoff games found by date, kept once found.
// ---------------------------------------------------------------------------

const resolve = teamResolver(Object.keys(ratings.ratings));
const isEligible = (team) => team in divisionOf;
const feedTeam = (team) => `Somewhere ${team}`;
const at = (date) => `${date}T18:00:00Z`;
const event = (home, away, date) => ({
  home_team: feedTeam(home),
  away_team: feedTeam(away),
  commence_time: at(date),
});
const wcEvents = wildcardOf(seeds).map((game, index) =>
  event(game.home, game.away, index < 2 ? "2027-01-16" : index < 5 ? "2027-01-17" : "2027-01-18"),
);
const first = findPlayoffGames({ plan, events: wcEvents, resolve, isEligible });
assert.equal(first.found.length, 6, "the six wild card games");
assert.deepEqual(Object.keys(first.games), ["19"]);
const again = findPlayoffGames({
  plan,
  events: [
    ...wcEvents,
    // A seventh game in the round's window is not the round's.
    event("Cardinals", "Titans", "2027-01-17"),
    // Nor is a week-18 game, whatever its teams.
    event("Cardinals", "Titans", "2027-01-10"),
    // Nor a name the league does not know.
    { home_team: "AFC", away_team: "NFC", commence_time: at("2027-02-07") },
  ],
  resolve,
  isEligible,
  known: first.games,
});
assert.equal(again.found.length, 0, "a game already found, or not a playoff game, adds nothing");
assert.equal(again.games["19"].length, 6);
const final2 = findPlayoffGames({
  plan,
  events: [event(seeds.AFC[0], seeds.NFC[0], "2027-02-14")],
  resolve,
  isEligible,
  known: first.games,
});
assert.deepEqual(final2.games["22"], [{ home: seeds.AFC[0], away: seeds.NFC[0], neutral: true }]);
assert.equal(final2.games["19"].length, 6, "and what was found before is kept");

const merged = withPlayoffGames(
  { weeks: { 1: schedule.weeks["1"] } },
  { playoffs: { games: final2.games } },
  plan,
);
assert.equal(merged.weeks["19"].length, 6, "the found games are the schedule's");
assert.equal(merged.weeks["22"][0].neutral, true, "the Super Bowl is on neutral ground");
assert.equal(merged.weeks["1"], schedule.weeks["1"], "and the regular season is left as it was");

// ---------------------------------------------------------------------------
// 4. The board.
// ---------------------------------------------------------------------------

const league = { plan, teams, schedule, ratings, calibration, form };
const boardFor = (rules, picks = {}, feed = atKickoff(odds)) => {
  const entry = { picks: {}, swaps: {}, ...(rules ? { rules } : {}) };
  for (const [week, team] of Object.entries(picks)) {
    entry.picks[slotKey(Number(week), 0)] = { locked: true };
    entry.swaps[slotKey(Number(week), 0)] = team;
  }
  return buildBoard({ ...league, odds: feed, entry, refreshSchedule: CONFIG.refresh });
};

// A league made to end at a playoff round ends there. createLeague clamps the
// rules it is given with no calendar to hand, and the kind's own calendar is
// what holds them then - not the regular season its pools stop at by default.
assert.equal(mergeRules(POOL_KINDS["nfl-win"].rules, { endWeek: 22 }).endWeek, 22);
assert.equal(mergeRules(POOL_KINDS["nfl-lose"].rules, { endWeek: 20 }).endWeek, 20);
assert.equal(mergeRules(POOL_KINDS["nfl-win"].rules, null).endWeek, 18, "by default, week 18");
assert.equal(mergeRules(POOL_KINDS["cfb-win"].rules, { endWeek: 22 }).endWeek, 13);
assert.ok(
  !("weeks" in mergeRules(POOL_KINDS["nfl-win"].rules, { endWeek: 22 })),
  "and the calendar's length is no rule a pool stores",
);

// A pool nobody has extended stops at the regular season, and plans nothing
// for January.
const regularOnly = boardFor(null);
assert.equal(regularOnly.weeks.at(-1).week, 18);
assert.equal(regularOnly.postseason, null);
assert.equal(regularOnly.recommendation.projected, undefined);

// Extended to the Super Bowl, before anyone knows the bracket.
const started = performance.now();
const toFinal = boardFor({ endWeek: 22 });
const took = performance.now() - started;
assert.ok(took < 2500, `a board run into the playoffs builds in ${took.toFixed(0)}ms`);
const pending = toFinal.weeks.filter((week) => week.bracketPending);
assert.deepEqual(
  pending.map((week) => week.short),
  ["WC", "DIV", "CONF", "SB"],
);
for (const week of pending) {
  assert.equal(week.options.length, 0, `${week.name}: nothing to pick before the bracket`);
  assert.equal(week.pathRecommendation.length, 1, `${week.name}: the coach's likeliest pick`);
  assert.ok(week.pathRecommendation[0].projected, `${week.name}: marked as a projection`);
  assert.ok(week.picks[0].suggestion?.projected, `${week.name}: and it is the slot's ghost`);
}
const named = toFinal.weeks
  .filter((week) => week.week >= toFinal.currentWeek)
  .flatMap((week) => week.pathRecommendation.map((option) => option.team));
assert.equal(new Set(named).size, named.length, "the path never names a team twice");
close(
  toFinal.weeks.at(-1).seasonWinProb,
  toFinal.pathProbability,
  "the season number runs through the Super Bowl",
  1e-9,
);
close(
  toFinal.pathProbability,
  toFinal.recommendation.pathProbability,
  "and is the engine's own number",
  1e-6,
);
assert.ok(toFinal.pathProbability < regularOnly.pathProbability, "four more rounds to survive");

// January changes December: the teams the bracket values most are spent less
// by a plan that has to reach the Super Bowl than by one that stops at week 18.
const valued = Object.entries(toFinal.recommendation.postseason.prices)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 4)
  .map(([team]) => team);
const spends = (board) =>
  board.weeks
    .filter((week) => week.week >= board.currentWeek && week.week <= 18)
    .flatMap((week) => week.pathRecommendation.map((option) => option.team))
    .filter((team) => valued.includes(team)).length;
assert.ok(
  spends(toFinal) < spends(regularOnly),
  `the plan to the Super Bowl keeps ${valued.join(", ")} back ` +
    `(${spends(toFinal)} spent, against ${spends(regularOnly)} stopping at week 18)`,
);

// A pool can stop at any round, and plays the rounds it takes.
for (const endWeek of [19, 20, 21]) {
  const board = boardFor({ startWeek: 15, endWeek });
  assert.equal(board.weeks.filter((week) => week.round).length, endWeek - 18);
  assert.ok(board.pathProbability > 0 && board.pathProbability < 1);
}

// A playoff pool: no regular weeks at all, only the bracket.
const playoffsOnly = boardFor({ startWeek: 19, endWeek: 22 });
assert.equal(playoffsOnly.weeks.length, 4);
close(
  playoffsOnly.pathProbability,
  playoffsOnly.recommendation.postseason.value,
  "a playoff pool's season is the bracket",
  1e-9,
);

// A losers pool runs on into January the same way.
const losers = buildBoard({
  ...league,
  plan: { ...plan, rules: { ...plan.rules, objective: "lose" } },
  odds: atKickoff(odds),
  entry: { picks: {}, swaps: {}, rules: { endWeek: 22 } },
  refreshSchedule: CONFIG.refresh,
});
assert.ok(losers.pathProbability > 0 && losers.pathProbability < 1);
assert.equal(losers.weeks.filter((week) => week.bracketPending).length, 4);

// The bracket set: the regular season over and the wild card games posted.
const wildcard = wildcardOf(seeds);
const atWildcard = {
  ...finished,
  currentWeek: 19,
  updatedAt: `${odds.updatedAt}-wildcard`,
  playoffs: { games: { 19: wildcard } },
};
const spentEarly = seeds.AFC[1];
const inJanuary = boardFor({ startWeek: 1, endWeek: 22 }, { 18: spentEarly }, atWildcard);
const wc = inJanuary.weeks.find((week) => week.week === 19);
assert.equal(wc.bracketPending, false);
assert.equal(wc.options.length, 12, "twelve teams play the wild card round");
assert.ok(
  !wc.options.some((option) => option.team === seeds.AFC[0] || option.team === seeds.NFC[0]),
  "the top seeds have the week off",
);
assert.ok(validSeeds(inJanuary.postseason.seeds, divisionOf), "the seeds the games give away");
const call = wc.pathRecommendation[0]?.team;
assert.ok(call && wc.optionByTeam.has(call), "the call is a team playing this week");
assert.notEqual(call, spentEarly, "and never a team spent in the regular season");
assert.ok(
  wc.picks[0].options.find((option) => option.team === spentEarly).disabled,
  "which the list shows as spent",
);
assert.equal(wc.coachRanked.length, 2, "a call and a fallback");
assert.equal(
  inJanuary.weeks.filter((week) => week.bracketPending).length,
  3,
  "the rounds after it still to be set",
);

// The wild card round played - the home sides through - and the divisional
// games posted as the bracket draws them.
const s = inJanuary.postseason.seeds;
const winners = new Set(wildcard.map((game) => game.home));
const wcResults = {};
for (const game of wildcard) {
  wcResults[lineKey(19, game.home)] = "W";
  wcResults[lineKey(19, game.away)] = "L";
}
const divisional = ["AFC", "NFC"].flatMap((conference) => [
  { home: s[conference][0], away: s[conference][3] },
  { home: s[conference][1], away: s[conference][2] },
]);
const atDivisional = {
  ...atWildcard,
  currentWeek: 20,
  updatedAt: `${odds.updatedAt}-divisional`,
  results: { ...atWildcard.results, ...wcResults },
  playoffs: { games: { 19: wildcard, 20: divisional } },
};
const survived = wildcard[0].home;
const knockedOut = wildcard[0].away;
const through = boardFor({ startWeek: 1, endWeek: 22 }, { 19: survived }, atDivisional);
assert.equal(through.eliminated, false, "a wild card pick that won goes on");
const div = through.weeks.find((week) => week.week === 20);
assert.equal(div.options.length, 8, "eight teams left");
assert.ok(
  div.options.every(
    (option) => winners.has(option.team) || option.team === s.AFC[0] || option.team === s.NFC[0],
  ),
  "the wild card's losers are out of the bracket",
);
assert.ok(
  div.picks[0].options.find((option) => option.team === survived).disabled,
  "and the team that got the run through is spent",
);
assert.notEqual(div.pathRecommendation[0]?.team, survived);
const out = boardFor({ startWeek: 1, endWeek: 22 }, { 19: knockedOut }, atDivisional);
assert.equal(out.eliminated, true, "a wild card pick that lost ends the run");
assert.equal(out.eliminatedWeek, 19);

// The wild card round played with nothing locked in it: a pick never made, so
// the run is carried through it - short, as a missed regular week is - and the
// rounds after it are still planned.
const wcPlayed = {
  ...atWildcard,
  updatedAt: `${odds.updatedAt}-wildcard-played`,
  results: { ...atWildcard.results, ...wcResults },
};
const skipped = boardFor({ startWeek: 1, endWeek: 22 }, {}, wcPlayed);
assert.equal(skipped.eliminated, false);
assert.ok(skipped.pathProbability > 0, "a missed round is not a loss");
assert.equal(
  skipped.weeks.find((week) => week.week === 19).pathRecommendation.length,
  0,
  "and the coach names nothing in a round already played",
);
assert.equal(
  skipped.weeks.find((week) => week.week === 20).pathRecommendation.length,
  1,
  "but plans the next one",
);
assert.notEqual(skipped.weeks.at(-1).seasonWinProb, null, "and the season still has a number");

// The dead end the rule makes: the NFC's top seed spent in week 18, the AFC's
// taken in the conference round - which it has to win to count, and so goes
// to the Super Bowl - and the two of them meet there. Every round so far came
// through, and there is no pick left to make.
const roundResults = {};
const decide = (week, games) => {
  for (const game of games) {
    roundResults[lineKey(week, game.home)] = "W";
    roundResults[lineKey(week, game.away)] = "L";
  }
};
const conference = ["AFC", "NFC"].map((side) => ({ home: s[side][0], away: s[side][1] }));
decide(19, wildcard);
decide(20, divisional);
decide(21, conference);
const superBowlGame = [{ home: s.AFC[0], away: s.NFC[0] }];
const atSuperBowl = {
  ...atDivisional,
  currentWeek: 22,
  updatedAt: `${odds.updatedAt}-superbowl`,
  results: { ...atDivisional.results, ...roundResults, [lineKey(18, s.NFC[0])]: "W" },
  playoffs: { games: { 19: wildcard, 20: divisional, 21: conference, 22: superBowlGame } },
};
const stuck = boardFor(
  { startWeek: 1, endWeek: 22 },
  { 18: s.NFC[0], 19: s.AFC[2], 20: s.NFC[1], 21: s.AFC[0] },
  atSuperBowl,
);
assert.equal(stuck.eliminated, false, "every lock so far came through");
const last = stuck.weeks.find((week) => week.week === 22);
assert.equal(last.noTeamLeft, true, "but both sides of the Super Bowl are spent");
assert.equal(last.pathRecommendation.length, 0, "so the coach has nothing to call");
assert.equal(stuck.pathProbability, 0, "and the run cannot finish");
assert.equal(last.seasonWinProb, 0, "which the chart says too");
// One side left: the coach takes it, at its own chance.
const oneLeft = boardFor(
  { startWeek: 1, endWeek: 22 },
  { 19: s.AFC[2], 20: s.NFC[1], 21: s.AFC[0] },
  atSuperBowl,
);
assert.equal(oneLeft.weeks.find((week) => week.week === 22).pathRecommendation[0]?.team, s.NFC[0]);
assert.ok(oneLeft.pathProbability > 0);

console.log(
  `Playoffs OK: the bracket solves by hand, the field seeds, the feed is read by date, and a ` +
    `pool run to the Super Bowl plans it (${(toFinal.pathProbability * 100).toFixed(2)}% from ` +
    `week ${toFinal.currentWeek}, built in ${took.toFixed(0)}ms).`,
);
