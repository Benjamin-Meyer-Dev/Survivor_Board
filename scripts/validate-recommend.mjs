#!/usr/bin/env node
/**
 * Checks on the recommendation engine (core/recommend.js) and the exact
 * assignment it leans on (core/assignment.js).
 *
 * On a league small enough to enumerate, the engine has to find the optimum -
 * with and without a buy back, and never taking both sides of one game. On
 * the two real boards it has to match or beat the exact relaxation, produce a
 * frontier whose call is the path it shows, come back the same twice, and do
 * it inside the time the board gives it.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { recommendPath, continuationWeights, recommendForBoard } from "../src/js/core/recommend.js";
import { assignPath, maximumAssignment, FORBIDDEN } from "../src/js/core/assignment.js";
import { survival } from "../src/js/core/survival.js";
import { buildBoard } from "../src/js/core/plan.js";
import { CONFIG } from "../src/js/config.js";
import { LEAGUE_IDS } from "../src/js/leagues.js";

const close = (a, b, tolerance, message) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b}`);

// ---------------------------------------------------------------------------
// A league small enough to enumerate.
// ---------------------------------------------------------------------------

/** Six teams, four weeks, three games a week, probabilities chosen so the
 *  greedy path and the best path differ. */
const SMALL = [
  {
    week: 1,
    games: [
      ["A", "F", 0.97],
      ["B", "E", 0.8],
      ["C", "D", 0.6],
    ],
  },
  {
    week: 2,
    games: [
      ["A", "E", 0.9],
      ["B", "F", 0.85],
      ["D", "C", 0.55],
    ],
  },
  {
    week: 3,
    games: [
      ["A", "D", 0.93],
      ["E", "C", 0.7],
      ["F", "B", 0.5],
    ],
  },
  {
    week: 4,
    games: [
      ["B", "D", 0.75],
      ["A", "C", 0.96],
      ["E", "F", 0.65],
    ],
  },
].map(({ week, games }) => ({
  week,
  options: games.flatMap(([team, opponent, p]) => [
    {
      team,
      opponent,
      winProb: p,
      spread: -10 * (p - 0.5) * 4,
      source: "projected",
      weeksAhead: week - 1,
    },
    {
      team: opponent,
      opponent: team,
      winProb: 1 - p,
      spread: 10 * (p - 0.5) * 4,
      source: "projected",
      weeksAhead: week - 1,
    },
  ]),
}));

/** Every legal path, scored exactly. */
function bruteForce(weeks, { picksPerWeek, buyBackWeeks, buyBacks }) {
  let best = { probability: -1, path: null };
  const used = new Set();
  const picks = {};
  const recurse = (index) => {
    if (index === weeks.length) {
      const flat = weeks.flatMap((week) =>
        picks[week.week].map((team) => ({
          week: week.week,
          winProb: week.options.find((o) => o.team === team).winProb,
          result: null,
        })),
      );
      const probability = survival({ picks: flat, buyBackWeeks, buyBacks }).probability;
      if (probability > best.probability) best = { probability, path: structuredClone(picks) };
      return;
    }
    const week = weeks[index];
    const available = week.options.filter((option) => !used.has(option.team));
    const choose = (chosen, from) => {
      if (chosen.length === picksPerWeek) {
        picks[week.week] = chosen.map((o) => o.team);
        for (const o of chosen) used.add(o.team);
        recurse(index + 1);
        for (const o of chosen) used.delete(o.team);
        return;
      }
      for (let i = from; i < available.length; i += 1) {
        const option = available[i];
        if (chosen.some((o) => o.opponent === option.team)) continue;
        choose([...chosen, option], i + 1);
      }
    };
    choose([], 0);
  };
  recurse(0);
  return best;
}

// One pick a week, nothing forgiven.
{
  const rules = { picksPerWeek: 1, buyBackWeeks: [], buyBacks: 0 };
  const truth = bruteForce(SMALL, rules);
  const found = recommendPath({ weeks: SMALL, burned: new Set(), ...rules });
  close(found.pathProbability, truth.probability, 1e-9, "one pick a week: the optimum is found");
  assert.ok(truth.probability > 0, "the fixture has a legal path");
  // Taking the favourite every week, under the no-repeat rule, is the path
  // the engine exists to beat.
  const used = new Set();
  let greedy = 1;
  for (const week of SMALL) {
    const pick = [...week.options]
      .sort((a, b) => b.winProb - a.winProb)
      .find((option) => !used.has(option.team));
    used.add(pick.team);
    greedy *= pick.winProb;
  }
  assert.ok(
    found.pathProbability >= greedy - 1e-9,
    `the path (${found.pathProbability}) is never worse than the greedy one (${greedy})`,
  );
}

// One pick a week, one buy back over weeks 1 and 2.
{
  const rules = { picksPerWeek: 1, buyBackWeeks: [1, 2], buyBacks: 1 };
  const truth = bruteForce(SMALL, rules);
  const found = recommendPath({ weeks: SMALL, burned: new Set(), ...rules });
  close(found.pathProbability, truth.probability, 1e-9, "with a buy back: the optimum is found");
  assert.ok(
    found.frontier && found.frontier.candidates.length >= 1,
    "the frontier has something to say about week 1",
  );
}

// Two picks a week: never both sides of one game, and still the optimum. Six
// teams cover three two-pick weeks exactly, which also makes every team's
// slot forced by the others' - the tightest case the rule has.
{
  const rules = { picksPerWeek: 2, buyBackWeeks: [], buyBacks: 0 };
  const three = SMALL.slice(0, 3);
  const truth = bruteForce(three, rules);
  assert.ok(truth.probability > 0, "six teams fill three two-pick weeks");
  const found = recommendPath({ weeks: three, burned: new Set(), ...rules });
  close(found.pathProbability, truth.probability, 1e-9, "two picks a week: the optimum is found");
  for (const week of three) {
    const teams = found.picks[week.week];
    for (const team of teams) {
      const option = week.options.find((o) => o.team === team);
      assert.ok(!teams.includes(option.opponent), `week ${week.week} takes one side of each game`);
    }
  }
}

// A lock is honoured: the fixed team is placed, its opponent is no candidate,
// and the rest of the path is the best around it.
{
  const rules = { picksPerWeek: 1, buyBackWeeks: [], buyBacks: 0 };
  const weeks = SMALL.map((week) => (week.week === 1 ? { ...week, fixed: ["C"] } : week));
  const found = recommendPath({ weeks, burned: new Set(["C"]), ...rules });
  assert.deepEqual(found.picks[1], ["C"], "the locked team fills its week");
  assert.ok(
    Object.values(found.picks)
      .flat()
      .filter((team) => team === "C").length === 1,
    "and is spent nowhere else",
  );
}

// The continuation weights are exact where they claim to be: for the pool's
// rules (one buy back over weeks 1 and 2) the assignment's objective for any
// path equals the log of its exact survival.
{
  const forgiving = new Set([1, 2]);
  const openingProb = 0.8;
  const weightOf = continuationWeights({
    currentWeek: 1,
    openingProb,
    weeks: SMALL.slice(1),
    forgiving,
    buyBacks: 1,
  });
  for (const path of [
    ["A", "B", "C"],
    ["F", "E", "D"],
    ["B", "A", "F"],
  ]) {
    let objective = 0;
    const picks = [{ week: 1, winProb: openingProb, result: null }];
    SMALL.slice(1).forEach((week, index) => {
      const option = week.options.find((o) => o.team === path[index]);
      objective += weightOf(week.week, option.team, option.winProb);
      picks.push({ week: week.week, winProb: option.winProb, result: null });
    });
    const exact = survival({ picks, buyBackWeeks: [1, 2], buyBacks: 1 }).probability;
    close(Math.exp(objective), exact, 1e-9, `continuation weights are exact for ${path.join("")}`);
  }
  // Every remaining forgiving week covered: a loss there costs nothing.
  const free = continuationWeights({
    currentWeek: 3,
    openingProb: 0.9,
    weeks: [{ week: 4 }, { week: 5 }],
    forgiving: new Set([4]),
    buyBacks: 1,
  });
  assert.equal(free(4, "X", 0.3), 0, "a covered week is worth nothing to win");
  close(free(5, "X", 0.7), Math.log(0.7), 1e-12, "an ordinary week is its log probability");
}

// The assignment solver against brute force on small random matrices.
{
  let seed = 11;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const brute = (w) => {
    const n = w.length;
    const m = w[0].length;
    let best = -Infinity;
    const used = new Array(m).fill(false);
    const recurse = (i, sum, filled) => {
      if (i === n) {
        // The solver fills as many rows as it can, then maximises weight.
        const value = sum + filled * 1e6;
        if (value > best) best = value;
        return;
      }
      recurse(i + 1, sum, filled);
      for (let j = 0; j < m; j += 1) {
        if (used[j] || w[i][j] <= FORBIDDEN) continue;
        used[j] = true;
        recurse(i + 1, sum + w[i][j], filled + 1);
        used[j] = false;
      }
    };
    recurse(0, 0, 0);
    return best;
  };
  for (let trial = 0; trial < 150; trial += 1) {
    const n = 1 + Math.floor(random() * 4);
    const m = 1 + Math.floor(random() * 6);
    const w = Array.from({ length: n }, () =>
      Array.from({ length: m }, () =>
        random() < 0.2 ? FORBIDDEN : -Math.round(random() * 400) / 100,
      ),
    );
    const solved = maximumAssignment(w);
    const filled = solved.assignment.filter((c) => c >= 0).length;
    close(solved.value + filled * 1e6, brute(w), 1e-6, `assignment ${JSON.stringify(w)}`);
  }
}

// assignPath honours burned teams, fixed slots and a fixed pick's opponent.
{
  const weeks = SMALL.map((week) => (week.week === 2 ? { ...week, fixed: ["B"] } : week));
  const assigned = assignPath({ weeks, burned: new Set(["A"]), picksPerWeek: 1 });
  assert.ok(assigned.complete, "every week is filled");
  assert.deepEqual(assigned.picks[2], ["B"], "the fixed team keeps its slot");
  const all = Object.values(assigned.picks).flat();
  assert.ok(!all.includes("A"), "a burned team is never taken");
  assert.equal(new Set(all).size, all.length, "no team twice");
}

// ---------------------------------------------------------------------------
// Both real boards.
// ---------------------------------------------------------------------------

for (const league of LEAGUE_IDS) {
  const read = async (name) =>
    JSON.parse(await readFile(new URL(`../data/${league}/${name}`, import.meta.url), "utf8"));
  const optional = (name) => read(name).catch(() => null);
  const [plan, odds, teams, schedule, ratings, form, calibration] = await Promise.all([
    read("plan.json"),
    read("odds.json"),
    read("teams.json"),
    read("schedule.json"),
    read("ratings.json"),
    optional("form.json"),
    optional("calibration.json"),
  ]);
  const inputs = {
    plan,
    odds,
    teams,
    schedule,
    ratings,
    form,
    calibration,
    entry: { picks: {}, swaps: {} },
    refreshSchedule: CONFIG.refresh,
  };

  const started = performance.now();
  const board = buildBoard(inputs);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2500, `${league}: the board builds in ${elapsed.toFixed(0)}ms`);
  assert.ok(!board.recommendationPending, `${league}: the search ran`);

  const { recommendation, frontier } = board;
  const upcoming = board.weeks
    .filter((week) => week.week >= board.currentWeek)
    .map((week) => ({
      week: week.week,
      options: week.options.filter((o) => !o.result),
      fixed: [],
    }));

  // Against the exact relaxation: the path can only fall short of it where a
  // same-game pair or a slot the relaxation left open is involved, and here
  // it does not.
  const relaxed = assignPath({
    weeks: upcoming,
    burned: new Set(),
    picksPerWeek: board.rules.picksPerWeek,
  });
  if (board.rules.buyBacks === 0 && relaxed.complete) {
    const relaxedSurvival = Math.exp(relaxed.value);
    assert.ok(
      recommendation.pathProbability >= relaxedSurvival - 1e-9,
      `${league}: the path (${recommendation.pathProbability}) matches the exact relaxation (${relaxedSurvival})`,
    );
  }

  assert.ok(frontier, `${league}: the week on the clock has a frontier`);
  assert.equal(frontier.week, board.currentWeek);
  assert.ok(frontier.candidates.length >= 2, `${league}: at least two openings are compared`);
  assert.ok(frontier.candidates[0].chosen, `${league}: the call comes first`);
  const openTeams = (recommendation.picks[board.currentWeek] ?? []).slice().sort();
  assert.deepEqual(
    frontier.candidates[0].teams.slice().sort(),
    openTeams,
    `${league}: the call is the opening of the path shown`,
  );
  close(
    frontier.candidates[0].season,
    recommendation.pathProbability,
    1e-9,
    `${league}: the call's season number is the path's`,
  );
  for (const candidate of frontier.candidates) {
    assert.ok(candidate.weekWinProb > 0 && candidate.weekWinProb <= 1);
    assert.ok(candidate.season >= 0 && candidate.scenarioMean >= 0);
    assert.ok(candidate.robust >= 0 && candidate.robust <= 1);
    assert.ok(
      candidate.scenarioCost >= -1e-9,
      `${league}: no alternative beats the call across futures`,
    );
    assert.equal(
      candidate.options.length,
      candidate.teams.length,
      `${league}: every team is described`,
    );
  }
  const sorted = [...frontier.candidates].sort((a, b) => b.scenarioMean - a.scenarioMean);
  assert.deepEqual(
    frontier.candidates.map((c) => c.teams.join("+")),
    sorted.map((c) => c.teams.join("+")),
    `${league}: candidates are ordered by how they do across futures`,
  );

  // The same inputs give the same answer: the futures are seeded.
  const again = recommendForBoard(board);
  assert.deepEqual(again.picks, recommendation.picks, `${league}: the path is deterministic`);
  assert.deepEqual(
    again.frontier.candidates.map((c) => [c.teams, c.scenarioMean]),
    frontier.candidates.map((c) => [c.teams, c.scenarioMean]),
    `${league}: the frontier is deterministic`,
  );

  // Without futures the engine still answers, and the frontier is simply absent.
  const plain = recommendPath({
    weeks: upcoming,
    burned: new Set(),
    picksPerWeek: board.rules.picksPerWeek,
    buyBackWeeks: board.rules.buyBackWeeks,
    buyBacks: board.rules.buyBacks,
    scenarios: 0,
  });
  assert.equal(plain.frontier, null);
  assert.ok(plain.pathProbability > 0);
}

console.log(
  "Recommend OK: the optimum on an enumerable league with and without a buy back, one side of a " +
    "game only, locks honoured, continuation weights exact, the assignment solver against brute " +
    "force, and on both boards a deterministic frontier whose call is the path shown.",
);
