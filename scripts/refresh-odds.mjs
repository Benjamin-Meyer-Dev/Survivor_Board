#!/usr/bin/env node
/**
 * Rewrite data/<league>/odds.json with current market lines for the week ahead.
 *
 * Run by .github/workflows/refresh-odds.yml once a day. Also runnable
 * locally: ODDS_API_KEY=... npm run refresh
 *
 * Both leagues are refreshed in one run. They share nothing but this script:
 * separate sport keys, separate data folders, separate freshness guards, and a
 * failure in one never stops the other.
 *
 * One run does six things:
 *
 *   1. prices every legal option for the upcoming week from the market, book
 *      by book, through the league's calibrated model,
 *   2. records the winner and the margin of every game just played,
 *   3. pulls the efficiency statistics for the games played, where the league
 *      has a source (best effort, never fatal),
 *   4. refits the team ratings to everything it has pulled this season, which
 *      is what prices the weeks the market has not posted yet,
 *   5. writes an immutable snapshot of the day's lines, so the backtest can
 *      say afterwards what the board knew and when, and
 *   6. re-runs the recommendation over the remaining weeks on the new numbers,
 *      futures included, and says whether the plan should change.
 *
 * Step 6 is the point of the other five. New odds in an early week, or a
 * team the season has revalued, can change what the right pick is in week 11,
 * so the whole remaining path is recomputed rather than just this week's.
 *
 * The recommendation is advice, never an edit: the board keeps showing your
 * selection next to it and you decide. See docs/ARCHITECTURE.md.
 */

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  fetchEvents,
  findEvent,
  consensusFor,
  fetchScores,
  winnerOf,
  isTie,
  sameTeam,
  SPORT_KEYS,
  MARKETS,
} from "./lib/odds-api.mjs";
import { currentWeekFor, resultsDueFor } from "./lib/weeks.mjs";
import { fitForm, holdoutError, marketError, resolveRatingParams } from "./lib/rate.mjs";
import { pullStatsForLeague } from "./pull-stats.mjs";
import { marketWinProb, resolveModel } from "../src/js/core/probability.js";
import { lineKey, buildBoard } from "../src/js/core/plan.js";
import { LEAGUE_IDS, LEAGUES } from "../src/js/leagues.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pathFor = (league, name) => join(ROOT, "data", league, name);

/** A bigger favourite priced below a smaller one by this much is worth a look. */
const INVERSION_GAP_POINTS = 7;
const INVERSION_GAP_PROB = 0.005;

async function main() {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.error("ODDS_API_KEY is not set. Nothing to do.");
    process.exit(1);
  }

  // Only the league named, when one is named. Lets a workflow run just the
  // NFL in January without spending quota on a college season that is over.
  const only = process.env.LEAGUE;
  const leagues = only ? [only] : LEAGUE_IDS;

  const allFlags = [];
  const weeksSeen = new Set();
  let failures = 0;

  for (const league of leagues) {
    if (!LEAGUES[league]) {
      console.error(`Unknown league "${league}".`);
      failures += 1;
      continue;
    }

    try {
      console.log(`\n=== ${LEAGUES[league].label} ===`);
      const { flags, week } = await refreshLeague(league, apiKey);
      allFlags.push(...flags);
      if (week !== null) weeksSeen.add(week);
    } catch (error) {
      // One league's outage must not cost the other its refresh.
      failures += 1;
      console.error(`${LEAGUES[league].label} refresh failed: ${error.message}`);
    }
  }

  // Surface flags to the workflow so it can open an issue, and the week the
  // leagues are on so the bot's commit message says which one it refreshed.
  if (process.env.GITHUB_OUTPUT) {
    const summary = allFlags.map((flag) => flag.message).join(" ");
    const week = [...weeksSeen].sort((a, b) => a - b).join("/");
    await writeFile(
      process.env.GITHUB_OUTPUT,
      `flagged=${allFlags.length}\nsummary=${summary}\ncurrentWeek=${week}\n`,
      { flag: "a" },
    );
  }

  if (failures === leagues.length) process.exit(1);
}

/**
 * Refresh one league. Returns the flags it raised and the week it priced,
 * which is null when there was nothing to price.
 */
async function refreshLeague(league, apiKey) {
  const oddsPath = pathFor(league, "odds.json");
  const formPath = pathFor(league, "form.json");

  const plan = JSON.parse(await readFile(pathFor(league, "plan.json"), "utf8"));
  const previous = JSON.parse(await readFile(oddsPath, "utf8"));
  const schedule = JSON.parse(await readFile(pathFor(league, "schedule.json"), "utf8"));
  const ratings = JSON.parse(await readFile(pathFor(league, "ratings.json"), "utf8"));
  const teams = JSON.parse(await readFile(pathFor(league, "teams.json"), "utf8"));
  // Absent until the first run that has something to fit, and absent again if
  // it is ever deleted. Both are fine: the board and this job fall back to the
  // ratings the league shipped with.
  const previousForm = await readJsonOrNull(formPath);
  // The league's fitted model and fit weights (scripts/calibrate.mjs), the
  // availability and pool files a human keeps, and last run's stats. Every one
  // is optional and every one is read the same way the browser reads it.
  const calibration = await readJsonOrNull(pathFor(league, "calibration.json"));
  const availability = await readJsonOrNull(pathFor(league, "availability.json"));
  const pool = await readJsonOrNull(pathFor(league, "pool.json"));
  const model = resolveModel(calibration);
  const params = resolveRatingParams(calibration?.rating);
  const isEligible = (team) => Object.values(teams.conferences).some((roster) => team in roster);

  // Two clocks. Lines are priced while there is a week to price. Scores are
  // read from the first kickoff until a week after the last, because the first
  // clock calls the season over while the final week is still being played,
  // and the board marks wins and losses from these scores alone.
  const week = currentWeekFor(plan);
  const scoresDue = resultsDueFor(plan);
  if (week === null && !scoresDue) {
    console.log("Season is over. Leaving odds.json untouched.");
    return { flags: [], week: null };
  }

  // How recently the lines were pulled is the only thing that decides whether
  // this run does any work, and the workflow sets the threshold rather than
  // trying to be exact about the clock: a long gap on the scheduled runs makes
  // this the once-a-day guard, so the day's second UTC slot and any cron that
  // arrives hours late collapse into the one pull that already happened. The
  // short default covers the other case, a burst of manual runs from the
  // Actions tab landing behind each other. Either way the skip is free -
  // nothing below here has spent API quota yet.
  const sincePull = Date.now() - Date.parse(previous.updatedAt ?? 0);
  const configured = process.env.MIN_REFRESH_GAP_MS ?? "";
  const minGap = /^[0-9]+$/.test(configured) ? Number(configured) : 4 * 60 * 1000;
  if (Number.isFinite(sincePull) && sincePull >= 0 && sincePull < minGap) {
    console.log(
      `Lines are ${Math.round(sincePull / 60000)}min old, under the ` +
        `${Math.round(minGap / 60000)}min minimum. Nothing to do.`,
    );
    return { flags: [], week: null };
  }

  const sport = SPORT_KEYS[league];
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  console.log(
    `Model: ${calibration ? `calibration.json (${calibration.fittedAt})` : "defaults"}, ` +
      `sigma ${model.sigma}, moneyline weight ${model.moneylineWeight}, markets ${MARKETS.join("+")}.`,
  );

  let priced = { lines: previous.lines, flags: [], count: 0, total: 0, fresh: {} };
  if (week === null) {
    console.log("Season is over. Reading the last scores; lines stay as they were.");
  } else {
    priced = await priceWeek({
      apiKey,
      sport,
      week,
      plan,
      previous,
      schedule,
      ratings,
      teams,
      model,
      league,
      now,
    });
  }

  // Winners for the board, margins for the fit below. Both come out of the one
  // scores call, and the free tier only looks back three days, so a margin
  // this run does not record is one no later run can.
  const results = { ...(previous.results ?? {}) };
  const scores = { ...(previous.scores ?? {}) };
  if (scoresDue) {
    await recordResults({ apiKey, sport, schedule, isEligible, results, scores });
  } else {
    console.log("No games played yet. Skipping the scores call.");
  }

  const currentWeek = week ?? previous.currentWeek;
  const next = {
    $comment: previous.$comment,
    updatedAt: now,
    currentWeek,
    lines: priced.lines,
    results,
    scores,
    // Both settled below: the refit and the re-plan read this very object, so
    // they cannot run until it exists, and what they find goes back into it.
    flags: priced.flags,
    recommendation: previous.recommendation,
  };

  // The efficiency layer: what the played games say through expected points.
  // Best effort - a source that is down or a key that is missing costs the
  // run nothing but the layer - and it has to come before the refit reads it.
  const stats = await refreshStats({ league, results: next });

  // Refit the ratings on everything pulled so far. This is what the weeks the
  // market has not posted are priced off, so it has to happen before the
  // re-plan below rather than after it.
  const form = refit({ schedule, ratings, odds: next, stats, previousForm, league, params });

  // Now ask the question the run exists to answer: on today's numbers, should
  // the plan for the rest of the season change? Both boards are built with an
  // empty entry - the shared locks live in the browser's store - so this is
  // the unconstrained path, and any move is a move in the advice itself.
  const moved = replan({
    plan,
    teams,
    schedule,
    ratings,
    calibration,
    availability,
    pool,
    fromOdds: previous,
    fromForm: previousForm,
    toOdds: next,
    toForm: form?.document ?? null,
    week: currentWeek,
  });
  next.recommendation = moved.recommendation;
  const flags = [...priced.flags, ...moved.flags, ...(form?.flags ?? [])];
  next.flags = flags;

  await writeFile(oddsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  if (form) {
    await writeFile(formPath, `${JSON.stringify(form.document, null, 2)}\n`, "utf8");
  }
  if (week !== null && priced.count > 0) {
    await writeSnapshot({
      league,
      now,
      week,
      lines: priced.fresh,
      form: form?.document ?? previousForm,
      recommendation: next.recommendation,
    });
  }
  console.log(`Priced ${priced.count}/${priced.total} lines. ${flags.length} flag(s).`);

  // Prefixed so a flag in an issue says which pool it came from.
  return {
    week,
    flags: flags.map((flag) => ({
      ...flag,
      message: `[${LEAGUES[league].label}] ${flag.message}`,
    })),
  };
}

/** A JSON file that is allowed not to exist yet. */
async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The day's lines, kept as they were priced.
 *
 * odds.json is overwritten every run, so by Saturday it holds Saturday's number
 * and nothing of Tuesday's. The snapshot keeps each run's lines under its own
 * timestamp and is never rewritten, which is what lets the backtest ask, for
 * any day of the season, what the board showed and how it turned out. The
 * fitted ratings of the day ride along, so the projections the board made for
 * the weeks ahead can be rebuilt and scored against the lines those weeks
 * eventually closed at.
 */
async function writeSnapshot({ league, now, week, lines, form, recommendation }) {
  const dir = pathFor(league, "snapshots");
  await mkdir(dir, { recursive: true });
  // Named by the run's own timestamp, to the second, and never over an
  // existing file: two runs in one second is not a case, but a snapshot that
  // could be rewritten is not a snapshot.
  let stamp = now.replace(/:/g, "-");
  let path = join(dir, `${stamp}.json`);
  for (let attempt = 2; await exists(path); attempt += 1) {
    path = join(dir, `${stamp}-${attempt}.json`);
  }
  stamp = path.slice(dir.length + 1, -".json".length);
  await writeFile(
    path,
    `${JSON.stringify(
      {
        $comment:
          "One run's lines, written by scripts/refresh-odds.mjs and never rewritten. Read by " +
          "scripts/backtest.mjs to score what the board showed against what happened.",
        at: now,
        week,
        lines,
        form: form ? { updatedAt: form.updatedAt, ratings: form.ratings } : null,
        recommendation,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`Snapshot written: snapshots/${stamp}.json`);
}

/**
 * The efficiency statistics for the games played, when the league has a
 * source that has published them. Returns the games map for the fit, from the
 * fresh pull or from the file already on disk, or an empty map.
 */
async function refreshStats({ league, results }) {
  const played = Object.keys(results.results ?? {}).length;
  const onDisk = await readJsonOrNull(pathFor(league, "stats.json"));
  if (played === 0) {
    console.log("No games played yet. Skipping the efficiency pull.");
    return onDisk?.games ?? {};
  }
  try {
    const pulled = await pullStatsForLeague(league);
    console.log(`Efficiency: ${pulled.reason}${pulled.written ? " - stats.json updated." : "."}`);
    return pulled.document?.games ?? onDisk?.games ?? {};
  } catch (error) {
    console.warn(`Efficiency pull failed, fitting without new stats: ${error.message}`);
    return onDisk?.games ?? {};
  }
}

/**
 * Refit the team ratings to every market line, final margin and efficiency
 * margin pulled this season, and report whether the fit is worth having.
 *
 * The fit is only ever used to price a matchup the market has not posted, so
 * the test that means anything is out of sample: fit on the weeks before the
 * latest one pulled, then see which prices that week better, the fit or the
 * ratings the league shipped with. A fit that loses that comparison is left in
 * place - the numbers are still the best guess for the weeks ahead - but the
 * run says so, and the flag opens an issue.
 *
 * @returns {{document:object, flags:Array}|null} Null when there is nothing to
 *   fit yet, in which case any existing form.json is left exactly as it was.
 */
function refit({ schedule, ratings, odds, stats, previousForm, league, params }) {
  const document = fitForm({
    schedule,
    lines: odds.lines,
    scores: odds.scores,
    stats,
    base: ratings.ratings,
    homeFieldPoints: ratings.homeFieldPoints,
    throughWeek: odds.currentWeek ?? 1,
    params,
    updatedAt: odds.updatedAt,
  });

  if (!document) {
    console.log("Nothing pulled yet, so no ratings to fit.");
    return null;
  }

  console.log(
    `Refit ${document.fit.teams} team rating(s) from ${document.fit.marketLines} market ` +
      `line(s), ${document.fit.margins} margin(s) and ${document.fit.efficiency} efficiency ` +
      `margin(s) (decay ${params.decay}, anchor ${params.anchor}).`,
  );

  const flags = [];
  const holdout = holdoutError({
    schedule,
    lines: odds.lines,
    scores: odds.scores,
    stats,
    base: ratings.ratings,
    homeFieldPoints: ratings.homeFieldPoints,
    params,
  });

  if (!holdout) {
    // One week of lines cannot be split into a fit and a test.
    const inSample = marketError({
      schedule,
      lines: odds.lines,
      base: ratings.ratings,
      overlay: document.ratings,
      homeFieldPoints: ratings.homeFieldPoints,
    });
    if (inSample) console.log(`  explains the lines pulled so far to ${inSample.mae} pts.`);
    return { document, flags };
  }

  const verdict = holdout.fitted <= holdout.base ? "better" : "WORSE";
  console.log(
    `  week ${holdout.week} held out: fitted ${holdout.fitted} pts vs shipped ` +
      `${holdout.base} pts over ${holdout.count} game(s) - ${verdict}.`,
  );

  if (holdout.fitted > holdout.base) {
    flags.push({
      week: holdout.week,
      kind: "fit",
      message:
        `The fitted ratings priced week ${holdout.week} worse than the ones the league ` +
        `shipped with (${holdout.fitted} pts vs ${holdout.base}). The coach is planning ` +
        `the unposted weeks on them, so check ${league}/form.json.`,
    });
  }

  // Biggest movers, so a run reads as a story about the season rather than a
  // wall of numbers.
  const movers = Object.entries(document.ratings)
    .map(([team, rating]) => ({ team, delta: rating - ratings.ratings[team] }))
    .filter((move) => Math.abs(move.delta) >= 1)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 5);
  if (movers.length) {
    console.log(
      `  movers: ${movers
        .map((move) => `${move.team} ${move.delta > 0 ? "+" : ""}${move.delta.toFixed(1)}`)
        .join(", ")}`,
    );
  }
  if (previousForm) {
    const since = Object.entries(document.ratings)
      .map(([team, rating]) => Math.abs(rating - (previousForm.ratings?.[team] ?? rating)))
      .reduce((most, move) => Math.max(most, move), 0);
    console.log(`  largest move since the last run: ${since.toFixed(1)} pts.`);
  }

  return { document, flags };
}

/**
 * Re-run the optimiser on yesterday's numbers and today's, and report every
 * remaining week whose pick moved.
 *
 * Both new lines and a refit can move it, and the point of running daily is
 * that either might: a team the season has revalued changes what is worth
 * spending in week 3 as surely as a line moving does.
 *
 * @returns {{recommendation:object, flags:Array, changedWeeks:Array}}
 */
function replan({
  plan,
  teams,
  schedule,
  ratings,
  calibration,
  availability,
  pool,
  fromOdds,
  fromForm,
  toOdds,
  toForm,
  week,
}) {
  const boardArgs = {
    plan,
    teams,
    schedule,
    ratings,
    calibration,
    availability,
    pool,
    entry: { picks: {}, swaps: {} },
  };
  const before = buildBoard({ ...boardArgs, odds: fromOdds, form: fromForm });
  const after = buildBoard({ ...boardArgs, odds: toOdds, form: toForm });

  const changedWeeks = [];
  for (let w = week; w <= plan.weeks.length; w += 1) {
    const a = [...(before.recommendation.picks[w] ?? [])].sort().join(" + ");
    const b = [...(after.recommendation.picks[w] ?? [])].sort().join(" + ");
    if (a !== b) changedWeeks.push({ week: w, from: a, to: b });
  }

  const flags = [];
  if (changedWeeks.length) {
    console.log("Recommendation changed:");
    for (const change of changedWeeks) {
      console.log(`  week ${change.week}: ${change.from}  ->  ${change.to}`);
    }
    flags.push({
      week,
      kind: "recommendation",
      message:
        `Recommendation moved in ${changedWeeks.length} week(s): ` +
        changedWeeks.map((c) => `wk${c.week} ${c.to}`).join("; "),
    });
  } else {
    console.log("Recommendation unchanged for every remaining week.");
  }

  console.log(
    `Path odds: ${(before.pathProbability * 100).toFixed(2)}% -> ${(after.pathProbability * 100).toFixed(2)}%`,
  );

  // This week's call across futures: what it costs to take each alternative,
  // on the numbers as they stand and across the futures.
  const frontier = after.frontier;
  if (frontier) {
    console.log(
      `This week (${frontier.scenarios} futures${frontier.pool ? `, pool mode ${frontier.pool.mode}` : ""}):`,
    );
    for (const candidate of frontier.candidates) {
      const leverage = candidate.leverage ? `  leverage x${candidate.leverage.toFixed(2)}` : "";
      console.log(
        `  ${candidate.teams.join(" + ").padEnd(34)} week ${(candidate.weekWinProb * 100).toFixed(1)}%` +
          `  season ${(candidate.season * 100).toFixed(2)}%  futures ${(candidate.scenarioMean * 100).toFixed(2)}%` +
          `  robust ${(candidate.robust * 100).toFixed(0)}%  cost ${(candidate.scenarioCost * 100).toFixed(1)}%` +
          `${leverage}${candidate.chosen ? "  <- call" : ""}${candidate.preferred && !candidate.chosen ? "  <- pool prefers" : ""}`,
      );
    }
  }

  return {
    changedWeeks,
    flags,
    recommendation: {
      picks: after.recommendation.picks,
      pathProbability: Number(after.pathProbability.toFixed(6)),
      frontier: frontier
        ? {
            week: frontier.week,
            scenarios: frontier.scenarios,
            candidates: frontier.candidates.map((candidate) => ({
              teams: candidate.teams,
              weekWinProb: Number(candidate.weekWinProb.toFixed(4)),
              season: Number(candidate.season.toFixed(6)),
              scenarioMean: Number(candidate.scenarioMean.toFixed(6)),
              robust: Number(candidate.robust.toFixed(3)),
              seasonCost: Number(candidate.seasonCost.toFixed(4)),
              scenarioCost: Number(candidate.scenarioCost.toFixed(4)),
              ...(candidate.leverage ? { leverage: Number(candidate.leverage.toFixed(3)) } : {}),
              chosen: candidate.chosen,
            })),
          }
        : null,
    },
  };
}

/**
 * Price every legal option for the week from the market. Returns the merged
 * lines, the flags raised, how many lines the market actually covered, and the
 * lines priced this run on their own, for the snapshot.
 *
 * Only this week is priced: books do not post week 9 in September. Every other
 * week is projected from the ratings, which is what the refit exists to keep
 * honest.
 *
 * A line keeps the spread it opened at. odds.json is rewritten daily and the
 * key is the week and the team, so the previous run's line for the same key is
 * the same game a day earlier: its `opened` carries forward, and the board
 * shows how far the market has moved since the week was first priced.
 */
async function priceWeek({
  apiKey,
  sport,
  week,
  plan,
  previous,
  schedule,
  ratings,
  teams,
  model,
  league,
  now,
}) {
  const weekPlan = plan.weeks.find((entry) => entry.week === week);
  const isEligible = (team) => Object.values(teams.conferences).some((roster) => team in roster);
  const threshold = plan.dangerThreshold ?? -10;
  const moveFlag = LEAGUES[league]?.lineMoveFlag ?? 3;

  console.log(`Refreshing week ${week} (${weekPlan.label}, ${plan.season}).`);
  const events = await fetchEvents(apiKey, sport);
  console.log(`Odds API returned ${events.length} events.`);

  const lines = { ...previous.lines };
  const fresh = {};
  const flags = [];
  let priced = 0;
  let capped = 0;
  let stale = 0;

  // Price every legal option this week, not just the plan's two picks - the
  // board lets you swap to any of them, so they all need a real line.
  const planTeams = new Set(weekPlan.picks.map((pick) => pick.team));
  const targets = [];
  for (const game of schedule.weeks[String(week)] ?? []) {
    for (const [team, opponent] of [
      [game.home, game.away],
      [game.away, game.home],
    ]) {
      if (!isEligible(team)) continue;
      // No rating means the opponent is outside the league we price, which in
      // college is an FCS side and never a legal pick.
      if (!(opponent in ratings.ratings)) continue;
      targets.push({ team, opponent, key: lineKey(week, team), isPick: planTeams.has(team) });
    }
  }

  for (const target of targets) {
    const event = findEvent(events, target.team, target.opponent);
    if (!event) {
      console.warn(
        `  no event found for ${target.team} vs ${target.opponent} - keeping projection`,
      );
      continue;
    }

    const consensus = consensusFor(event, target.team, model);
    if (!consensus) {
      console.warn(`  no consensus spread for ${target.team} - keeping projection`);
      continue;
    }

    const spread = Number(consensus.spread.toFixed(1));
    const winProb = marketWinProb({
      spread,
      total: consensus.total,
      moneylineProb: consensus.moneylineProb,
      model,
    });

    const before = previous.lines?.[target.key];
    const opened = before?.source === "market" ? (before.opened ?? before.spread) : spread;
    const openedAt =
      before?.source === "market" ? (before.openedAt ?? before.updatedAt ?? null) : now;

    lines[target.key] = {
      spread,
      total: consensus.total,
      source: "market",
      winProb: Number(winProb.toFixed(4)),
      moneyline: consensus.moneyline,
      moneylineProb:
        consensus.moneylineProb === null ? null : Number(consensus.moneylineProb.toFixed(4)),
      books: consensus.books,
      moneylineBooks: consensus.moneylineBooks,
      capped: consensus.capped,
      opened,
      openedAt,
      updatedAt: now,
    };
    fresh[target.key] = lines[target.key];
    priced += 1;
    capped += consensus.capped;
    stale += consensus.stale;

    const movement = spread - opened;
    console.log(
      `  ${target.team.padEnd(18)} ${spread > 0 ? "+" : ""}${spread}  ${(winProb * 100).toFixed(1)}%` +
        `  (${consensus.books} books${consensus.total !== null ? `, total ${consensus.total}` : ""}` +
        `${consensus.moneylineProb !== null ? `, ml ${(consensus.moneylineProb * 100).toFixed(1)}%` : ", no ml"}` +
        `${consensus.capped ? `, ${consensus.capped} capped` : ""}` +
        `${movement !== 0 ? `, opened ${opened > 0 ? "+" : ""}${opened}` : ""})`,
    );

    if (target.isPick && spread > threshold) {
      flags.push({
        week,
        team: target.team,
        spread,
        kind: "line",
        message: `${target.team} is only ${Math.abs(spread).toFixed(1)} points. Consider a backup.`,
      });
    }
    // A line that has moved this far since the week was first priced is news
    // whoever holds it: the market has learned something (an injury, a
    // suspension, the weather) that the ratings have not. Raised the run it
    // crosses the mark, not every run after while it stays there.
    const movedBefore = before?.source === "market" ? Math.abs(before.spread - opened) : 0;
    if (Math.abs(movement) >= moveFlag && movedBefore < moveFlag) {
      flags.push({
        week,
        team: target.team,
        spread,
        kind: "movement",
        message:
          `${target.team} has moved from ${opened > 0 ? "+" : ""}${opened} to ` +
          `${spread > 0 ? "+" : ""}${spread} since the week was first priced.`,
      });
    }
  }

  // A bigger favourite priced below a smaller one is what a capped or stale
  // moneyline used to do to the numbers; the log says if any survived the fix.
  const inversions = findInversions(fresh);
  for (const pair of inversions) {
    console.warn(
      `  inversion: ${pair.bigger.team} ${pair.bigger.spread} at ${(pair.bigger.winProb * 100).toFixed(1)}% ` +
        `sits below ${pair.smaller.team} ${pair.smaller.spread} at ${(pair.smaller.winProb * 100).toFixed(1)}%`,
    );
  }
  if (capped || stale) {
    // Both sides of a game are priced, so each is counted from both.
    console.log(
      `  ${Math.round(capped / 2)} capped moneyline pair(s) and ${Math.round(stale / 2)} stale ` +
        `book quote(s) were left out.`,
    );
  }

  return { lines, fresh, flags, count: priced, total: targets.length };
}

/** Pairs where a clearly bigger favourite carries a lower probability. */
function findInversions(lines) {
  const entries = Object.entries(lines)
    .map(([key, line]) => ({ team: key.split("|")[1], spread: line.spread, winProb: line.winProb }))
    .filter((line) => line.spread < 0)
    .sort((a, b) => a.spread - b.spread);
  const found = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const bigger = entries[i];
      const smaller = entries[j];
      if (smaller.spread - bigger.spread < INVERSION_GAP_POINTS) continue;
      if (smaller.winProb - bigger.winProb > INVERSION_GAP_PROB) found.push({ bigger, smaller });
    }
  }
  return found;
}

/**
 * Final scores, recorded against the schedule and keyed "<week>|<team>", in
 * two maps with two different readers:
 *
 *   results  "W" or "L". The board marks a locked pick won or lost from these
 *            and nothing else: there are no buttons for it. A game the feed
 *            does not settle (a tie, or one it never returns) stays unresolved
 *            until someone adds the key by hand.
 *   scores   The margin, signed from that team's point of view. Nothing in the
 *            UI reads it; it is what the rating fit learns from, and it is kept
 *            rather than derived because the free tier only looks back three
 *            days. A margin this run does not write down is gone.
 *
 * The job runs daily, so every game is seen at least twice before it falls out
 * of that window.
 */
async function recordResults({ apiKey, sport, schedule, isEligible, results, scores }) {
  let recorded = 0;
  let margins = 0;

  try {
    const scored = await fetchScores(apiKey, sport, 3);
    for (const event of scored) {
      const outcome = winnerOf(event);
      if (!outcome) {
        if (isTie(event)) {
          console.warn(
            `  ${event.away_team} at ${event.home_team} ended level. No result recorded: ` +
              `what a tie means is the pool's rule, so set it in odds.json if it counts.`,
          );
        }
        continue;
      }

      for (const [weekNumber, games] of Object.entries(schedule.weeks)) {
        const game = games.find(
          (g) =>
            (sameTeam(g.home, event.home_team) && sameTeam(g.away, event.away_team)) ||
            (sameTeam(g.home, event.away_team) && sameTeam(g.away, event.home_team)),
        );
        if (!game) continue;

        for (const team of [game.home, game.away]) {
          if (!isEligible(team)) continue;
          const key = lineKey(Number(weekNumber), team);
          const won = sameTeam(team, outcome.winner);
          const value = won ? "W" : "L";
          if (results[key] !== value) recorded += 1;
          results[key] = value;
          const margin = won ? outcome.margin : -outcome.margin;
          if (scores[key] !== margin) margins += 1;
          scores[key] = margin;
        }
        break;
      }
    }
    console.log(
      `Recorded ${recorded} new result(s) and ${margins} margin(s) from ` +
        `${scored.length} scored event(s).`,
    );
  } catch (error) {
    // Scores must not cost the run its lines. The next day's run sees the same
    // games again, so a miss here is a delay, not a gap.
    console.warn(`Could not read scores: ${error.message}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
