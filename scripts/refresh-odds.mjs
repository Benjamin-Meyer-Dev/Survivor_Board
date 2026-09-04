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
 * One run does four things:
 *
 *   1. prices every legal option for the upcoming week from the market,
 *   2. records the winner and the margin of every game just played,
 *   3. refits the team ratings to everything it has pulled this season, which
 *      is what prices the weeks the market has not posted yet, and
 *   4. re-runs the recommendation over the remaining weeks on the new numbers
 *      and says whether the plan should change.
 *
 * Step 4 is the point of the other three. New odds in an early week, or a
 * team the season has revalued, can change what the right pick is in week 11,
 * so the whole remaining path is recomputed rather than just this week's.
 *
 * The recommendation is advice, never an edit: the board keeps showing your
 * selection next to it and you decide. See docs/ARCHITECTURE.md.
 */

import { readFile, writeFile } from "node:fs/promises";
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
} from "./lib/odds-api.mjs";
import { currentWeekFor, resultsDueFor } from "./lib/weeks.mjs";
import { fitForm, holdoutError, marketError } from "./lib/rate.mjs";
import { winProbFromSpread, devig } from "../src/js/core/probability.js";
import { lineKey, buildBoard } from "../src/js/core/plan.js";
import { LEAGUE_IDS, LEAGUES } from "../src/js/leagues.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pathFor = (league, name) => join(ROOT, "data", league, name);

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

  let priced = { lines: previous.lines, flags: [], count: 0, total: 0 };
  if (week === null) {
    console.log("Season is over. Reading the last scores; lines stay as they were.");
  } else {
    priced = await priceWeek({ apiKey, sport, week, plan, previous, schedule, ratings, teams });
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
    updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    currentWeek,
    lines: priced.lines,
    results,
    scores,
    // Both settled below: the refit and the re-plan read this very object, so
    // they cannot run until it exists, and what they find goes back into it.
    flags: priced.flags,
    recommendation: previous.recommendation,
  };

  // Refit the ratings on everything pulled so far. This is what the weeks the
  // market has not posted are priced off, so it has to happen before the
  // re-plan below rather than after it.
  const form = refit({ schedule, ratings, odds: next, previousForm, league });

  // Now ask the question the run exists to answer: on today's numbers, should
  // the plan for the rest of the season change? Both boards are built with an
  // empty entry - the shared locks live in the browser's store - so this is
  // the unconstrained path, and any move is a move in the advice itself.
  const moved = replan({
    plan,
    teams,
    schedule,
    ratings,
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

/**
 * Refit the team ratings to every market line and final margin pulled this
 * season, and report whether the fit is worth having.
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
function refit({ schedule, ratings, odds, previousForm, league }) {
  const document = fitForm({
    schedule,
    lines: odds.lines,
    scores: odds.scores,
    base: ratings.ratings,
    homeFieldPoints: ratings.homeFieldPoints,
    throughWeek: odds.currentWeek ?? 1,
    updatedAt: odds.updatedAt,
  });

  if (!document) {
    console.log("Nothing pulled yet, so no ratings to fit.");
    return null;
  }

  console.log(
    `Refit ${document.fit.teams} team rating(s) from ${document.fit.marketLines} market ` +
      `line(s) and ${document.fit.margins} margin(s).`,
  );

  const flags = [];
  const holdout = holdoutError({
    schedule,
    lines: odds.lines,
    scores: odds.scores,
    base: ratings.ratings,
    homeFieldPoints: ratings.homeFieldPoints,
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
function replan({ plan, teams, schedule, ratings, fromOdds, fromForm, toOdds, toForm, week }) {
  const boardArgs = { plan, teams, schedule, ratings, entry: { picks: {}, swaps: {} } };
  const before = buildBoard({ ...boardArgs, odds: fromOdds, form: fromForm }).recommendation;
  const after = buildBoard({ ...boardArgs, odds: toOdds, form: toForm }).recommendation;

  const changedWeeks = [];
  for (let w = week; w <= plan.weeks.length; w += 1) {
    const a = [...(before.picks[w] ?? [])].sort().join(" + ");
    const b = [...(after.picks[w] ?? [])].sort().join(" + ");
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

  return {
    changedWeeks,
    flags,
    recommendation: {
      picks: after.picks,
      pathProbability: Number(after.pathProbability.toFixed(6)),
    },
  };
}

/**
 * Price every legal option for the week from the market. Returns the merged
 * lines, the flags raised, and how many lines the market actually covered.
 *
 * Only this week is priced: books do not post week 9 in September. Every other
 * week is projected from the ratings, which is what the refit exists to keep
 * honest.
 */
async function priceWeek({ apiKey, sport, week, plan, previous, schedule, ratings, teams }) {
  const weekPlan = plan.weeks.find((entry) => entry.week === week);
  const isEligible = (team) => Object.values(teams.conferences).some((roster) => team in roster);
  const threshold = plan.dangerThreshold ?? -10;

  console.log(`Refreshing week ${week} (${weekPlan.label}, ${plan.season}).`);
  const events = await fetchEvents(apiKey, sport);
  console.log(`Odds API returned ${events.length} events.`);

  const lines = { ...previous.lines };
  const flags = [];
  let priced = 0;

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

    const consensus = consensusFor(event, target.team);
    if (!consensus) {
      console.warn(`  no consensus spread for ${target.team} - keeping projection`);
      continue;
    }

    const winProb =
      consensus.moneyline !== null && consensus.opponentMoneyline !== null
        ? devig(consensus.moneyline, consensus.opponentMoneyline)
        : winProbFromSpread(consensus.spread);

    lines[target.key] = {
      spread: Number(consensus.spread.toFixed(1)),
      source: "market",
      winProb: Number(winProb.toFixed(4)),
      book: "consensus",
    };
    priced += 1;

    console.log(
      `  ${target.team.padEnd(16)} ${consensus.spread > 0 ? "+" : ""}${consensus.spread}  ${(winProb * 100).toFixed(1)}%`,
    );

    if (target.isPick && consensus.spread > threshold) {
      flags.push({
        week,
        team: target.team,
        spread: Number(consensus.spread.toFixed(1)),
        message: `${target.team} is only ${Math.abs(consensus.spread).toFixed(1)} points. Consider a backup.`,
      });
    }
  }

  return { lines, flags, count: priced, total: targets.length };
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
