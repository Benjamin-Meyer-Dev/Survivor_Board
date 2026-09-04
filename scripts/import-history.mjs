#!/usr/bin/env node
/**
 * Write data/<league>/history.json from the public archives.
 *
 *   npm run history -- nfl
 *   npm run history -- cfb
 *   npm run history -- cfb --from <dir>   read already-downloaded files from <dir>
 *
 * NFL comes from nflverse (one 2 MB CSV). College comes from cfbfastR-data: a
 * 7 MB gzip of per-book lines that unpacks to 140 MB, plus one schedule file
 * per season. Nothing here needs a key. The result is one compact record per
 * game (see scripts/lib/history.mjs) and is committed, so calibration and the
 * backtest run offline and in CI.
 *
 * Run it once a season, after the previous one has closed, and whenever the
 * archives are known to have back-filled something.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  nflGamesFromCsv,
  cfbScheduleFromCsv,
  cfbGamesFromSources,
  compactHistory,
  HISTORY_FIELDS,
} from "./lib/history.mjs";
import { nflEfficiencyFromCsv, NFLVERSE_STATS } from "./lib/stats.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SOURCES = {
  nfl: {
    games: "https://github.com/nflverse/nfldata/raw/master/data/games.csv",
    from: 2010,
  },
  cfb: {
    lines:
      "https://github.com/sportsdataverse/cfbfastR-data/raw/main/betting/csv/cfb_line_odds.csv.gz",
    schedule: (season) =>
      `https://github.com/sportsdataverse/cfbfastR-data/raw/main/schedules/csv/cfb_schedules_${season}.csv`,
    from: 2014,
  },
};

const args = process.argv.slice(2);
const league = args.find((arg) => !arg.startsWith("--"));
const fromIndex = args.indexOf("--from");
const localDir = fromIndex >= 0 ? args[fromIndex + 1] : null;
const thisSeason = new Date().getUTCFullYear();

if (!SOURCES[league]) {
  console.error(`Usage: node scripts/import-history.mjs <nfl|cfb> [--from <dir>]`);
  process.exit(1);
}

const games = league === "nfl" ? await importNfl() : await importCfb();
const document = {
  $comment:
    "Written by scripts/import-history.mjs from public archives (nflverse for the NFL, " +
    "cfbfastR-data for college). One record per regular-season game, as arrays in the " +
    "order `fields` gives. Spreads are the home team's, negative when it is favoured; " +
    "homeFair is the de-vigged moneyline probability of a home win; margin is home minus " +
    "away. Read by scripts/calibrate.mjs and scripts/backtest.mjs, never by the browser.",
  source: league === "nfl" ? SOURCES.nfl.games : SOURCES.cfb.lines,
  importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  seasons: [...new Set(games.map((game) => game.season))].sort((a, b) => a - b),
  fields: HISTORY_FIELDS,
  games: compactHistory(games),
};

const target = join(ROOT, "data", league, "history.json");
await writeFile(target, `${JSON.stringify(document)}\n`, "utf8");
console.log(
  `Wrote ${target}: ${games.length} games over ${document.seasons[0]}-${document.seasons.at(-1)}.`,
);

async function importNfl() {
  const csv = await text("games.csv", SOURCES.nfl.games);
  // The season under way has lines but no results yet; it is left out until
  // it is over, so the calibration never scores a game that has not been
  // played.
  const games = nflGamesFromCsv(csv, { from: SOURCES.nfl.from, to: thisSeason - 1 });

  // The efficiency margin of every game, from nflverse's weekly team file for
  // each season, so the weight of that layer can be tuned on history rather
  // than assumed. A season whose file cannot be read simply carries nulls.
  const seasons = [...new Set(games.map((game) => game.season))];
  for (const season of seasons) {
    let stats = null;
    try {
      stats = nflEfficiencyFromCsv(
        await text(`stats_team_week_${season}.csv`, NFLVERSE_STATS(season)),
        season,
      );
    } catch (error) {
      console.warn(`  ${season}: no efficiency numbers (${error.message})`);
      continue;
    }
    let attached = 0;
    for (const game of games) {
      if (game.season !== season) continue;
      const margin = stats[`${game.week}|${game.home}`]?.margin;
      if (Number.isFinite(margin)) {
        game.homeEfficiency = margin;
        attached += 1;
      }
    }
    console.log(`  ${season}: efficiency on ${attached} games`);
  }
  return games;
}

async function importCfb() {
  const schedule = new Map();
  for (let season = SOURCES.cfb.from; season < thisSeason; season += 1) {
    const csv = await text(`cfb_schedules_${season}.csv`, SOURCES.cfb.schedule(season));
    for (const [id, game] of cfbScheduleFromCsv(csv)) schedule.set(id, game);
    console.log(`  ${season}: ${schedule.size} FBS games so far`);
  }

  const linesPath = await linesFile();
  const result = await cfbGamesFromSources(linesPath, schedule, {
    from: SOURCES.cfb.from,
    to: thisSeason - 1,
  });
  console.log(
    `  joined ${result.joined} games with lines; ${result.unresolved} dropped because the sides could ` +
      `not be told apart; ${result.unmatched} descriptions matched no FBS game (FCS, mostly)`,
  );
  return result.games;
}

/**
 * A text file, from the local directory when one was given and holds it, else
 * downloaded.
 */
async function text(name, url) {
  if (localDir) {
    try {
      return await readFile(join(localDir, name), "utf8");
    } catch {
      // Not downloaded yet; fall through to the archive.
    }
  }
  console.log(`  fetching ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.text();
}

/** The per-book lines file, extracted to disk so it can be streamed. */
async function linesFile() {
  if (localDir) return join(localDir, "cfb_line_odds.csv");
  const dir = join(tmpdir(), "survivor-board-history");
  await mkdir(dir, { recursive: true });
  const target = join(dir, "cfb_line_odds.csv");
  console.log(`  fetching ${SOURCES.cfb.lines} (7 MB, unpacks to 140 MB)`);
  const response = await fetch(SOURCES.cfb.lines);
  if (!response.ok) throw new Error(`${SOURCES.cfb.lines}: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createGunzip(), createWriteStream(target));
  return target;
}
