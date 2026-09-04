#!/usr/bin/env node
/**
 * Calibrate a league's probability model and rating fit against its history.
 *
 *   npm run calibrate                 report for both leagues, write nothing
 *   npm run calibrate -- nfl --write  fit the NFL and write data/nfl/calibration.json
 *   npm run calibrate -- --no-tune    skip the walk-forward rating tuning (slow part)
 *
 * Reads data/<league>/history.json (see scripts/import-history.mjs) and
 * ratings.json for the home-field value. What it writes is what the board and
 * the refresh job turn spreads into probabilities with, so the report is the
 * thing to read before writing: the bands table says whether favourites of
 * each strength came through as often as the model said they would, and the
 * horizon table says how far a projection misses by weeks ahead.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { calibrate } from "./lib/calibrate.mjs";
import { expandHistory } from "./lib/history.mjs";
import { marketError } from "./lib/rate.mjs";
import { LEAGUE_IDS, LEAGUES } from "../src/js/leagues.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const write = args.includes("--write");
const tune = !args.includes("--no-tune");
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
    await run(league);
  } catch (error) {
    failed = true;
    console.error(`${league} calibration failed: ${error.message}`);
  }
}
if (failed) process.exit(1);

async function run(league) {
  const read = async (name) => JSON.parse(await readFile(join(ROOT, "data", league, name), "utf8"));
  const [history, ratings] = await Promise.all([read("history.json"), read("ratings.json")]);
  const games = expandHistory(history);
  const homeFieldPoints = ratings.homeFieldPoints ?? 2.5;

  console.log(`\n=== ${LEAGUES[league].label} ===`);
  const started = Date.now();
  // How far the ratings the league shipped with missed the first week the
  // market priced. That is what the anchor is scaled to: the history's own
  // prior is last season regressed, and the live one is a published rating.
  const live = await livePrior(league, ratings);
  if (live) {
    console.log(
      `  shipped ratings missed week ${live.week}'s lines by ${live.mae} pts over ${live.count} games`,
    );
  } else {
    console.log("  no market week on disk yet; the anchor keeps the history's scale");
  }

  const result = calibrate(games, {
    homeFieldPoints,
    tune,
    livePriorMae: live?.mae ?? null,
    log: (message) => console.log(`  ${message}`),
  });
  console.log(`  done in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const { report } = result;
  console.log(
    `\nMargin model: sigma ${result.margin.sigma} + ${result.margin.slope} per point of spread` +
      (result.margin.totalSlope
        ? ` + ${result.margin.totalSlope} per point of total over ${result.margin.referenceTotal}`
        : "") +
      `\n  (margins alone said sigma ${report.margin.fromMargins.sigma}, slope ${report.margin.fromMargins.slope};` +
      ` the results moved it to ${report.margin.fromResults.sigma}, ${report.margin.fromResults.slope})`,
  );
  console.log(
    `Log loss: model ${report.spreadOnly.logLoss}, legacy curve ${report.legacyCurve.logLoss}; ` +
      `Brier ${report.spreadOnly.brier} vs ${report.legacyCurve.brier} (${report.games} games)`,
  );
  console.log(
    `Moneyline weight ${result.moneyline.weight}: log loss with it ${report.withMoneyline.logLoss} ` +
      `on ${report.withMoneyline.n} games with both`,
  );

  console.log("\nFavourites by predicted band:");
  console.log("  band          n   predicted   actual");
  for (const band of report.bands) {
    console.log(
      `  ${pct(band.low)}-${pct(band.high)}`.padEnd(15) +
        `${String(band.n).padStart(5)}   ${pct(band.predicted).padStart(6)}    ${pct(band.actual).padStart(6)}`,
    );
  }

  console.log(`\nProjection error by weeks ahead (rating fit ${JSON.stringify(result.rating)}):`);
  console.log("  h    n     mae    rmse");
  for (const row of report.horizon) {
    console.log(
      `  ${String(row.h).padEnd(3)} ${String(row.n).padStart(5)}  ${row.mae.toFixed(2).padStart(6)}  ${row.rmse.toFixed(2).padStart(6)}`,
    );
  }
  console.log(
    `  variance(h) = ${result.horizon.base}^2 + ${result.horizon.perWeek}^2 * h; ` +
      `team share ${result.horizon.teamShare}; +${result.horizon.unseen} per unseen side`,
  );
  if (report.ratingTuning.mae !== null) {
    console.log(
      `  tuned over ${report.ratingTuning.trials} trials to a one-week MAE of ${report.ratingTuning.mae}` +
        ` (${report.efficiencyGames} games carried efficiency margins)`,
    );
  }
  const { prior } = result;
  console.log(
    `\nPrior: history's missed week 1 by ${prior.historyMae} pts, anchor ${prior.anchorHistory} ` +
      `fading over ${prior.halfLifeHistory} weeks;` +
      (prior.liveMae !== null
        ? ` the shipped ratings miss by ${prior.liveMae} pts, so the board runs anchor ` +
          `${prior.anchorLive} fading over ${prior.halfLifeLive} weeks.`
        : " no live week to scale to."),
  );

  if (!write) {
    console.log("\nDry run: calibration.json not written. Pass --write to keep it.");
    return;
  }

  const document = {
    $comment:
      "Written by scripts/calibrate.mjs from data/" +
      league +
      "/history.json. How this league turns a spread into a win probability, how much its " +
      "moneylines count, how far a projected line misses by weeks ahead, and the weights its " +
      "rating fit runs with. Re-run `npm run calibrate -- " +
      league +
      " --write` after importing a new season; do not edit by hand.",
    fittedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    source: `history.json ${report.seasons[0]}-${report.seasons.at(-1)}, ${report.games} games`,
    margin: result.margin,
    moneyline: result.moneyline,
    horizon: result.horizon,
    rating: result.rating,
    prior: result.prior,
    report: {
      spreadOnly: report.spreadOnly,
      withMoneyline: report.withMoneyline,
      legacyCurve: report.legacyCurve,
      bands: report.bands,
      horizon: report.horizon,
      ratingTuning: report.ratingTuning,
    },
  };
  const target = join(ROOT, "data", league, "calibration.json");
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${target}.`);
}

/**
 * The shipped ratings against the first week the market has priced, from
 * odds.json and schedule.json. Null when no week has been priced.
 */
async function livePrior(league, ratings) {
  const read = async (name) => JSON.parse(await readFile(join(ROOT, "data", league, name), "utf8"));
  const [odds, schedule] = await Promise.all([read("odds.json"), read("schedule.json")]);
  const weeks = Object.entries(odds.lines ?? {})
    .filter(([, line]) => line?.source === "market")
    .map(([key]) => Number(key.split("|")[0]));
  if (weeks.length === 0) return null;
  const week = Math.min(...weeks);
  const lines = Object.fromEntries(
    Object.entries(odds.lines).filter(([key]) => Number(key.split("|")[0]) === week),
  );
  const error = marketError({
    schedule,
    lines,
    base: ratings.ratings,
    homeFieldPoints: ratings.homeFieldPoints ?? 2.5,
  });
  return error ? { week, mae: error.mae, count: error.count } : null;
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}
