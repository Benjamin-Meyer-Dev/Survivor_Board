#!/usr/bin/env node
/**
 * Author a league's plan.json from its schedule and ratings.
 *
 * The college plan was written by hand and then improved on; the NFL plan has
 * no hand-authored ancestor, so it is seeded straight from the optimiser. Run
 * once to create the file, and again only for a deliberate re-plan: the refresh
 * workflow never touches plan.json.
 *
 * Usage: node scripts/seed-plan.mjs nfl
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { LEAGUES } from "../src/js/leagues.js";
import { recommendPath } from "../src/js/core/recommend.js";
import { winProbFromSpread, projectSpread, resolveModel } from "../src/js/core/probability.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const league = process.argv[2];
const config = LEAGUES[league];
if (!config) {
  console.error(`Unknown league "${league}". Known: ${Object.keys(LEAGUES).join(", ")}`);
  process.exit(1);
}

const read = async (name) => JSON.parse(await readFile(join(ROOT, "data", league, name), "utf8"));

const [schedule, ratings, teams, calibration] = await Promise.all([
  read("schedule.json"),
  read("ratings.json"),
  read("teams.json"),
  read("calibration.json").catch(() => null),
]);
const model = resolveModel(calibration);

const roster = {};
for (const [conference, group] of Object.entries(teams.conferences)) {
  for (const [team, rating] of Object.entries(group)) roster[team] = { rating, conference };
}

const home = ratings.homeFieldPoints ?? 2.5;

/**
 * Every legal pick in a week, priced off the power ratings. A preseason plan
 * projects every week, so every week carries its horizon: week 1 is a week
 * out, week 13 thirteen.
 */
function optionsFor(week) {
  const out = [];

  for (const game of schedule.weeks[String(week)] ?? []) {
    for (const [team, opponent] of [
      [game.home, game.away],
      [game.away, game.home],
    ]) {
      if (!(team in roster)) continue;
      if (!(opponent in ratings.ratings)) continue;

      const site = game.neutral ? "Neutral" : team === game.home ? "Home" : "Away";
      const spread = projectSpread(
        roster[team].rating,
        ratings.ratings[opponent],
        site === "Home",
        site === "Neutral" ? 0 : home,
      );

      out.push({
        team,
        opponent,
        site,
        spread,
        source: "projected",
        weeksAhead: week,
        winProb: winProbFromSpread(spread, model, { weeksAhead: week }),
      });
    }
  }

  return out.sort((a, b) => a.spread - b.spread);
}

const weekNumbers = Object.keys(schedule.weeks)
  .map(Number)
  .sort((a, b) => a - b);

const weeks = weekNumbers.map((week) => ({ week, options: optionsFor(week) }));

const result = recommendPath({
  weeks,
  burned: new Set(),
  picksPerWeek: config.rules.picksPerWeek,
  buyBackWeeks: config.rules.buyBackWeeks,
  buyBacks: config.rules.buyBacks,
  model,
});

const plan = {
  $comment: config.planComment,
  league,
  season: config.season,
  rules: { ...config.rules, weeks: weekNumbers.length },
  dangerThreshold: config.dangerThreshold,
  tiers: config.tiers,
  weeks: weeks.map(({ week, options }) => {
    const chosen = result.picks[week] ?? [];
    const picks = chosen.map((team) => {
      const option = options.find((o) => o.team === team);
      return {
        team,
        opponent: option.opponent,
        site: option.site,
        spread: Number(option.spread.toFixed(1)),
        source: "projected",
        rationale: rationale(option, week, config),
      };
    });

    // The next best team the path does not already spend, kept as a visible
    // fallback the way the college plan lists one.
    const backups = options
      .filter((option) => !Object.values(result.picks).flat().includes(option.team))
      .slice(0, 2)
      .map((option) => ({
        team: option.team,
        opponent: option.opponent,
        site: option.site,
        spread: Number(option.spread.toFixed(1)),
        source: "projected",
      }));

    return { week, ...dateFor(week, config), picks, backups };
  }),
};

await writeFile(join(ROOT, "data", league, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);

console.log(
  `Wrote data/${league}/plan.json: ${plan.weeks.length} weeks, ` +
    `${plan.weeks.reduce((n, w) => n + w.picks.length, 0)} picks, ` +
    `survival ${(result.pathProbability * 100).toFixed(2)}%`,
);

/** Week label and kickoff, counted forward from the season's first week. */
function dateFor(week, { firstKickoff }) {
  const date = new Date(`${firstKickoff}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + (week - 1) * 7);
  const kickoff = date.toISOString().slice(0, 10);
  const label = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return { label, kickoff };
}

function rationale(option, week, config) {
  const where = option.site === "Home" ? "at home" : option.site === "Neutral" ? "neutral" : "away";
  const line = `${option.spread.toFixed(1)} ${where} against ${option.opponent}`;
  if (config.rules.buyBackWeeks.includes(week)) {
    return `${line}. Week ${week} is covered by the buy back, so the path can afford this one.`;
  }
  return `${line}.`;
}
