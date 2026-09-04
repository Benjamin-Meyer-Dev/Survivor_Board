/**
 * Efficiency statistics, as one number per team per game.
 *
 * A final margin is the scoreboard; an efficiency margin is the same game read
 * through what each play was worth. The fumble that bounced the wrong way and
 * the punt returned for a score are in the first and not the second, which is
 * why a rating moves more reliably off the second. The rating fit takes it as
 * a third kind of observation (scripts/lib/rate.mjs), on the points scale, so
 * this module's whole job is to produce, for each game each team played,
 *
 *   margin  the team's offensive expected points added less its opponent's,
 *           which is how many points better the game says it was, luck aside
 *
 * plus enough of the parts to see where the number came from.
 *
 * Two sources, chosen by league:
 *
 *   nfl  nflverse's weekly team statistics, a public CSV per season that needs
 *        no key and updates during the week after the games. It carries
 *        passing and rushing EPA per team per game, which is the offence; the
 *        opponent's row is the defence.
 *   cfb  CollegeFootballData's game PPA (predicted points added) endpoint,
 *        which needs a free key in CFBD_API_KEY. Without the key the pull is
 *        skipped and the fit runs without this layer, which is a fact the file
 *        records rather than a failure.
 *
 * Every write records where the numbers came from and when. The refresh job
 * treats a failed pull as a delay, never as an error: the next day's run sees
 * the same games again.
 */

import { parseCsvLine, NFL_TEAMS } from "./history.mjs";

/** Where nflverse publishes each season's weekly team statistics. */
export const NFLVERSE_STATS = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${season}.csv`;

/** CollegeFootballData's per-game predicted points, by season and week. */
export const CFBD_PPA = (season, week) =>
  `https://api.collegefootballdata.com/ppa/games?year=${season}&week=${week}&seasonType=regular`;

/**
 * An efficiency margin is capped the way a scoreboard margin is: a game that
 * was over at half says nothing more once it is over.
 */
const MARGIN_CAP = 35;

/**
 * nflverse weekly team statistics into per-game efficiency records.
 *
 * Each row is one team's game. Offensive EPA is passing plus rushing; the
 * opponent's offensive EPA, from the opponent's own row for the same game,
 * is the defence conceded. Their difference is the margin.
 *
 * @param {string} csv The season file's text.
 * @param {number} season
 * @returns {Object<string, object>} Keyed "<week>|<team>", team names as
 *   data/nfl/ spells them.
 */
export function nflEfficiencyFromCsv(csv, season) {
  const lines = csv.split("\n");
  const header = parseCsvLine(lines[0]);
  const column = Object.fromEntries(header.map((name, index) => [name, index]));
  const rows = new Map();

  for (const raw of lines.slice(1)) {
    if (!raw.trim()) continue;
    const cells = parseCsvLine(raw);
    const at = (name) => cells[column[name]];
    if (Number(at("season")) !== season || at("season_type") !== "REG") continue;
    const team = NFL_TEAMS[at("team")];
    const opponent = NFL_TEAMS[at("opponent_team")];
    if (!team || !opponent) continue;
    const passing = Number(at("passing_epa"));
    const rushing = Number(at("rushing_epa"));
    if (!Number.isFinite(passing) || !Number.isFinite(rushing)) continue;
    const plays =
      Number(at("attempts") || 0) + Number(at("carries") || 0) + Number(at("sacks_suffered") || 0);
    rows.set(`${Number(at("week"))}|${team}`, {
      opponent,
      week: Number(at("week")),
      offense: passing + rushing,
      passing,
      rushing,
      plays,
      cpoe: Number.isFinite(Number(at("passing_cpoe"))) ? Number(at("passing_cpoe")) : null,
    });
  }

  const games = {};
  for (const [key, row] of rows) {
    const theirs = rows.get(`${row.week}|${row.opponent}`);
    if (!theirs) continue;
    const margin = row.offense - theirs.offense;
    games[key] = {
      opponent: row.opponent,
      margin: round(Math.max(-MARGIN_CAP, Math.min(MARGIN_CAP, margin)), 2),
      offense: round(row.offense, 2),
      defense: round(-theirs.offense, 2),
      offensePerPlay: row.plays ? round(row.offense / row.plays, 3) : null,
      defensePerPlay: theirs.plays ? round(-theirs.offense / theirs.plays, 3) : null,
      passingEpa: round(row.passing, 2),
      rushingEpa: round(row.rushing, 2),
      cpoe: row.cpoe,
    };
  }
  return games;
}

/**
 * CollegeFootballData game PPA into the same records.
 *
 * The endpoint returns, per game, each team's offensive and defensive
 * predicted points per play. Per play, so it is scaled by a typical number
 * of plays to land on the points scale the fit uses; the games endpoint does
 * not carry play counts. Names are CFBD's, which match data/cfb/ for the
 * teams this pool prices.
 *
 * @param {Array<object>} payload The endpoint's JSON.
 * @param {number} week
 * @param {(name:string) => string} [nameOf] Maps CFBD names onto ours.
 */
export function cfbEfficiencyFromPpa(payload, week, nameOf = (name) => name) {
  const PLAYS = 70;
  const games = {};
  for (const game of payload ?? []) {
    const offense = Number(game?.offense?.overall);
    const defense = Number(game?.defense?.overall);
    if (!Number.isFinite(offense) || !Number.isFinite(defense)) continue;
    const team = nameOf(game.team);
    const opponent = nameOf(game.opponent);
    if (!team || !opponent) continue;
    // Offence is points per play gained, defence points per play allowed, so
    // the margin is their difference over a game's worth of plays.
    const margin = (offense - defense) * PLAYS;
    games[`${week}|${team}`] = {
      opponent,
      margin: round(Math.max(-MARGIN_CAP, Math.min(MARGIN_CAP, margin)), 2),
      offensePerPlay: round(offense, 3),
      defensePerPlay: round(-defense, 3),
      passingPerPlay: Number.isFinite(Number(game.offense?.passing))
        ? round(Number(game.offense.passing), 3)
        : null,
      rushingPerPlay: Number.isFinite(Number(game.offense?.rushing))
        ? round(Number(game.offense.rushing), 3)
        : null,
    };
  }
  return games;
}

/**
 * Pull this season's efficiency numbers for a league. Returns the document to
 * write to data/<league>/stats.json, or null when there is nothing to write
 * (no key, no file yet this season), with the reason.
 *
 * @param {object} args
 * @param {"nfl"|"cfb"} args.league
 * @param {number} args.season
 * @param {number[]} args.weeks Weeks played so far, for the college endpoint.
 * @param {object|null} args.previous The document on disk, kept where a pull
 *   returns less than it did before.
 * @param {(url:string, init?:object) => Promise<Response>} [args.fetchImpl]
 * @param {string} [args.cfbdKey]
 * @returns {Promise<{document:object|null, reason:string}>}
 */
export async function pullEfficiency({
  league,
  season,
  weeks = [],
  previous = null,
  fetchImpl = fetch,
  cfbdKey = process.env.CFBD_API_KEY,
}) {
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  if (league === "nfl") {
    const url = NFLVERSE_STATS(season);
    const response = await fetchImpl(url);
    if (response.status === 404) {
      return { document: null, reason: `nflverse has no ${season} weekly team file yet` };
    }
    if (!response.ok) throw new Error(`nflverse ${response.status} for ${url}`);
    const games = nflEfficiencyFromCsv(await response.text(), season);
    return {
      document: {
        $comment: comment("nflverse weekly team statistics"),
        updatedAt: stamp,
        source: url,
        season,
        games: { ...(previous?.games ?? {}), ...games },
      },
      reason: `${Object.keys(games).length} team-games from nflverse`,
    };
  }

  if (league === "cfb") {
    if (!cfbdKey) {
      return { document: null, reason: "CFBD_API_KEY is not set; the efficiency layer is off" };
    }
    const games = { ...(previous?.games ?? {}) };
    let pulled = 0;
    for (const week of weeks) {
      const url = CFBD_PPA(season, week);
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${cfbdKey}`, Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`CFBD ${response.status} for ${url}`);
      const fromWeek = cfbEfficiencyFromPpa(await response.json(), week);
      Object.assign(games, fromWeek);
      pulled += Object.keys(fromWeek).length;
    }
    return {
      document: {
        $comment: comment("CollegeFootballData game PPA"),
        updatedAt: stamp,
        source: "https://api.collegefootballdata.com/ppa/games",
        season,
        games,
      },
      reason: `${pulled} team-games from CFBD over ${weeks.length} week(s)`,
    };
  }

  return { document: null, reason: `no efficiency source for ${league}` };
}

function comment(source) {
  return (
    `Written by scripts/pull-stats.mjs from ${source}. Never edit by hand. One record per ` +
    'team per game, keyed "<week>|<team>" like odds.json: `margin` is the team\'s offensive ' +
    "expected points added less its opponent's, capped, and is what the rating fit in form.json " +
    "reads as an efficiency observation. The other fields say where it came from."
  );
}

function round(value, places) {
  return Number(value.toFixed(places));
}
