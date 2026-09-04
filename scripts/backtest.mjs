#!/usr/bin/env node
/**
 * Score this season's board against what has happened.
 *
 *   npm run backtest             both leagues
 *   npm run backtest -- nfl      one
 *
 * Reads the snapshots the refresh job writes (data/<league>/snapshots/), the
 * results in odds.json and the stats and calibration files, and prints how the
 * probabilities, the projections, the rating fit and the coach's calls have
 * done so far. Early in a season most tables are short or empty and say so;
 * they fill in as the weeks are played. For the same questions asked of the
 * league's history rather than its present, see `npm run calibrate`.
 */

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { backtest } from "./lib/backtest.mjs";
import { LEAGUE_IDS, LEAGUES } from "../src/js/leagues.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const named = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const leagues = named.length ? named : LEAGUE_IDS;

let failed = false;
for (const league of leagues) {
  if (!LEAGUES[league]) {
    console.error(`Unknown league "${league}".`);
    failed = true;
    continue;
  }
  try {
    await report(league);
  } catch (error) {
    failed = true;
    console.error(`${league} backtest failed: ${error.message}`);
  }
}
if (failed) process.exit(1);

async function report(league) {
  const read = async (name) => JSON.parse(await readFile(join(ROOT, "data", league, name), "utf8"));
  const optional = (name) => read(name).catch(() => null);
  const [odds, schedule, ratings, stats, calibration] = await Promise.all([
    read("odds.json"),
    read("schedule.json"),
    read("ratings.json"),
    optional("stats.json"),
    optional("calibration.json"),
  ]);

  const dir = join(ROOT, "data", league, "snapshots");
  const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".json"));
  const snapshots = await Promise.all(
    names.map(async (name) => JSON.parse(await readFile(join(dir, name), "utf8"))),
  );
  // With no snapshot yet, the lines on disk stand in as one, so the report has
  // something to say from the first run.
  if (snapshots.length === 0 && odds.lines) {
    snapshots.push({ at: odds.updatedAt, week: odds.currentWeek, lines: odds.lines, form: null });
  }

  const result = backtest({ snapshots, odds, schedule, ratings, stats, calibration });

  console.log(`\n=== ${LEAGUES[league].label} === (${result.snapshots} snapshot(s))`);

  console.log(`\nWin probabilities on ${result.lines.n} decided line(s):`);
  if (result.lines.n === 0) {
    console.log("  nothing decided yet.");
  } else {
    const row = (label, scored) =>
      console.log(
        `  ${label.padEnd(22)} log loss ${fmt(scored.logLoss)}   Brier ${fmt(scored.brier)}   n ${scored.n}`,
      );
    row("closing, as shown", result.lines.closing);
    row("opening, as shown", result.lines.opening);
    row("spread only", result.lines.spreadOnly);
    row("moneyline only", result.lines.moneylineOnly);
    row("blend (recomputed)", result.lines.blend);
    row("legacy curve", result.lines.legacy);
    console.log("  by band (closing):  band          n   predicted   actual");
    for (const band of result.lines.closing.bands) {
      console.log(
        `                      ${pct(band.low)}-${pct(band.high)}`.padEnd(37) +
          `${String(band.n).padStart(4)}   ${pct(band.predicted).padStart(6)}    ${pct(band.actual).padStart(6)}`,
      );
    }
  }

  console.log("\nProjections against the closing line, by weeks ahead:");
  if (result.projections.length === 0) {
    console.log("  no week has both a projection and a closing line yet.");
  } else {
    console.log("  h    n     mae    rmse   promised rmse");
    for (const row of result.projections) {
      console.log(
        `  ${String(row.h).padEnd(3)} ${String(row.n).padStart(4)}  ${row.mae.toFixed(2).padStart(6)}  ${row.rmse.toFixed(2).padStart(6)}   ${row.promised.toFixed(2).padStart(6)}`,
      );
    }
  }

  console.log("\nRating fit, week held out (MAE against that week's lines):");
  if (result.fit.length === 0) {
    console.log("  needs two weeks of lines.");
  } else {
    console.log("  week   n   shipped     fit   no margins   no efficiency");
    for (const row of result.fit) {
      console.log(
        `  ${String(row.week).padEnd(5)} ${String(row.n).padStart(3)}   ${fmt(row.shipped).padStart(7)} ${fmt(row.fit).padStart(7)}      ${fmt(row.noMargins).padStart(7)}         ${fmt(row.noEfficiency).padStart(7)}`,
      );
    }
  }

  console.log("\nThe coach's calls:");
  if (result.coach.length === 0) {
    console.log("  none recorded yet.");
  } else {
    for (const row of result.coach) {
      console.log(
        `  week ${String(row.week).padEnd(3)} ${row.teams.join(" + ").padEnd(34)} ` +
          `${row.weekWinProb !== null ? pct(row.weekWinProb).padStart(6) : "      "}  ${row.outcome ?? "pending"}`,
      );
    }
  }
}

function fmt(value) {
  return value === null || value === undefined ? "  -  " : value.toFixed(4);
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}
