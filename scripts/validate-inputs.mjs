#!/usr/bin/env node
/**
 * Checks on the model's inputs: the futures the coach plays
 * (core/scenarios.js), player availability (core/availability.js), pool
 * equity (core/equity.js), and how each reaches the board (core/plan.js).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { seededRandom, gaussianFrom, perturbWeeks, scenarioSet } from "../src/js/core/scenarios.js";
import {
  availabilityAdjustment,
  availabilityNote,
  POINTS_BY_POSITION,
  TEAM_CAP,
} from "../src/js/core/availability.js";
import { poolSettings, fieldAfterWeek, equityOverlay } from "../src/js/core/equity.js";
import { resolveModel, winProbFromSpread, DEFAULT_MODEL } from "../src/js/core/probability.js";
import { buildBoard } from "../src/js/core/plan.js";
import { CONFIG } from "../src/js/config.js";
import { cfbEfficiencyFromPpa, boardNameResolver, pullEfficiency } from "./lib/stats.mjs";

const close = (a, b, tolerance, message) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b}`);

// ---------------------------------------------------------------------------
// Futures.
// ---------------------------------------------------------------------------

{
  const a = seededRandom(42);
  const b = seededRandom(42);
  const c = seededRandom(43);
  const first = Array.from({ length: 5 }, () => a());
  assert.deepEqual(
    first,
    Array.from({ length: 5 }, () => b()),
    "the same seed gives the same draws",
  );
  assert.notDeepEqual(
    first,
    Array.from({ length: 5 }, () => c()),
    "a different seed differs",
  );
  assert.ok(
    first.every((x) => x >= 0 && x < 1),
    "uniform on [0, 1)",
  );

  const gaussian = gaussianFrom(seededRandom(7));
  const draws = Array.from({ length: 20000 }, gaussian);
  const mean = draws.reduce((t, x) => t + x, 0) / draws.length;
  const variance = draws.reduce((t, x) => t + (x - mean) ** 2, 0) / draws.length;
  close(mean, 0, 0.03, "gaussian mean");
  close(variance, 1, 0.05, "gaussian variance");
}

{
  const model = DEFAULT_MODEL;
  const week = (number, weeksAhead) => ({
    week: number,
    options: [
      {
        team: "Home",
        opponent: "Away",
        spread: -14,
        source: "projected",
        weeksAhead,
        winProb: winProbFromSpread(-14, model, { weeksAhead }),
      },
      {
        team: "Away",
        opponent: "Home",
        spread: 14,
        source: "projected",
        weeksAhead,
        winProb: winProbFromSpread(14, model, { weeksAhead }),
      },
      {
        team: "Priced",
        opponent: "Other",
        spread: -7,
        source: "market",
        weeksAhead: 0,
        winProb: 0.7,
      },
      {
        team: "Other",
        opponent: "Priced",
        spread: 7,
        source: "market",
        weeksAhead: 0,
        winProb: 0.3,
      },
    ],
  });
  const weeks = [week(2, 1), week(3, 2)];

  const one = perturbWeeks({ weeks, model, random: seededRandom(1), foresight: 1 });
  const same = perturbWeeks({ weeks, model, random: seededRandom(1), foresight: 1 });
  assert.deepEqual(one, same, "a future is reproducible from its seed");

  const [near, far] = one;
  const home = near.options.find((o) => o.team === "Home");
  const away = near.options.find((o) => o.team === "Away");
  assert.notEqual(home.spread, -14, "a projected line inside the foresight is drawn");
  close(home.spread + away.spread, 0, 1e-9, "both sides of a game move together");
  close(home.winProb + away.winProb, 1, 1e-9, "and still sum to one");
  assert.equal(
    near.options.find((o) => o.team === "Priced").winProb,
    0.7,
    "a market line is left alone",
  );
  assert.equal(
    far.options.find((o) => o.team === "Home").spread,
    -14,
    "beyond the foresight nothing moves",
  );

  // Over many futures the drawn probability averages to the widened point
  // estimate, which is what the horizon term in the model is.
  const futures = scenarioSet({ weeks: [week(2, 3)], model, count: 4000, seed: 99, foresight: 3 });
  const average =
    futures.reduce((t, f) => t + f[0].options.find((o) => o.team === "Home").winProb, 0) /
    futures.length;
  close(
    average,
    winProbFromSpread(-14, model, { weeksAhead: 3 }),
    0.012,
    "futures average to the widened estimate",
  );
  const spreads = futures.map((f) => f[0].options.find((o) => o.team === "Home").spread);
  const spreadMean = spreads.reduce((t, x) => t + x, 0) / spreads.length;
  const spreadVar = spreads.reduce((t, x) => t + (x - spreadMean) ** 2, 0) / spreads.length;
  const expectedVar = model.horizon.base ** 2 + model.horizon.perWeek ** 2 * 3;
  close(spreadVar, expectedVar, expectedVar * 0.1, "the drawn spread carries the horizon variance");

  // A team's draw is shared by all its games: two projected games of the same
  // team in one future move the same way.
  const shared = [
    {
      week: 2,
      options: [
        { team: "Iowa", opponent: "X", spread: -10, source: "projected", weeksAhead: 1 },
        { team: "X", opponent: "Iowa", spread: 10, source: "projected", weeksAhead: 1 },
      ],
    },
    {
      week: 3,
      options: [
        { team: "Iowa", opponent: "Y", spread: -10, source: "projected", weeksAhead: 2 },
        { team: "Y", opponent: "Iowa", spread: 10, source: "projected", weeksAhead: 2 },
      ],
    },
  ];
  // The shared draw is one of three parts (the team's own, the opponent's and
  // the game's), so the two errors correlate at about the team share over
  // two, roughly 0.4, and agree in sign about 64% of the time. Independent
  // draws would agree half the time.
  let agree = 0;
  const trials = 1000;
  for (let i = 0; i < trials; i += 1) {
    const [w2, w3] = perturbWeeks({
      weeks: shared,
      model,
      random: seededRandom(1000 + i),
      foresight: 2,
    });
    const d2 = w2.options[0].spread + 10;
    const d3 = w3.options[0].spread + 10;
    if (Math.sign(d2) === Math.sign(d3)) agree += 1;
  }
  assert.ok(agree / trials > 0.57, `a team's games move together (${agree}/${trials} agree)`);
}

// ---------------------------------------------------------------------------
// The college efficiency source.
// ---------------------------------------------------------------------------

{
  const names = ["Hawaii", "San Jose State", "UMass", "FIU", "Georgia", "Ole Miss"];
  const nameOf = boardNameResolver(names);
  assert.equal(nameOf("Georgia"), "Georgia", "an exact name passes through");
  assert.equal(nameOf("Hawai'i"), "Hawaii", "an apostrophe is dropped");
  assert.equal(nameOf("San José State"), "San Jose State", "an accent is dropped");
  assert.equal(nameOf("Massachusetts"), "UMass", "a listed spelling is mapped");
  assert.equal(nameOf("Florida International"), "FIU");
  assert.equal(nameOf("Nowhere Tech"), "Nowhere Tech", "an unknown name keeps its spelling");

  // The endpoint's shape, as its OpenAPI document gives it: predicted points
  // per play for offence and defence, per team per game.
  const payload = [
    {
      season: 2026,
      week: 1,
      team: "Hawai'i",
      opponent: "Georgia",
      offense: {
        overall: 0.1,
        passing: 0.2,
        rushing: 0,
        firstDown: 0,
        secondDown: 0,
        thirdDown: 0,
      },
      defense: {
        overall: 0.4,
        passing: 0.5,
        rushing: 0.3,
        firstDown: 0,
        secondDown: 0,
        thirdDown: 0,
      },
    },
    {
      season: 2026,
      week: 1,
      team: "Georgia",
      opponent: "Hawai'i",
      offense: {
        overall: 0.4,
        passing: 0.5,
        rushing: 0.3,
        firstDown: 0,
        secondDown: 0,
        thirdDown: 0,
      },
      defense: {
        overall: 0.1,
        passing: 0.2,
        rushing: 0,
        firstDown: 0,
        secondDown: 0,
        thirdDown: 0,
      },
    },
    { season: 2026, week: 1, team: "Broken", opponent: "Row", offense: {}, defense: {} },
  ];
  const parsed = cfbEfficiencyFromPpa(payload, 1, nameOf);
  assert.deepEqual(Object.keys(parsed).sort(), ["1|Georgia", "1|Hawaii"], "keyed on our spellings");
  close(
    parsed["1|Hawaii"].margin,
    (0.1 - 0.4) * 70,
    1e-9,
    "margin is the per-play gap over a game",
  );
  close(
    parsed["1|Georgia"].margin,
    -parsed["1|Hawaii"].margin,
    1e-9,
    "and mirrors across the game",
  );
  assert.equal(parsed["1|Hawaii"].opponent, "Georgia");

  // The pull: no key is a reason, not an error; a key and a refusal is an
  // error that carries the source's own message; a key and a payload writes.
  const noKey = await pullEfficiency({ league: "cfb", season: 2026, weeks: [1], cfbdKey: "" });
  assert.equal(noKey.document, null);
  assert.match(noKey.reason, /CFBD_API_KEY is not set/);
  await assert.rejects(
    pullEfficiency({
      league: "cfb",
      season: 2026,
      weeks: [1],
      cfbdKey: "k",
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        text: async () => '{"message":"Unauthorized"}',
      }),
    }),
    /CFBD 401 .*Unauthorized/,
    "a refused key surfaces the source's message",
  );
  const pulled = await pullEfficiency({
    league: "cfb",
    season: 2026,
    weeks: [1],
    names,
    cfbdKey: "k",
    fetchImpl: async (url, init) => {
      assert.match(init.headers.Authorization, /^Bearer k$/, "the key goes as a bearer token");
      assert.match(url, /year=2026&week=1&seasonType=regular/);
      return { ok: true, status: 200, json: async () => payload, text: async () => "" };
    },
  });
  assert.equal(Object.keys(pulled.document.games).length, 2);
  assert.match(pulled.reason, /^2 team-games from CFBD over 1 week\(s\)$/);
}

// ---------------------------------------------------------------------------
// Availability.
// ---------------------------------------------------------------------------

{
  const availability = {
    updatedAt: "2026-09-04T12:00:00Z",
    entries: [
      {
        team: "Eagles",
        player: "QB1",
        position: "QB",
        status: "out",
        weeks: [3],
        reportedAt: "2026-09-04T11:00:00Z",
        source: "team",
      },
      {
        team: "Eagles",
        player: "WR1",
        position: "WR",
        status: "questionable",
        weeks: [3],
        reportedAt: "2026-09-04T11:00:00Z",
      },
      {
        team: "Eagles",
        player: "OT1",
        position: "OT",
        status: "out",
        weeks: [4],
        reportedAt: "2026-09-04T11:00:00Z",
      },
      {
        team: "Lions",
        player: "RB1",
        position: "RB",
        probabilityOut: 0.8,
        points: 2,
        reportedAt: "2026-09-04T11:00:00Z",
      },
    ],
  };
  const projected = availabilityAdjustment({
    availability,
    team: "Eagles",
    week: 3,
    source: "projected",
  });
  close(
    projected.points,
    POINTS_BY_POSITION.QB * 1 + POINTS_BY_POSITION.WR * 0.5,
    1e-9,
    "a quarterback out and a receiver questionable, as points",
  );
  assert.equal(projected.applied.length, 2, "the week-4 entry does not count in week 3");
  assert.ok(projected.reported);
  assert.equal(
    availabilityAdjustment({ availability, team: "Eagles", week: 5, source: "projected" }).points,
    0,
  );
  assert.equal(
    availabilityAdjustment({ availability, team: "Eagles", week: 5, source: "projected" }).reported,
    false,
    "no entry is no report, not health",
  );

  // A market line already prices a report older than it; a newer one moves it.
  const priced = availabilityAdjustment({
    availability,
    team: "Eagles",
    week: 3,
    source: "market",
    lineAt: "2026-09-04T11:30:00Z",
  });
  assert.equal(priced.points, 0, "the line came after the report, so it is priced in");
  assert.equal(priced.priced.length, 2);
  assert.ok(priced.reported);
  const newer = availabilityAdjustment({
    availability,
    team: "Eagles",
    week: 3,
    source: "market",
    lineAt: "2026-09-04T10:00:00Z",
  });
  assert.ok(newer.points > 0, "a report newer than the line moves the line");

  // Explicit numbers win over the defaults, entries without weeks apply everywhere.
  const lions = availabilityAdjustment({
    availability,
    team: "Lions",
    week: 9,
    source: "projected",
  });
  close(lions.points, 1.6, 1e-9, "probability and points from the entry itself");

  // The cap.
  const crowd = {
    entries: Array.from({ length: 6 }, (_, i) => ({
      team: "Jets",
      player: `QB${i}`,
      position: "QB",
      status: "out",
    })),
  };
  assert.equal(
    availabilityAdjustment({ availability: crowd, team: "Jets", week: 1, source: "projected" })
      .points,
    TEAM_CAP,
  );

  assert.ok(availabilityNote(projected).includes("QB1 out"), "the note names the player");
  assert.equal(availabilityNote(null), "");
  assert.equal(
    availabilityAdjustment({ availability: null, team: "Eagles", week: 3, source: "projected" })
      .points,
    0,
  );
}

// ---------------------------------------------------------------------------
// Pool equity.
// ---------------------------------------------------------------------------

{
  const options = [
    { team: "A", opponent: "B", winProb: 0.8 },
    { team: "B", opponent: "A", winProb: 0.2 },
    { team: "C", opponent: "D", winProb: 0.7 },
    { team: "D", opponent: "C", winProb: 0.3 },
  ];
  assert.equal(poolSettings(null, 1), null, "no file is no pool");
  const settings = poolSettings(
    { mode: "equity", entriesAlive: 40, popularity: { "1|A": 0.6, "1|C": 0.3, "2|A": 0.9 } },
    1,
  );
  assert.ok(settings.active);
  assert.equal(settings.mode, "equity");
  assert.equal(settings.popularity.get("A"), 0.6);
  assert.equal(settings.popularity.has("2|A"), false, "another week's shares are not this week's");
  assert.equal(
    poolSettings({ popularity: { "2|A": 0.9 } }, 1).active,
    false,
    "no shares for the week, no leverage",
  );
  assert.equal(
    poolSettings({ mode: "nonsense" }, 1).mode,
    "safest",
    "an unknown mode is the safe one",
  );

  // On the same team as the crowd: the field survives with you, no leverage.
  const crowd = fieldAfterWeek({
    teams: ["A"],
    options,
    popularity: new Map([["A", 1]]),
    picksPerWeek: 1,
  });
  close(crowd.fieldSurvival, 1, 1e-9, "everyone on your team survives with you");
  close(crowd.leverage, 1, 1e-9);
  close(crowd.popularity, 1, 1e-9);
  // Against the crowd: they are gone if you are through.
  const contrarian = fieldAfterWeek({
    teams: ["B"],
    options,
    popularity: new Map([["A", 1]]),
    picksPerWeek: 1,
  });
  close(contrarian.fieldSurvival, 0, 1e-9, "everyone on your opponent goes out when you win");
  // Elsewhere: they survive with their own probability, and the unlisted rest
  // at the listed average.
  const elsewhere = fieldAfterWeek({
    teams: ["C"],
    options,
    popularity: new Map([["A", 0.5]]),
    picksPerWeek: 1,
  });
  close(
    elsewhere.fieldSurvival,
    0.5 * 0.8 + 0.5 * 0.8,
    1e-9,
    "the field's survival is its weighted probability",
  );
  close(elsewhere.leverage, 1 / 0.8, 1e-9);
  // Two picks a week: the field needs both to hold.
  const pair = fieldAfterWeek({
    teams: ["C"],
    options,
    popularity: new Map([["A", 1]]),
    picksPerWeek: 2,
  });
  close(pair.fieldSurvival, 0.8 ** 2, 1e-9, "a two-pick field survives at the rate squared");

  const frontier = {
    week: 1,
    scenarios: 8,
    chosen: { teams: ["A"] },
    candidates: [
      { teams: ["A"], weekWinProb: 0.8, season: 0.1, scenarioMean: 0.1, robust: 1, chosen: true },
      {
        teams: ["C"],
        weekWinProb: 0.7,
        season: 0.09,
        scenarioMean: 0.09,
        robust: 0.5,
        chosen: false,
      },
    ],
  };
  const overlaid = equityOverlay({
    frontier,
    options,
    pool: { mode: "equity", entriesAlive: 40, popularity: { "1|A": 0.9 } },
    picksPerWeek: 1,
  });
  assert.equal(overlaid.pool.mode, "equity");
  const [a, c] = overlaid.candidates;
  close(a.leverage, 1 / (0.9 + 0.1 * 1), 1e-9, "the crowd's team has almost no leverage");
  assert.ok(c.leverage > a.leverage, "the lightly held team has more");
  assert.ok(c.equity > a.equity, "enough to prefer it on equity");
  assert.equal(c.preferred, true, "equity mode prefers it");
  assert.equal(a.chosen, true, "while the coach's call stays the call");
  const balanced = equityOverlay({
    frontier,
    options,
    pool: { mode: "balanced", floor: 0.75, popularity: { "1|A": 0.9 } },
    picksPerWeek: 1,
  });
  assert.equal(
    balanced.candidates[0].preferred,
    true,
    "balanced mode keeps the floor: C at 70% is out",
  );
  const safest = equityOverlay({
    frontier,
    options,
    pool: { popularity: { "1|A": 0.9 } },
    picksPerWeek: 1,
  });
  assert.equal(safest.candidates[0].preferred, true, "safest mode prefers the call");
  assert.equal(
    equityOverlay({ frontier, options, pool: null, picksPerWeek: 1 }).pool,
    null,
    "no file, no overlay",
  );
}

// ---------------------------------------------------------------------------
// Through the board.
// ---------------------------------------------------------------------------

{
  const read = async (name) =>
    JSON.parse(await readFile(new URL(`../data/nfl/${name}`, import.meta.url), "utf8"));
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
  const base = {
    plan,
    odds,
    teams,
    schedule,
    ratings,
    form,
    calibration,
    entry: { picks: {}, swaps: {} },
    refreshSchedule: CONFIG.refresh,
    allowSearch: false,
  };
  const plain = buildBoard(base);

  // The horizon reaches the board: a projected week's favourite is less of one
  // than the same spread would be as a market line this week.
  const later = plain.weeks.find((week) => week.week === plain.currentWeek + 4);
  const favourite = later.options[0];
  assert.equal(favourite.source, "projected");
  assert.equal(favourite.weeksAhead, 4);
  assert.ok(
    favourite.winProb < winProbFromSpread(favourite.spread, plain.model),
    "a projected favourite four weeks out is discounted for the horizon",
  );
  assert.equal(plain.weeks.find((w) => w.week === plain.currentWeek).options[0].weeksAhead, 0);
  assert.equal(
    plain.model.sigma,
    resolveModel(calibration).sigma,
    "the board runs the league's model",
  );

  // A side the fit has not seen carries its own doubt: the option counts them,
  // and its probability is the model's for that count.
  const doubtful = resolveModel({ horizon: { unseen: 6 } });
  assert.ok(
    winProbFromSpread(-14, doubtful, { weeksAhead: 2, unseenSides: 2 }) <
      winProbFromSpread(-14, doubtful, { weeksAhead: 2, unseenSides: 0 }),
    "two unseen sides widen a projection",
  );
  assert.equal(
    winProbFromSpread(-14, doubtful, { weeksAhead: 0, unseenSides: 2 }),
    winProbFromSpread(-14, doubtful),
    "a market line carries no unseen doubt",
  );
  for (const option of later.options.slice(0, 5)) {
    const unseen = [option.team, option.opponent].filter((name) => !form?.ratings?.[name]).length;
    assert.equal(option.unseenSides, unseen, `${option.team}: unseen sides are counted`);
    close(
      option.winProb,
      winProbFromSpread(option.spread, plain.model, {
        weeksAhead: option.weeksAhead,
        unseenSides: option.unseenSides,
      }),
      1e-12,
      `${option.team}: priced with its horizon and its unseen sides`,
    );
  }
  const noFit = buildBoard({ ...base, form: null });
  const noFitLater = noFit.weeks.find((week) => week.week === later.week);
  assert.ok(
    noFitLater.options.every((option) => option.unseenSides === 2),
    "before the first fit every side is unseen",
  );

  // Availability moves a projection by its points, and a market line only
  // when the report is newer than the line.
  const target = favourite.team;
  const availability = {
    updatedAt: "2026-09-04T12:00:00Z",
    entries: [
      {
        team: target,
        player: "QB",
        position: "QB",
        status: "out",
        weeks: [later.week],
        reportedAt: "2026-09-04T11:00:00Z",
      },
    ],
  };
  const hurt = buildBoard({ ...base, availability });
  const hurtOption = hurt.weeks
    .find((w) => w.week === later.week)
    .options.find((o) => o.team === target);
  close(
    hurtOption.spread,
    favourite.spread + POINTS_BY_POSITION.QB,
    0.11,
    "the quarterback's points come off the projection",
  );
  assert.ok(hurtOption.winProb < favourite.winProb, "and the probability with them");
  assert.ok(hurtOption.availability?.note.includes("QB out"), "the option says why");
  const opponentRow = hurt.weeks
    .find((w) => w.week === later.week)
    .options.find((o) => o.team === favourite.opponent);
  close(opponentRow.spread, -hurtOption.spread, 1e-9, "the other side mirrors it");

  const current = plain.weeks.find((w) => w.week === plain.currentWeek);
  const priced = current.options.find((o) => o.source === "market");
  const stale = {
    updatedAt: "2026-09-04T12:00:00Z",
    entries: [
      {
        team: priced.team,
        player: "QB",
        position: "QB",
        status: "out",
        weeks: [current.week],
        reportedAt: "2020-01-01T00:00:00Z",
      },
    ],
  };
  const unchanged = buildBoard({ ...base, availability: stale });
  const stillPriced = unchanged.weeks
    .find((w) => w.week === current.week)
    .options.find((o) => o.team === priced.team);
  assert.equal(
    stillPriced.spread,
    priced.spread,
    "a report older than the market line changes nothing",
  );
  assert.equal(stillPriced.winProb, priced.winProb);

  // The pool reaches the frontier, and its absence leaves survival mode.
  const withSearch = buildBoard({ ...base, allowSearch: true });
  assert.equal(withSearch.frontier.pool, null, "no pool.json: no leverage shown");
  const call = withSearch.frontier.candidates[0].teams[0];
  const pool = {
    updatedAt: "2026-09-04T12:00:00Z",
    mode: "equity",
    entriesAlive: 25,
    popularity: { [`${withSearch.currentWeek}|${call}`]: 0.7 },
  };
  const leveraged = buildBoard({ ...base, pool, allowSearch: true });
  assert.equal(leveraged.frontier.pool.mode, "equity");
  assert.ok(
    leveraged.frontier.candidates.every((c) => Number.isFinite(c.leverage)),
    "every candidate carries leverage",
  );
  assert.ok(
    leveraged.frontier.candidates.some((c) => c.preferred),
    "and the pool names a preference",
  );
  assert.deepEqual(
    leveraged.recommendation.picks,
    withSearch.recommendation.picks,
    "the pool never changes the coach's own path",
  );
}

console.log(
  "Inputs OK: futures are seeded, mirrored and average to the widened estimate with a shared " +
    "team draw; availability is points times probability, priced-in reports leave a market line " +
    "alone and the cap holds; pool leverage follows popularity and the modes; and all three reach " +
    "the board.",
);
