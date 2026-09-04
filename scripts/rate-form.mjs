#!/usr/bin/env node
/**
 * Refit data/<league>/form.json from the pulls already on disk.
 *
 *   npm run rate            both leagues
 *   npm run rate -- cfb     one
 *   npm run rate -- --dry   fit and report, write nothing
 *
 * The daily refresh does this itself, at the end of every run. This is the
 * same fit with no API call behind it, which makes it the way to see what the
 * numbers are doing, to rebuild the file after a hand-edit to odds.json, and
 * to bring a league that has never been fitted up to date.
 *
 * It reads odds.json and writes form.json, so it spends no quota and cannot
 * touch anything a human owns.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { fitForm, marketError } from "./lib/rate.mjs";
import { LEAGUE_IDS, LEAGUES } from "../src/js/leagues.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const named = args.filter((arg) => !arg.startsWith("--"));
const leagues = named.length ? named : LEAGUE_IDS;

let failed = false;

for (const league of leagues) {
  if (!LEAGUES[league]) {
    console.error(`Unknown league "${league}".`);
    failed = true;
    continue;
  }
  try {
    await rate(league);
  } catch (error) {
    failed = true;
    console.error(`${league} fit failed: ${error.message}`);
  }
}

if (failed) process.exit(1);

async function rate(league) {
  const read = async (name) => JSON.parse(await readFile(join(ROOT, "data", league, name), "utf8"));
  const [odds, ratings, schedule] = await Promise.all([
    read("odds.json"),
    read("ratings.json"),
    read("schedule.json"),
  ]);

  const form = fitForm({
    schedule,
    lines: odds.lines,
    scores: odds.scores,
    base: ratings.ratings,
    homeFieldPoints: ratings.homeFieldPoints,
    throughWeek: odds.currentWeek ?? 1,
  });

  console.log(`\n=== ${LEAGUES[league].label} ===`);
  if (!form) {
    console.log("Nothing pulled yet, so nothing to fit. Leaving form.json alone.");
    return;
  }

  const before = marketError({
    schedule,
    lines: odds.lines,
    base: ratings.ratings,
    homeFieldPoints: ratings.homeFieldPoints,
  });
  const after = marketError({
    schedule,
    lines: odds.lines,
    base: ratings.ratings,
    overlay: form.ratings,
    homeFieldPoints: ratings.homeFieldPoints,
  });

  console.log(
    `Fitted ${form.fit.teams} teams from ${form.fit.marketLines} market line(s) and ` +
      `${form.fit.margins} margin(s) through week ${form.throughWeek} (${form.fit.passes} passes).`,
  );
  if (before && after) {
    console.log(
      `Explains the lines we have to ${after.mae} pts, against ${before.mae} for the ` +
        `ratings the league shipped with (${after.count} game(s)).`,
    );
  }

  const moves = Object.entries(form.ratings)
    .map(([team, rating]) => ({ team, rating, from: ratings.ratings[team] }))
    .sort((a, b) => Math.abs(b.rating - b.from) - Math.abs(a.rating - a.from));

  for (const move of moves.slice(0, 8)) {
    const delta = move.rating - move.from;
    console.log(
      `  ${move.team.padEnd(18)} ${move.from.toFixed(1).padStart(6)} -> ` +
        `${move.rating.toFixed(1).padStart(6)}  (${delta > 0 ? "+" : ""}${delta.toFixed(1)}, ` +
        `${form.observations[move.team]} obs)`,
    );
  }

  if (dry) {
    console.log("Dry run: form.json not written.");
    return;
  }

  await writeFile(
    join(ROOT, "data", league, "form.json"),
    `${JSON.stringify(form, null, 2)}\n`,
    "utf8",
  );
  console.log("Wrote form.json.");
}
