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

/** Do two spellings refer to the same programme? */
export function sameTeam(a, b) {
  const x = normalise(a);
  const y = normalise(b);
  return x === y || x.includes(y) || y.includes(x);
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
