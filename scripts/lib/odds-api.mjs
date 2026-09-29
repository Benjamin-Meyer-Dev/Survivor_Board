/**
 * Thin client for the-odds-api.com.
 *
 * Free tier is 500 credits a month, and a request costs one credit per market
 * per region: spreads, moneylines and totals from the US books is three, the
 * scores call one more. Two leagues once a day across the autumn is most of
 * the budget, and the freshness guard in refresh-odds.mjs is what keeps a burst
 * of manual refreshes from spending it. The key lives in the ODDS_API_KEY
 * repository secret and never reaches the browser.
 */

import { fairFromMoneylines, DEFAULT_MODEL } from "../../src/js/core/probability.js";

const BASE = "https://api.the-odds-api.com/v4";

/** The API's sport key for each of our leagues. */
export const SPORT_KEYS = Object.freeze({
  cfb: "americanfootball_ncaaf",
  nfl: "americanfootball_nfl",
});

/**
 * The markets a run asks for. Totals are the third credit: a game total
 * widens or narrows the margin's scatter a little, and the calibration decides
 * by how much (core/probability.js totalSlope). Set ODDS_MARKETS=spreads,h2h to
 * save the credit and price without them.
 */
export const MARKETS = (process.env.ODDS_MARKETS ?? "spreads,h2h,totals").split(",");

/**
 * A book whose market is older than this, against the freshest book on the
 * same game, is stale: it stopped updating and is quoting a line the others
 * have moved off. Twelve hours is generous for a daily pull.
 */
const STALE_MS = 12 * 3600 * 1000;

/**
 * Fetch current spreads, moneylines and totals for every upcoming game.
 *
 * @param {string} apiKey
 * @param {string} sport A value from SPORT_KEYS.
 * @returns {Promise<Array<object>>} Raw events.
 */
export async function fetchEvents(apiKey, sport) {
  const url = new URL(`${BASE}/sports/${sport}/odds`);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("regions", "us");
  url.searchParams.set("markets", MARKETS.join(","));
  url.searchParams.set("oddsFormat", "american");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Odds API ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

/**
 * Final scores for recently completed games.
 *
 * `daysFrom` is capped at 3 on the free tier, which comfortably covers a
 * Saturday slate read on the following Tuesday, and a Monday night game read
 * on the Wednesday. Costs the same quota as one odds call.
 *
 * @param {string} apiKey
 * @param {string} sport A value from SPORT_KEYS.
 * @param {number} daysFrom
 * @returns {Promise<Array<object>>}
 */
export async function fetchScores(apiKey, sport, daysFrom = 3) {
  const url = new URL(`${BASE}/sports/${sport}/scores`);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("daysFrom", String(daysFrom));

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Odds API scores ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

/**
 * Which side won a completed event, and by how much, or null when it is not
 * final or the payload is missing scores.
 *
 * The margin is what the rating fit reads (scripts/lib/rate.mjs); the board
 * only ever needs the winner. Free-tier scores look back three days, so a
 * margin not recorded within three days of kickoff is gone for good - which is
 * why the job stores it rather than deriving it later.
 *
 * @param {object} event
 * @returns {{winner:string, loser:string, margin:number}|null}
 */
export function winnerOf(event) {
  if (!event?.completed || !Array.isArray(event.scores) || event.scores.length < 2) return null;

  const [a, b] = event.scores.map((entry) => ({
    name: entry.name,
    score: Number(entry.score),
  }));
  if (!Number.isFinite(a.score) || !Number.isFinite(b.score)) return null;
  // Level after overtime. Rare, but real in the NFL, and what it means for a
  // survivor entry is the pool's own rule, so no result is recorded for it.
  if (a.score === b.score) return null;

  const margin = Math.abs(a.score - b.score);
  return a.score > b.score
    ? { winner: a.name, loser: b.name, margin }
    : { winner: b.name, loser: a.name, margin };
}

/** A completed event that ended level, so winnerOf has nothing to say. */
export function isTie(event) {
  if (!event?.completed || !Array.isArray(event.scores) || event.scores.length < 2) return false;
  const [a, b] = event.scores.map((entry) => Number(entry.score));
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

/**
 * Which of the league's teams a name in the feed is, out of every name the
 * league knows, or null.
 *
 * The feed writes a school and its mascot ("South Alabama Jaguars") where the
 * college board writes the school, and a city and a nickname ("New England
 * Patriots") where the NFL board writes the nickname. So a known name fits
 * when it is the feed's first words or its last words, whole words only, and
 * never words out of the middle. Where more than one fits, the longest does:
 * "Georgia Southern Eagles" is Georgia Southern, not Georgia. Two different
 * names of the same length both fitting is no answer.
 *
 * Matching any substring is what this replaced, and it put finals in the
 * wrong week: "South Alabama Jaguars" contains Alabama, "Sam Houston
 * Bearkats" contains Houston, and "Georgia Southern Eagles" contains Southern.
 *
 * @param {Iterable<string>} names The spelling that comes first for a team is
 *   the one returned for it.
 * @returns {(name:string) => string|null}
 */
export function teamResolver(names) {
  const known = new Map();
  for (const name of names) {
    const words = wordsOf(name);
    const key = words.join(" ");
    if (words.length && !known.has(key)) known.set(key, { name, words });
  }
  return (name) => {
    const words = wordsOf(name);
    let best = null;
    let tied = false;
    for (const candidate of known.values()) {
      const size = candidate.words.length;
      if (size > words.length) continue;
      const leads = candidate.words.every((word, index) => words[index] === word);
      const ends = candidate.words.every(
        (word, index) => words[words.length - size + index] === word,
      );
      if (!leads && !ends) continue;
      if (!best || size > best.words.length) {
        best = candidate;
        tied = false;
      } else if (size === best.words.length) {
        tied = true;
      }
    }
    return best && !tied ? best.name : null;
  };
}

/** One team's spellings reduced to the same words: case, accents and punctuation dropped. */
export function teamKey(name) {
  return wordsOf(name).join(" ");
}

/**
 * How far from the date plan.json lists for a week a game may kick off and
 * still be that week's game. Four days takes in a Thursday opener and a Monday
 * night game on either side of the weekend the date names, and stays short of
 * the six days between two listed dates.
 */
const PLACE_MS = 4 * 24 * 3600 * 1000;

/**
 * Where a final belongs on the schedule: its week, its game, and which of the
 * game's two teams won. Null when the schedule has no such game.
 *
 * Both teams in the feed have to resolve to the two names of one scheduled
 * game (teamResolver), and the game has to kick off within PLACE_MS of the
 * date listed for its week. The date is what the old match was missing. It
 * searched the weeks in order and took the first game whose two names it could
 * find anywhere in the feed's, so Kentucky's week-4 win over South Alabama was
 * written over its week-2 game against Alabama.
 *
 * @param {{plan:object, schedule:object, resolve:(name:string) => string|null}} league
 * @returns {(event:object, outcome:{winner:string}) =>
 *   {week:number, game:{home:string, away:string}, winner:string}|null}
 */
export function finalsPlacer({ plan, schedule, resolve }) {
  const listed = new Map(
    (plan.weeks ?? []).map((week) => [Number(week.week), Date.parse(`${week.kickoff}T00:00:00Z`)]),
  );
  const pairOf = (a, b) => [teamKey(a), teamKey(b)].sort().join("|");
  const games = Object.entries(schedule.weeks ?? {}).flatMap(([week, list]) =>
    list.map((game) => ({ week: Number(week), game, pair: pairOf(game.home, game.away) })),
  );

  return (event, outcome) => {
    const home = resolve(event?.home_team);
    const away = resolve(event?.away_team);
    const winner = resolve(outcome?.winner);
    if (!home || !away || !winner) return null;

    const kickoff = Date.parse(event.commence_time ?? "");
    const pair = pairOf(home, away);
    let best = null;
    for (const entry of games) {
      if (entry.pair !== pair) continue;
      const gap = Math.abs(kickoff - (listed.get(entry.week) ?? Number.NaN));
      if (!(gap <= PLACE_MS)) continue;
      if (!best || gap < best.gap) best = { ...entry, gap };
    }
    if (!best) return null;

    const { week, game } = best;
    return { week, game, winner: teamKey(winner) === teamKey(game.home) ? game.home : game.away };
  };
}

function wordsOf(name) {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’&.]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((word) => (word === "state" ? "st" : word));
}

/**
 * Reduce one event to a consensus for a given team.
 *
 * The spread and the total are medians across the books still quoting, so a
 * single outlier cannot move the number. The moneyline is handled book by
 * book: each book's two prices share one margin, so each pair is de-vigged on
 * its own and the fair probabilities are averaged in log-odds
 * (core/probability.js fairFromMoneylines). Taking a median of each side
 * across books, as the ingest once did, mixed different books' margins and
 * produced a -50 favourite priced below a -31 one. A book at its house maximum
 * on either side is counted as capped and left out; a book whose quote is
 * hours older than the freshest is stale and left out of everything.
 *
 * @param {object} event
 * @param {string} team Team name as it appears in data/plan.json.
 * @param {object} [model] For the cap, see DEFAULT_MODEL.moneylineCap.
 * @returns {{spread:number, total:number|null, moneyline:number|null,
 *            opponentMoneyline:number|null, moneylineProb:number|null,
 *            books:number, moneylineBooks:number, capped:number, stale:number,
 *            lastUpdate:string|null}|null}
 */
export function consensusFor(event, team, model = DEFAULT_MODEL) {
  const matched = matchTeamName(event, team);
  if (!matched) return null;
  const isTeam = (name) => normalise(name) === normalise(matched);

  // The freshest quote on the game sets the clock a stale book is judged by.
  const updates = [];
  for (const bookmaker of event.bookmakers ?? []) {
    for (const market of bookmaker.markets ?? []) {
      const at = Date.parse(market.last_update ?? bookmaker.last_update ?? "");
      if (Number.isFinite(at)) updates.push(at);
    }
  }
  const freshest = updates.length ? Math.max(...updates) : null;

  const spreads = [];
  const totals = [];
  const pairs = [];
  const teamPrices = [];
  const opponentPrices = [];
  let stale = 0;
  let books = 0;

  for (const bookmaker of event.bookmakers ?? []) {
    let counted = false;
    for (const market of bookmaker.markets ?? []) {
      const at = Date.parse(market.last_update ?? bookmaker.last_update ?? "");
      if (freshest !== null && Number.isFinite(at) && freshest - at > STALE_MS) {
        stale += 1;
        continue;
      }
      if (market.key === "spreads") {
        for (const outcome of market.outcomes ?? []) {
          if (isTeam(outcome.name) && typeof outcome.point === "number") {
            spreads.push(outcome.point);
            counted = true;
          }
        }
      } else if (market.key === "totals") {
        for (const outcome of market.outcomes ?? []) {
          if (outcome.name === "Over" && typeof outcome.point === "number")
            totals.push(outcome.point);
        }
      } else if (market.key === "h2h") {
        const pair = {};
        for (const outcome of market.outcomes ?? []) {
          if (typeof outcome.price !== "number") continue;
          if (isTeam(outcome.name)) {
            pair.team = outcome.price;
            teamPrices.push(outcome.price);
          } else {
            pair.opponent = outcome.price;
            opponentPrices.push(outcome.price);
          }
        }
        if (Number.isFinite(pair.team) && Number.isFinite(pair.opponent)) pairs.push(pair);
      }
    }
    if (counted) books += 1;
  }

  if (spreads.length === 0) return null;

  const fair = fairFromMoneylines(pairs, model);
  return {
    spread: median(spreads),
    total: totals.length ? median(totals) : null,
    moneyline: teamPrices.length ? median(teamPrices) : null,
    opponentMoneyline: opponentPrices.length ? median(opponentPrices) : null,
    moneylineProb: fair.probability,
    books,
    moneylineBooks: fair.books,
    capped: fair.capped,
    stale,
    lastUpdate: freshest ? new Date(freshest).toISOString().replace(/\.\d{3}Z$/, "Z") : null,
  };
}

/** Find an event whose home or away team matches, tolerating name variants. */
export function findEvent(events, team, opponent) {
  return (
    events.find((event) => matchTeamName(event, team) && matchTeamName(event, opponent)) ?? null
  );
}

function matchTeamName(event, team) {
  const candidates = [event.home_team, event.away_team].filter(Boolean);
  const target = normalise(team);
  return (
    candidates.find((candidate) => {
      const value = normalise(candidate);
      return value === target || value.includes(target) || target.includes(value);
    }) ?? null
  );
}

function normalise(name) {
  return String(name)
    .toLowerCase()
    .replace(/\bstate\b/g, "st")
    .replace(/[^a-z0-9]/g, "");
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
