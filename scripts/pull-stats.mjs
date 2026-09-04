#!/usr/bin/env node
/**
 * Pull this season's efficiency statistics into data/<league>/stats.json.
 *
 *   npm run stats            both leagues
 *   npm run stats -- nfl     one
 *
 * The daily refresh does this itself, best effort, before it refits the
 * ratings. This is the same pull on its own, for bringing a league up to date
 * by hand or for seeing what the source has. NFL needs nothing; college needs
 * CFBD_API_KEY (a free key from collegefootballdata.com) and is skipped,
 * saying so, without it.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { pullEfficiency } from "./lib/stats.mjs";
import { LEAGUE_IDS, LEAGUES } from "../src/js/leagues.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Pull and write one league's stats.json. Returns what happened, for the
 * refresh log. Never throws for a missing key or a season the source has not
 * published; a network failure does throw, and the caller decides.
 *
 * @param {string} league
 * @param {{root?:string, fetchImpl?:Function}} options
 * @returns {Promise<{written:boolean, reason:string, document:object|null}>}
 */
export async function pullStatsForLeague(league, { root = ROOT, fetchImpl = fetch } = {}) {
  const read = async (name) => JSON.parse(await readFile(join(root, "data", league, name), "utf8"));
  const optional = (name) => read(name).catch(() => null);
  const [plan, odds, previous] = await Promise.all([
    read("plan.json"),
    read("odds.json"),
    optional("stats.json"),
  ]);

  // Every week with a result recorded has games to read.
  const weeks = [
    ...new Set(Object.keys(odds.results ?? {}).map((key) => Number(key.split("|")[0]))),
  ].sort((a, b) => a - b);

  const { document, reason } = await pullEfficiency({
    league,
    season: plan.season,
    weeks,
    previous,
    fetchImpl,
  });

  if (!document) return { written: false, reason, document: null };

  const path = join(root, "data", league, "stats.json");
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return { written: true, reason, document };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === join(process.cwd(), process.argv[1]);
const invokedByPath =
  process.argv[1] &&
  fileURLToPath(import.meta.url).replace(/\\/g, "/") === process.argv[1].replace(/\\/g, "/");

if (invokedDirectly || invokedByPath) {
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
      const result = await pullStatsForLeague(league);
      console.log(
        `${LEAGUES[league].label}: ${result.reason}${result.written ? " - wrote stats.json" : " - nothing written"}`,
      );
    } catch (error) {
      failed = true;
      console.error(`${LEAGUES[league].label} stats pull failed: ${error.message}`);
    }
  }
  if (failed) process.exit(1);
}
