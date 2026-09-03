#!/usr/bin/env node
/**
 * Plan invariants. Runs in CI so a bad edit to a plan.json cannot ship.
 *
 * Every league is checked, against the rules its own plan declares:
 *   1. the declared number of picks per week, over the declared number of weeks
 *   2. no team used twice across the season
 *   3. every pick is from an eligible conference
 *   4. every pick is a real game that week, at the site the plan claims
 *   5. every backup is a real, eligible team not already spent that week
 *   6. buy back weeks are weeks the season actually has
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CONFIG } from "../src/js/config.js";
import { buildBoard } from "../src/js/core/plan.js";
import { LEAGUE_IDS, LEAGUES } from "../src/js/leagues.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failed = false;

for (const league of LEAGUE_IDS) {
  const failures = await validate(league);

  if (failures.length) {
    failed = true;
    console.error(`\n${LEAGUES[league].label} plan validation failed:\n`);
    for (const failure of failures) console.error(`  - ${failure}`);
  }
}

if (failed) process.exit(1);

async function validate(league) {
  const read = async (name) => JSON.parse(await readFile(join(ROOT, "data", league, name), "utf8"));

  const [plan, teams, odds, schedule, ratings] = await Promise.all([
    read("plan.json"),
    read("teams.json"),
    read("odds.json"),
    read("schedule.json"),
    read("ratings.json"),
  ]);

  const eligible = new Set(
    Object.values(teams.conferences).flatMap((roster) => Object.keys(roster)),
  );
  const scale = teams.ratingSource ?? "power";
  const failures = [];

  if (plan.weeks.length !== plan.rules.weeks) {
    failures.push(`expected ${plan.rules.weeks} weeks, found ${plan.weeks.length}`);
  }

  // A buy back on a week the season does not have would silently never apply.
  const weekNumbers = new Set(plan.weeks.map((week) => week.week));
  for (const week of plan.rules.buyBackWeeks ?? []) {
    if (!weekNumbers.has(week))
      failures.push(`buy back names week ${week}, which is not in the plan`);
  }
  if ((plan.rules.buyBacks ?? 0) > (plan.rules.buyBackWeeks ?? []).length) {
    failures.push(
      `${plan.rules.buyBacks} buy backs over only ${(plan.rules.buyBackWeeks ?? []).length} forgiving weeks`,
    );
  }

  const spent = new Map();

  for (const week of plan.weeks) {
    if (week.picks.length !== plan.rules.picksPerWeek) {
      failures.push(
        `week ${week.week}: expected ${plan.rules.picksPerWeek} picks, found ${week.picks.length}`,
      );
    }

    for (const pick of week.picks) {
      if (!eligible.has(pick.team)) {
        failures.push(`week ${week.week}: "${pick.team}" is not in an eligible conference`);
      }
      if (spent.has(pick.team)) {
        failures.push(
          `week ${week.week}: "${pick.team}" already used in week ${spent.get(pick.team)}`,
        );
      }
      spent.set(pick.team, week.week);

      if (pick.spread >= 0) {
        failures.push(`week ${week.week}: "${pick.team}" is not favoured (${pick.spread})`);
      }
    }

    for (const backup of week.backups ?? []) {
      if (!eligible.has(backup.team)) {
        failures.push(
          `week ${week.week}: backup "${backup.team}" is not in an eligible conference`,
        );
      }
      if (week.picks.some((pick) => pick.team === backup.team)) {
        failures.push(
          `week ${week.week}: backup "${backup.team}" duplicates a pick in the same week`,
        );
      }
    }
  }

  // Every plan pick must be a game that actually exists that week, against a
  // rated opponent. This is the check that would catch a hand-edited plan
  // naming a matchup that is not on the schedule.
  for (const week of plan.weeks) {
    const games = schedule.weeks[String(week.week)] ?? [];
    if (games.length === 0) {
      failures.push(`week ${week.week}: no games in schedule.json`);
      continue;
    }

    for (const pick of week.picks) {
      const game = games.find(
        (g) =>
          (g.home === pick.team && g.away === pick.opponent) ||
          (g.away === pick.team && g.home === pick.opponent),
      );
      if (!game) {
        failures.push(
          `week ${week.week}: "${pick.team} vs ${pick.opponent}" is not in schedule.json`,
        );
        continue;
      }
      if (!(pick.opponent in ratings.ratings)) {
        failures.push(`week ${week.week}: "${pick.opponent}" has no rating - not a legal opponent`);
      }
      const expected = game.neutral ? "Neutral" : game.home === pick.team ? "Home" : "Away";
      if (pick.site !== expected) {
        failures.push(
          `week ${week.week}: "${pick.team}" is listed ${pick.site} but the schedule says ${expected}`,
        );
      }
    }
  }

  // Every eligible team must have a rating, or its projected spread would
  // silently fall back to nothing.
  const rated = new Set(Object.keys(ratings.ratings));
  for (const team of eligible) {
    if (!rated.has(team)) failures.push(`"${team}" is eligible but has no ${scale} rating`);
  }

  // A matchup between two eligible teams creates two legal choices: either
  // side can be selected. Check the derived list the UI receives, not merely
  // the source schedule, so dropping one direction cannot pass validation.
  const board = buildBoard({
    plan,
    odds,
    teams,
    schedule,
    ratings,
    entry: { picks: {}, swaps: {} },
    refreshSchedule: CONFIG.refresh,
  });
  for (const week of board.weeks) {
    const choices = new Set(
      (week.picks[0]?.options ?? []).map((option) => `${option.team}\u0000${option.opponent}`),
    );
    for (const game of schedule.weeks[String(week.week)] ?? []) {
      if (!eligible.has(game.home) || !eligible.has(game.away)) continue;
      if (!choices.has(`${game.home}\u0000${game.away}`)) {
        failures.push(`week ${week.week}: selectable list is missing ${game.home} vs ${game.away}`);
      }
      if (!choices.has(`${game.away}\u0000${game.home}`)) {
        failures.push(`week ${week.week}: selectable list is missing ${game.away} vs ${game.home}`);
      }
    }
  }

  const totalPicks = plan.weeks.reduce((sum, week) => sum + week.picks.length, 0);
  if (spent.size !== totalPicks) {
    failures.push(`${totalPicks} picks resolve to only ${spent.size} distinct teams`);
  }

  if (failures.length === 0) {
    console.log(
      `${LEAGUES[league].label} plan OK: ${plan.weeks.length} weeks, ` +
        `${spent.size} distinct teams, no repeats.`,
    );
  }

  return failures;
}
