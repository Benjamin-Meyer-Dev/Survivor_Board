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

import {
  recommendPath,
  continuationWeights,
  recommendForBoard,
  COACH_DEPTH,
} from "../src/js/core/recommend.js";
import { assignPath, maximumAssignment, FORBIDDEN } from "../src/js/core/assignment.js";
import { survival } from "../src/js/core/survival.js";
import { COVERED_FLOOR, COVERED_MARGIN } from "../src/js/core/equity.js";
import { buildBoard } from "../src/js/core/plan.js";
import { CONFIG } from "../src/js/config.js";
import { SPORT_IDS } from "../src/js/sports.js";

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

/** Survival alone, no floor and no covered tilt: the optimum brute force finds. */
const PURE = { mode: "safest", floor: 0, coveredMargin: 0 };

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
  const found = recommendPath({ weeks: SMALL, burned: new Set(), ...rules, pool: PURE });
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
  const found = recommendPath({ weeks: SMALL, burned: new Set(), ...rules, pool: PURE });
  close(found.pathProbability, truth.probability, 1e-9, "with a buy back: the optimum is found");
  assert.ok(
    found.frontier && found.frontier.candidates.length >= 1,
    "the frontier has something to say about week 1",
  );
}

// The default call: survival alone above the floor, with the field implied
// from the lines and priced beside it.
{
  const rules = { picksPerWeek: 1, buyBackWeeks: [], buyBacks: 0 };
  const found = recommendPath({ weeks: SMALL, burned: new Set(), ...rules });
  const { frontier } = found;
  assert.equal(frontier.pool.mode, "safest");
  assert.equal(frontier.pool.source, "implied");
  assert.equal(frontier.pool.covered, false);
  const call = frontier.candidates[0];
  assert.ok(call.chosen && call.preferred, "the call is the mode's preference");
  assert.ok(call.weekWinProb >= frontier.pool.floor, "the call clears the floor");
  for (const candidate of frontier.candidates) {
    assert.ok(candidate.leverage >= 1 - 1e-9, "the field is priced for every opening");
    if (candidate.weekWinProb >= frontier.pool.floor) {
      assert.ok(
        call.scenarioMean >= candidate.scenarioMean - 1e-9,
        `nothing above the floor beats the call across the futures: ${candidate.teams}`,
      );
    }
  }
  assert.deepEqual(found.picks[1], call.teams, "the path shown opens with the call");
  // Asked to, the pool's leverage makes the call instead.
  const leveraged = recommendPath({
    weeks: SMALL,
    burned: new Set(),
    ...rules,
    pool: { mode: "equity" },
  });
  const top = leveraged.frontier.candidates[0];
  for (const candidate of leveraged.frontier.candidates) {
    assert.ok(
      top.equity >= candidate.equity - 1e-9,
      "equity mode: nothing beats the call on equity",
    );
  }
}

// A week a buy back covers: the loss is paid for, so among the openings the
// futures rate within a whisker of each other the coach spends the weakest
// team. With the buy back spent, the week is an ordinary one.
{
  const rules = { picksPerWeek: 1, buyBackWeeks: [1, 2], buyBacks: 1 };
  const found = recommendPath({ weeks: SMALL, burned: new Set(), ...rules });
  const { frontier } = found;
  assert.equal(frontier.pool.covered, true, "week 1 is covered with the buy back in hand");
  assert.equal(frontier.pool.floor, COVERED_FLOOR, "and the floor drops to the covered one");
  assert.ok(
    frontier.pool.cover > 0 && frontier.pool.cover < 1,
    "the field keeps part of its worth",
  );
  const call = frontier.candidates[0];
  const best = Math.max(...frontier.candidates.map((candidate) => candidate.scenarioMean));
  assert.ok(
    call.scenarioMean >= best * (1 - COVERED_MARGIN) - 1e-9,
    "the call is within the margin of the best mean across the futures",
  );
  for (const candidate of frontier.candidates) {
    const near = candidate.scenarioMean >= best * (1 - COVERED_MARGIN) - 1e-9;
    if (near && candidate.weekWinProb >= COVERED_FLOOR) {
      assert.ok(
        call.weekWinProb <= candidate.weekWinProb + 1e-9,
        `the call spends no stronger a team than ${candidate.teams} within the margin`,
      );
    }
  }
  assert.deepEqual(found.picks[1], call.teams, "the path shown opens with the call");
  const spent = recommendPath({ weeks: SMALL, burned: new Set(), ...rules, buyBacks: 0 });
  assert.equal(spent.frontier.pool.covered, false, "with the buy back spent, not covered");
}

// Twice what the week needs, ranked. The call comes first; behind it is what
// the whole season would take instead, which on a league this size can be
// checked against brute force. The week on the clock is deliberately left out
// of that comparison: the frontier ranks that one across the futures, which is
// a different and better question than the best path on today's numbers.
for (const picksPerWeek of [1, 2]) {
  const rules = { picksPerWeek, buyBackWeeks: [], buyBacks: 0 };
  // Six teams cover three two-pick weeks exactly, and no more than three.
  const weeks = picksPerWeek === 1 ? SMALL : SMALL.slice(0, 3);
  const found = recommendPath({ weeks, burned: new Set(), ...rules, pool: PURE });

  for (const week of weeks) {
    const list = found.ranked[week.week];
    const depth = COACH_DEPTH * picksPerWeek;
    assert.equal(
      list.length,
      depth,
      `${picksPerWeek}/wk, week ${week.week}: ${depth} calls ranked`,
    );
    assert.equal(new Set(list).size, list.length, "no team is ranked twice for one week");
    assert.deepEqual(
      list.slice(0, picksPerWeek).sort(),
      [...found.picks[week.week]].sort(),
      `week ${week.week}: the path's own picks are the top of the list`,
    );
    for (const team of list) {
      assert.ok(
        week.options.some((option) => option.team === team),
        `week ${week.week}: ${team} plays that week`,
      );
    }
  }

  for (const week of weeks.slice(1)) {
    const calls = found.ranked[week.week].slice(0, picksPerWeek);
    // The same week with the calls struck off it, which is the question a
    // fallback answers: barred here, and here only.
    const barred = weeks.map((entry) =>
      entry.week === week.week
        ? { ...entry, options: entry.options.filter((option) => !calls.includes(option.team)) }
        : entry,
    );
    const best = bruteForce(barred, rules);
    const fallbacks = found.ranked[week.week].slice(picksPerWeek);
    // Scored rather than named, so a genuine tie between two teams is not a
    // failure: taking what the coach falls back on has to cost the season
    // nothing against the best alternative there is.
    const through = bruteForce(
      barred.map((entry) =>
        entry.week === week.week
          ? { ...entry, options: entry.options.filter((option) => fallbacks.includes(option.team)) }
          : entry,
      ),
      rules,
    );
    close(
      through.probability,
      best.probability,
      1e-9,
      `${picksPerWeek}/wk, week ${week.week}: the fallback is what the season would take instead`,
    );
  }
}

// A week the teams cannot cover is ranked nothing: with six teams there is no
// eighth slot to fill, so there is no call in week 4 for a fallback to stand
// behind.
{
  const short = recommendPath({
    weeks: SMALL,
    burned: new Set(),
    picksPerWeek: 2,
    pool: PURE,
  });
  assert.deepEqual(short.picks[4] ?? [], [], "the path cannot fill a fourth two-pick week");
  assert.equal(short.ranked[4], undefined, "and the coach ranks no calls for it");
  assert.ok(short.ranked[1].length > 0, "the weeks it can fill are ranked as usual");
}

// A preview is answering a tap, and pays for nothing it does not show.
{
  const quick = recommendPath({
    weeks: SMALL,
    burned: new Set(),
    picksPerWeek: 1,
    quick: true,
  });
  assert.deepEqual(quick.ranked, {}, "a quick answer ranks nothing");
  assert.ok(Object.keys(quick.picks).length > 0, "but still comes back with a path");
}

// Two picks a week: never both sides of one game, and still the optimum. Six
// teams cover three two-pick weeks exactly, which also makes every team's
// slot forced by the others' - the tightest case the rule has.
{
  const rules = { picksPerWeek: 2, buyBackWeeks: [], buyBacks: 0 };
  const three = SMALL.slice(0, 3);
  const truth = bruteForce(three, rules);
  assert.ok(truth.probability > 0, "six teams fill three two-pick weeks");
  const found = recommendPath({ weeks: three, burned: new Set(), ...rules, pool: PURE });
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
// Every real board, including the losers pool, which reaches the optimiser as
// probabilities already turned the right way round (core/objective.js).
// ---------------------------------------------------------------------------

for (const league of SPORT_IDS) {
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
    const safest = recommendPath({
      weeks: upcoming,
      burned: new Set(),
      picksPerWeek: board.rules.picksPerWeek,
      buyBackWeeks: board.rules.buyBackWeeks,
      buyBacks: board.rules.buyBacks,
      model: board.model,
      pool: PURE,
    });
    assert.ok(
      safest.pathProbability >= relaxedSurvival - 1e-9,
      `${league}: on survival alone the path (${safest.pathProbability}) matches the exact relaxation (${relaxedSurvival})`,
    );
    assert.ok(
      recommendation.pathProbability >= relaxedSurvival * 0.9 - 1e-9,
      `${league}: the value call (${recommendation.pathProbability}) gives up no more than a tenth of the season (${relaxedSurvival})`,
    );
  }

  // Every week the path fills carries twice its calls, ranked, and the calls
  // themselves come first. On a real board that is a re-plan per week on top of
  // the search, so the build time asserted above is the check that it stays
  // affordable.
  for (const week of board.weeks.filter((entry) => entry.week >= board.currentWeek)) {
    const calls = recommendation.picks[week.week] ?? [];
    const list = recommendation.ranked[week.week];
    if (calls.length === 0) {
      assert.equal(list, undefined, `${league}: a week with no call is ranked nothing`);
      continue;
    }
    assert.equal(
      list.length,
      calls.length * COACH_DEPTH,
      `${league}: week ${week.week} is ranked twice its calls`,
    );
    assert.equal(new Set(list).size, list.length, `${league}: no team is ranked twice`);
    assert.deepEqual(
      list.slice(0, calls.length).sort(),
      [...calls].sort(),
      `${league}: week ${week.week} opens its ranking with the path's own calls`,
    );
    assert.ok(
      list.every((team) => week.optionByTeam.has(team)),
      `${league}: week ${week.week} only ranks teams it plays`,
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
  assert.ok(frontier.pool, `${league}: the coach has a field to price leverage against`);
  assert.equal(frontier.pool.source, "implied", `${league}: implied from the lines, no file kept`);
  assert.equal(frontier.pool.mode, "safest");
  const call = frontier.candidates[0];
  for (const candidate of frontier.candidates) {
    assert.ok(candidate.weekWinProb > 0 && candidate.weekWinProb <= 1);
    assert.ok(candidate.season >= 0 && candidate.scenarioMean >= 0);
    assert.ok(candidate.robust >= 0 && candidate.robust <= 1);
    assert.ok(
      candidate.leverage >= 1 - 1e-9 && candidate.equity >= 0,
      `${league}: leverage and equity are priced`,
    );
    assert.ok(
      candidate.scenarioCost >= -1e-9 && candidate.equityCost >= -1e-9,
      `${league}: costs are measured against the best`,
    );
    assert.equal(
      candidate.options.length,
      candidate.teams.length,
      `${league}: every team is described`,
    );
    // Safest: nothing above the floor beats the call across the futures,
    // unless the week is covered and the call spent a weaker team within the
    // margin.
    if (candidate.weekWinProb >= frontier.pool.floor) {
      const allowed = frontier.pool.covered ? 1 - COVERED_MARGIN : 1;
      assert.ok(
        call.scenarioMean >= candidate.scenarioMean * allowed - 1e-9,
        `${league}: the call holds its own across the futures against ${candidate.teams.join("+")}`,
      );
    }
  }
  assert.ok(
    call.weekWinProb >= frontier.pool.floor - 1e-9 ||
      frontier.candidates.every((c) => c.weekWinProb < frontier.pool.floor),
    `${league}: the call clears the floor (${frontier.pool.floor})`,
  );
  if (frontier.pool.covered) {
    assert.ok(
      call.weekWinProb >= COVERED_FLOOR - 1e-9,
      `${league}: a covered call keeps the covered floor`,
    );
  }
  const rest = frontier.candidates.slice(1);
  const sorted = [...rest].sort((a, b) => b.scenarioMean - a.scenarioMean);
  assert.deepEqual(
    rest.map((c) => c.teams.join("+")),
    sorted.map((c) => c.teams.join("+")),
    `${league}: alternatives are ordered by how they do across the futures`,
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
    "force, the call above a floor with a covered week spending the weaker team and leverage " +
    "priced beside it, on every board a deterministic frontier whose call is the path shown, and " +
    "twice each week's calls ranked behind it - a fallback being what the season would take " +
    "instead, checked against brute force.",
);
