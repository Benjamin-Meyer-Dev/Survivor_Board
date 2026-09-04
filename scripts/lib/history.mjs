/**
 * Historical games, for calibrating the model and backtesting the fit.
 *
 * The board only ever sees this season, and this season is a handful of weeks
 * of lines. What a -20 favourite actually wins, how far a rating projection
 * misses the closing line six weeks out, and how much a final margin should
 * move a rating are questions that take thousands of games to answer. Two
 * public archives have them:
 *
 *   NFL      nflverse's games.csv: every game since 1999 with the closing
 *            spread, total, both moneylines and the result. Moneylines are
 *            complete from 2010.
 *   College  cfbfastR-data: per-book closing (and opening) spreads, totals and
 *            moneylines by ESPN game id from 2013, joined to the schedule
 *            files for teams, sites, divisions and scores.
 *
 * Both are boiled down to one record per game and written to
 * data/<league>/history.json by scripts/import-history.mjs. The browser never
 * loads the file; scripts/calibrate.mjs and scripts/backtest.mjs do.
 *
 * Records are arrays, not objects, because the file is committed and twelve
 * thousand games of field names is most of a megabyte. `HISTORY_FIELDS` is the
 * schema, and `expandHistory` turns the arrays back into objects.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { devig, fairFromMoneylines, DEFAULT_MODEL } from "../../src/js/core/probability.js";

/**
 * One game, as stored. Spreads are from the home team's side and negative
 * when the home team is favoured, the same convention the board uses for a
 * pick. `homeFair` is the de-vigged moneyline probability of a home win, or
 * null when no book priced a two-sided moneyline. `margin` is home minus away.
 * `homeEfficiency` is the home side's offensive expected points added less
 * the away side's, from the league's statistics source, or null where the
 * league has none (see scripts/lib/stats.mjs).
 */
export const HISTORY_FIELDS = Object.freeze([
  "season",
  "week",
  "home",
  "away",
  "neutral",
  "spread",
  "total",
  "homeMoneyline",
  "awayMoneyline",
  "homeFair",
  "margin",
  "homeEfficiency",
]);

/** Arrays back into objects, for anything that reads history.json. */
export function expandHistory(document) {
  return (document?.games ?? []).map((row) =>
    Object.fromEntries(HISTORY_FIELDS.map((field, index) => [field, row[index]])),
  );
}

/** Objects into arrays, for writing. */
export function compactHistory(games) {
  return games.map((game) => HISTORY_FIELDS.map((field) => game[field] ?? null));
}

/**
 * nflverse abbreviations to the nicknames data/nfl/ uses. Relocated
 * franchises keep their nickname, which is what the rating history cares
 * about.
 */
export const NFL_TEAMS = Object.freeze({
  ARI: "Cardinals",
  ATL: "Falcons",
  BAL: "Ravens",
  BUF: "Bills",
  CAR: "Panthers",
  CHI: "Bears",
  CIN: "Bengals",
  CLE: "Browns",
  DAL: "Cowboys",
  DEN: "Broncos",
  DET: "Lions",
  GB: "Packers",
  HOU: "Texans",
  IND: "Colts",
  JAX: "Jaguars",
  KC: "Chiefs",
  LA: "Rams",
  LAR: "Rams",
  STL: "Rams",
  LAC: "Chargers",
  SD: "Chargers",
  LV: "Raiders",
  OAK: "Raiders",
  MIA: "Dolphins",
  MIN: "Vikings",
  NE: "Patriots",
  NO: "Saints",
  NYG: "Giants",
  NYJ: "Jets",
  PHI: "Eagles",
  PIT: "Steelers",
  SEA: "Seahawks",
  SF: "49ers",
  TB: "Buccaneers",
  TEN: "Titans",
  WAS: "Commanders",
});

/** Split one CSV line, honouring double quotes. */
export function parseCsvLine(line) {
  const out = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      out.push(field);
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  out.push(field);
  return out;
}

/** Number or null, for the empty and "NA" cells these files use. */
function num(value) {
  if (value === undefined || value === null || value === "" || value === "NA") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * NFL regular-season games from nflverse's games.csv.
 *
 * `spread_line` there is the home team's expected margin (positive when the
 * home team is favoured), so it is negated into the board's convention.
 *
 * @param {string} csv The file's text.
 * @param {{from?:number, to?:number}} range Seasons to keep, inclusive.
 */
export function nflGamesFromCsv(csv, { from = 2010, to = 2100 } = {}) {
  const lines = csv.split("\n");
  const header = parseCsvLine(lines[0]);
  const column = Object.fromEntries(header.map((name, index) => [name, index]));
  const games = [];

  for (const raw of lines.slice(1)) {
    if (!raw.trim()) continue;
    const cells = parseCsvLine(raw);
    const at = (name) => cells[column[name]];
    if (at("game_type") !== "REG") continue;
    const season = num(at("season"));
    if (season === null || season < from || season > to) continue;

    const spreadLine = num(at("spread_line"));
    const result = num(at("result"));
    if (spreadLine === null || result === null) continue;

    const home = NFL_TEAMS[at("home_team")];
    const away = NFL_TEAMS[at("away_team")];
    if (!home || !away) continue;

    const homeMoneyline = num(at("home_moneyline"));
    const awayMoneyline = num(at("away_moneyline"));
    const homeFair =
      homeMoneyline !== null && awayMoneyline !== null
        ? round(devig(homeMoneyline, awayMoneyline), 4)
        : null;

    games.push({
      season,
      week: num(at("week")),
      home,
      away,
      neutral: at("location") === "Neutral" ? 1 : 0,
      spread: -spreadLine,
      total: num(at("total_line")),
      homeMoneyline,
      awayMoneyline,
      homeFair,
      margin: result,
    });
  }

  return games;
}

/**
 * College schedules from cfbfastR-data's cfb_schedules_<season>.csv, keyed by
 * game id. Only completed FBS-versus-FBS regular-season games are kept: an FCS
 * opponent is never a legal pick in this pool and its lines are thin anyway.
 */
export function cfbScheduleFromCsv(csv) {
  const lines = csv.split("\n");
  const header = parseCsvLine(lines[0]);
  const column = Object.fromEntries(header.map((name, index) => [name, index]));
  const games = new Map();

  for (const raw of lines.slice(1)) {
    if (!raw.trim()) continue;
    const cells = parseCsvLine(raw);
    const at = (name) => cells[column[name]];
    if (at("season_type") !== "regular") continue;
    if (at("home_division") !== "fbs" || at("away_division") !== "fbs") continue;
    const homePoints = num(at("home_points"));
    const awayPoints = num(at("away_points"));
    if (homePoints === null || awayPoints === null) continue;

    games.set(String(at("game_id")), {
      season: num(at("season")),
      week: num(at("week")),
      home: at("home_team"),
      away: at("away_team"),
      neutral: at("neutral_site") === "TRUE" ? 1 : 0,
      margin: homePoints - awayPoints,
    });
  }

  return games;
}

/**
 * Names the per-book file uses in its game descriptions that the schedule
 * files spell differently. Anything not listed is expected to match as is;
 * the FCS names that make up most of the rest never join because their games
 * are not kept (see cfbScheduleFromCsv).
 */
export const CFB_ALIASES = Object.freeze({
  "Louisiana-Lafayette": "Louisiana",
  "Miami (FL)": "Miami",
  Hawaii: "Hawai'i",
  "Appalachian State": "App State",
  "Brigham Young": "BYU",
  Connecticut: "UConn",
  "Louisiana-Monroe": "UL Monroe",
  "San Jose State": "San José State",
  "Southern Methodist": "SMU",
  "North Carolina State": "NC State",
  "Central Florida": "UCF",
  "Southern California": "USC",
  "Louisiana State": "LSU",
  "Texas Christian": "TCU",
  "Alabama-Birmingham": "UAB",
  "Texas-San Antonio": "UTSA",
  "Texas-El Paso": "UTEP",
  "Nevada-Las Vegas": "UNLV",
  Mississippi: "Ole Miss",
  "Southern Mississippi": "Southern Miss",
  "Sam Houston State": "Sam Houston",
  "Middle Tennessee State": "Middle Tennessee",
  "Bowling Green State": "Bowling Green",
  UMass: "Massachusetts",
  FIU: "Florida International",
});

/** US states to their postal codes, for abbreviations like TXST and MSST. */
const POSTAL = Object.freeze({
  alabama: "al",
  arizona: "az",
  arkansas: "ar",
  california: "ca",
  colorado: "co",
  florida: "fl",
  georgia: "ga",
  idaho: "id",
  illinois: "il",
  indiana: "in",
  iowa: "ia",
  kansas: "ks",
  kentucky: "ky",
  louisiana: "la",
  michigan: "mi",
  minnesota: "mn",
  mississippi: "ms",
  missouri: "mo",
  montana: "mt",
  nevada: "nv",
  ohio: "oh",
  oklahoma: "ok",
  oregon: "or",
  pennsylvania: "pa",
  tennessee: "tn",
  texas: "tx",
  utah: "ut",
  virginia: "va",
  washington: "wa",
  wisconsin: "wi",
});

const letters = (value) => value.toLowerCase().replace(/[^a-z]/g, "");
const initials = (words) => words.map((word) => letters(word)[0] ?? "").join("");

/**
 * How well an abbreviation from the older seasons of the per-book file fits a
 * team name: 3 for a clear match, down to 0 for none. `abbreviationSides` uses
 * it on both of a game's teams, so the score only has to separate two names.
 */
export function abbreviationScore(abbr, name) {
  const a = abbr.toLowerCase();
  const n = letters(name);
  const words = name.split(/[\s-]+/).filter(Boolean);
  const init = initials(words);
  const variants = new Set([a, a.replace(/^u/, ""), a.replace(/u$/, "")]);
  let best = 0;

  for (const v of variants) {
    if (!v) continue;
    if (n.startsWith(v) || init === v) best = Math.max(best, 3);
    // "Texas State" as TXST, "Mississippi State" as MSST.
    if (v.endsWith("st") && /state$/i.test(name) && words.length >= 2) {
      const stem = v.slice(0, -2);
      const first = letters(words.slice(0, -1).join(" "));
      if (stem && (first.startsWith(stem) || POSTAL[first] === stem)) best = Math.max(best, 3);
    }
    // "Texas A&M" as TXAM, "Florida State" as FLST: postal code then the rest.
    if (words.length >= 2) {
      const postal = POSTAL[letters(words[0])];
      const rest = letters(words.slice(1).join(" "));
      if (postal && v.startsWith(postal) && v.length > postal.length) {
        const tail = v.slice(postal.length);
        if (rest.startsWith(tail) || initials(words.slice(1)) === tail) best = Math.max(best, 3);
      }
    }
    if (best < 2 && v.length >= 3 && n.includes(v)) best = 2;
    if (best < 1 && isSubsequence(v, n)) best = 1;
  }
  return best;
}

function isSubsequence(needle, haystack) {
  let i = 0;
  for (const char of haystack) if (char === needle[i]) i += 1;
  return i === needle.length;
}

/**
 * Which of a game's two abbreviations is the home team. Both assignments are
 * scored and the clearly better one wins; a tie is left unresolved rather than
 * guessed, since a spread on the wrong side is worse than no spread.
 *
 * @param {string[]} abbrs The distinct abbreviations seen for the game.
 * @param {string} home
 * @param {string} away
 * @returns {Map<string,"home"|"away">|null}
 */
export function abbreviationSides(abbrs, home, away) {
  if (abbrs.length !== 2) return null;
  const [first, second] = abbrs;
  const straight = abbreviationScore(first, home) + abbreviationScore(second, away);
  const crossed = abbreviationScore(first, away) + abbreviationScore(second, home);
  if (straight === crossed || Math.max(straight, crossed) === 0) return null;
  return straight > crossed
    ? new Map([
        [first, "home"],
        [second, "away"],
      ])
    : new Map([
        [first, "away"],
        [second, "home"],
      ]);
}

/**
 * College games with consensus closing lines, streamed out of cfbfastR-data's
 * per-book cfb_line_odds.csv (140 MB uncompressed, so it is read a line at a
 * time rather than loaded).
 *
 * Each book posts a spread for each side, a total as over and under, and a
 * moneyline for each side. The spread and total are medians across books; the
 * moneyline is de-vigged per book and averaged in log-odds space, exactly as
 * the live ingest does it (core/probability.js fairFromMoneylines), so the
 * calibration measures the number the board will actually use.
 *
 * Rows from 2020 on carry the ESPN game id and full team names. Earlier rows
 * often carry neither: the game is then found by its "Away@Home" description
 * (through CFB_ALIASES) and the sides by abbreviation (abbreviationSides). A
 * game whose sides cannot be told apart is dropped, and the counts of each
 * are returned so the import can say what it left out.
 *
 * @param {string} linesPath Path to the extracted CSV.
 * @param {Map<string, object>} schedule From cfbScheduleFromCsv, all seasons merged.
 * @param {{from?:number, to?:number}} range
 * @returns {Promise<{games:Array<object>, joined:number, unresolved:number, unmatched:number}>}
 */
export async function cfbGamesFromSources(linesPath, schedule, { from = 2014, to = 2100 } = {}) {
  const byDescription = new Map();
  for (const game of schedule.values()) {
    byDescription.set(`${game.season}|${game.away}@${game.home}`, game);
  }
  const canonical = (name) => CFB_ALIASES[name] ?? name;

  const collected = new Map();
  const unmatched = new Set();
  let column = null;

  const reader = createInterface({ input: createReadStream(linesPath), crlfDelay: Infinity });
  for await (const raw of reader) {
    if (!column) {
      column = Object.fromEntries(parseCsvLine(raw).map((name, index) => [name, index]));
      continue;
    }
    if (!raw) continue;
    const cells = parseCsvLine(raw);
    const at = (name) => cells[column[name]];
    const season = num(at("season"));
    if (season === null || season < from || season > to) continue;
    const market = at("market_type");
    if (market !== "spread" && market !== "total" && market !== "money_line") continue;

    const id = String(at("game_id") ?? "").replace(/\.0$/, "");
    const description = at("game_desc") ?? "";
    let game = schedule.get(id) ?? null;
    let gameKey = id;
    if (!game && description.includes("@")) {
      const [away, home] = description.split("@");
      gameKey = `${season}|${canonical(away)}@${canonical(home)}`;
      game = byDescription.get(gameKey) ?? null;
    }
    if (!game) {
      unmatched.add(`${season}|${description}`);
      continue;
    }

    let entry = collected.get(gameKey);
    if (!entry) {
      entry = { game, abbrs: new Set(), spreads: [], totals: [], moneylines: [] };
      collected.set(gameKey, entry);
    }

    const side = at("abbr");
    if (market === "spread") {
      const line = num(at("lines"));
      if (line === null) continue;
      entry.abbrs.add(side);
      entry.spreads.push({ side, line });
    } else if (market === "total") {
      const line = num(at("lines"));
      if (line !== null && side === "over") entry.totals.push(line);
    } else {
      const price = num(at("odds"));
      if (price === null) continue;
      entry.abbrs.add(side);
      entry.moneylines.push({ side, book: at("book"), price });
    }
  }

  const games = [];
  let unresolved = 0;
  for (const { game, abbrs, spreads, totals, moneylines } of collected.values()) {
    if (spreads.length === 0) continue;
    const sideOf = sidesFor([...abbrs], game);
    if (!sideOf) {
      unresolved += 1;
      continue;
    }

    const homeSpreads = [];
    for (const { side, line } of spreads) {
      const which = sideOf.get(side);
      if (which === "home") homeSpreads.push(line);
      else if (which === "away") homeSpreads.push(-line);
    }
    if (homeSpreads.length === 0) continue;

    const books = new Map();
    for (const { side, book, price } of moneylines) {
      const which = sideOf.get(side);
      if (!which) continue;
      if (!books.has(book)) books.set(book, {});
      books.get(book)[which === "home" ? "team" : "opponent"] = price;
    }
    const pairs = [...books.values()];
    const fair = fairFromMoneylines(pairs, { ...DEFAULT_MODEL, moneylineCap: 100000 });

    games.push({
      ...game,
      spread: median(homeSpreads),
      total: totals.length ? median(totals) : null,
      homeMoneyline: medianOf(pairs.map((pair) => pair.team)),
      awayMoneyline: medianOf(pairs.map((pair) => pair.opponent)),
      homeFair: fair.probability === null ? null : round(fair.probability, 4),
    });
  }

  games.sort((a, b) => a.season - b.season || a.week - b.week || a.home.localeCompare(b.home));
  return { games, joined: collected.size, unresolved, unmatched: unmatched.size };
}

/** Which side each name or abbreviation in a game's rows refers to. */
function sidesFor(abbrs, game) {
  const named = new Map();
  const canonical = (name) => CFB_ALIASES[name] ?? name;
  for (const abbr of abbrs) {
    const name = canonical(abbr);
    if (name === game.home) named.set(abbr, "home");
    else if (name === game.away) named.set(abbr, "away");
  }
  if (named.size === abbrs.length) return named;
  if (named.size > 0) return null;
  return abbreviationSides(abbrs, game.home, game.away);
}

function medianOf(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length ? median(finite) : null;
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(value, places) {
  return Number(value.toFixed(places));
}
