/**
 * Playoff games, read off the market feed as they are announced.
 *
 * A regular season is on schedule.json from the spring. A playoff round cannot
 * be: who plays in it is decided by the round before, so its games are known
 * a few days ahead at most. The books post them within hours of the bracket
 * being set, though, and the feed this job already reads every day is where
 * they appear. So each run looks through the feed's events for games between
 * two of the league's teams kicking off in a playoff week's window, and keeps
 * what it finds in odds.json under `playoffs.games`, by week - where the board
 * and this job's own pricing, results and refit read them back as schedule
 * (withPlayoffGames in core/plan.js).
 *
 * Found once, kept: a game already found stays found, so a round whose games
 * have kicked off and dropped out of the feed is still on the schedule its
 * results are placed against. A week's list is only ever added to, never
 * reordered, and never past the number of games the round has.
 */

import { teamKey } from "./odds-api.mjs";

const DAY_MS = 24 * 3600 * 1000;

/**
 * How far from a playoff week's listed date a game may kick off and still be
 * that week's - the window finalsPlacer places results with. A Saturday and a
 * Monday on either side of the Sunday the date names.
 */
const WINDOW_MS = 4 * DAY_MS;

/** How many games each round has: twelve teams, eight, four, two. */
const GAMES_IN = Object.freeze({ wildcard: 6, divisional: 4, conference: 2, superbowl: 1 });

/**
 * The playoff games the feed has announced, merged into the ones already kept.
 *
 * @param {object} args
 * @param {object} args.plan The calendar: playoff weeks carry `round`.
 * @param {Array<object>} args.events Feed events, odds or scores: each with
 *   `home_team`, `away_team` and `commence_time`.
 * @param {(name:string) => string|null} args.resolve The league's spelling of
 *   a feed name (teamResolver).
 * @param {(team:string) => boolean} args.isEligible
 * @param {Object<string,Array<{home:string, away:string}>>} [args.known] What
 *   earlier runs found, by week.
 * @returns {{games:Object<string,Array<{home:string, away:string, neutral?:boolean}>>,
 *            found:Array<{week:number, home:string, away:string}>}} Every game
 *   by week, and the ones this call added.
 */
export function findPlayoffGames({ plan, events, resolve, isEligible, known = {} }) {
  const rounds = (plan.weeks ?? []).filter((week) => GAMES_IN[week.round]);
  const games = Object.fromEntries(
    Object.entries(known ?? {}).map(([week, list]) => [week, [...(list ?? [])]]),
  );
  const found = [];
  if (rounds.length === 0) return { games, found };

  // Nothing the regular season could still be playing counts: a game after
  // the last regular week's window is a playoff game or nothing.
  const lastRegular = Math.max(
    ...(plan.weeks ?? [])
      .filter((week) => !week.round)
      .map((week) => Date.parse(`${week.kickoff}T00:00:00Z`)),
  );
  const listed = rounds.map((week) => ({
    week: week.week,
    round: week.round,
    at: Date.parse(`${week.kickoff}T00:00:00Z`),
  }));

  for (const event of events ?? []) {
    const kickoff = Date.parse(event?.commence_time ?? "");
    if (!Number.isFinite(kickoff) || kickoff <= lastRegular + WINDOW_MS / 2) continue;
    const home = resolve(event.home_team);
    const away = resolve(event.away_team);
    if (!home || !away || home === away || !isEligible(home) || !isEligible(away)) continue;

    // The round whose date is nearest, if it is near enough.
    let round = null;
    for (const entry of listed) {
      const gap = Math.abs(kickoff - entry.at);
      if (gap <= WINDOW_MS && (!round || gap < round.gap)) round = { ...entry, gap };
    }
    if (!round) continue;

    const key = String(round.week);
    const list = games[key] ?? [];
    const pair = [teamKey(home), teamKey(away)].sort().join("|");
    if (list.some((game) => [teamKey(game.home), teamKey(game.away)].sort().join("|") === pair)) {
      continue;
    }
    // A team plays once a round, and a round has only so many games. Anything
    // past either is not this round's game, whatever its date says.
    if (
      list.some((game) => [game.home, game.away].some((team) => team === home || team === away))
    ) {
      continue;
    }
    if (list.length >= GAMES_IN[round.round]) continue;

    list.push({ home, away, ...(round.round === "superbowl" ? { neutral: true } : {}) });
    games[key] = list;
    found.push({ week: round.week, home, away });
  }
  return { games, found };
}
