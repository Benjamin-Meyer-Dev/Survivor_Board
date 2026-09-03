#!/usr/bin/env node
/**
 * Rewrite data/<league>/odds.json with current market lines for the week ahead.
 *
 * Run by .github/workflows/refresh-odds.yml every six hours. Also runnable
 * locally: ODDS_API_KEY=... npm run refresh
 *
 * Both leagues are refreshed in one run. They share nothing but this script:
 * separate sport keys, separate data folders, separate freshness guards, and a
 * failure in one never stops the other.
 *
 * It prices every legal option for the upcoming week, sets currentWeek, flags
 * any pick that has fallen under the danger threshold, and re-runs the
 * recommendation over the remaining weeks with the new numbers. New odds in an
 * early week can change what the right pick is in week 11, so the whole
 * remaining path is recomputed, not just this week.
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
  sameTeam,
  SPORT_KEYS,
} from "./lib/odds-api.mjs";
import { currentWeekFor } from "./lib/weeks.mjs";
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
  let failures = 0;

  for (const league of leagues) {
    if (!LEAGUES[league]) {
      console.error(`Unknown league "${league}".`);
      failures += 1;
      continue;
    }

    try {
      console.log(`\n=== ${LEAGUES[league].label} ===`);
      allFlags.push(...(await refreshLeague(league, apiKey)));
    } catch (error) {
      // One league's outage must not cost the other its refresh.
      failures += 1;
      console.error(`${LEAGUES[league].label} refresh failed: ${error.message}`);
    }
  }

  // Surface flags to the workflow so it can open an issue.
  if (process.env.GITHUB_OUTPUT) {
    const summary = allFlags.map((flag) => flag.message).join(" ");
    await writeFile(process.env.GITHUB_OUTPUT, `flagged=${allFlags.length}\nsummary=${summary}\n`, {
      flag: "a",
    });
  }

  if (failures === leagues.length) process.exit(1);
}

/** Refresh one league. Returns the flags it raised. */
async function refreshLeague(league, apiKey) {
  const oddsPath = pathFor(league, "odds.json");

  const plan = JSON.parse(await readFile(pathFor(league, "plan.json"), "utf8"));
  const previous = JSON.parse(await readFile(oddsPath, "utf8"));
  const schedule = JSON.parse(await readFile(pathFor(league, "schedule.json"), "utf8"));
  const ratings = JSON.parse(await readFile(pathFor(league, "ratings.json"), "utf8"));

  const week = currentWeekFor(plan);
  if (week === null) {
    console.log("Season is over. Leaving odds.json untouched.");
    return [];
  }

  // The manual button can queue several dispatches before the first finishes,
  // and `concurrency` in the workflow serialises rather than drops them. This
  // is the guard that actually holds, because it is the only one a browser
  // cannot skip: if the lines were pulled moments ago, do nothing and spend
  // no API quota.
  const sincePull = Date.now() - Date.parse(previous.updatedAt ?? 0);
  const minGap = Number(process.env.MIN_REFRESH_GAP_MS ?? 4 * 60 * 1000);
  if (Number.isFinite(sincePull) && sincePull >= 0 && sincePull < minGap) {
    console.log(
      `Lines are ${Math.round(sincePull / 1000)}s old, under the ${Math.round(minGap / 1000)}s ` +
        `minimum. Skipping so a burst of manual requests costs one API call, not five.`,
    );
    return [];
  }

  const weekPlan = plan.weeks.find((entry) => entry.week === week);
  const teams = JSON.parse(await readFile(pathFor(league, "teams.json"), "utf8"));
  const isEligible = (team) => Object.values(teams.conferences).some((roster) => team in roster);
  const threshold = plan.dangerThreshold ?? -10;
  const sport = SPORT_KEYS[league];

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

  // Re-run the optimiser on the old and new numbers to see whether the advice
  // actually moved. Runs with an empty entry - the shared locks live in the
  // browser's store, so this is the unconstrained recommendation.
  const boardArgs = { plan, teams, schedule, ratings, entry: { picks: {}, swaps: {} } };
  const before = buildBoard({ ...boardArgs, odds: previous }).recommendation;
  const after = buildBoard({
    ...boardArgs,
    odds: { ...previous, lines, currentWeek: week },
  }).recommendation;

  const changedWeeks = [];
  for (let w = week; w <= plan.weeks.length; w += 1) {
    const a = [...(before.picks[w] ?? [])].sort().join(" + ");
    const b = [...(after.picks[w] ?? [])].sort().join(" + ");
    if (a !== b) changedWeeks.push({ week: w, from: a, to: b });
  }

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
  }
  console.log(
    `Path odds: ${(before.pathProbability * 100).toFixed(2)}% -> ${(after.pathProbability * 100).toFixed(2)}%`,
  );

  // Final scores. Recorded against the schedule so the board can mark picks
  // won or lost on its own, which is what keeps season survival honest without
  // anyone tapping a button.
  const results = { ...(previous.results ?? {}) };
  let recorded = 0;

  try {
    const scored = await fetchScores(apiKey, sport, 3);
    for (const event of scored) {
      const outcome = winnerOf(event);
      if (!outcome) continue;

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
          const value = sameTeam(team, outcome.winner) ? "W" : "L";
          if (results[key] !== value) recorded += 1;
          results[key] = value;
        }
        break;
      }
    }
    console.log(`Recorded ${recorded} new result(s) from ${scored.length} scored event(s).`);
  } catch (error) {
    // Scores are a bonus; never fail the run over them.
    console.warn(`Could not read scores: ${error.message}`);
  }

  const next = {
    $comment: previous.$comment,
    updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    currentWeek: week,
    lines,
    results,
    flags,
    recommendation: {
      picks: after.picks,
      pathProbability: Number(after.pathProbability.toFixed(6)),
    },
  };

  await writeFile(oddsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.log(`Priced ${priced}/${targets.length} lines. ${flags.length} flag(s).`);

  // Prefixed so a flag in an issue says which pool it came from.
  return flags.map((flag) => ({
    ...flag,
    message: `[${LEAGUES[league].label}] ${flag.message}`,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
