/**
 * Thin client for the-odds-api.com.
 *
 * Free tier is 500 requests/month. Each league costs two requests per run
 * (odds and scores), so two leagues four times a day across the autumn is the
 * whole budget: the freshness guard in refresh-odds.mjs is what keeps a burst
 * of manual refreshes from spending it. The key lives in the ODDS_API_KEY
 * repository secret and never reaches the browser.
 */

const BASE = "https://api.the-odds-api.com/v4";

/** The API's sport key for each of our leagues. */
export const SPORT_KEYS = Object.freeze({
  cfb: "americanfootball_ncaaf",
  nfl: "americanfootball_nfl",
});

/**
 * Fetch current spreads and moneylines for every upcoming NCAAF game.
 *
 * @param {string} apiKey
 * @param {string} sport A value from SPORT_KEYS.
 * @returns {Promise<Array<object>>} Raw events.
 */
export async function fetchEvents(apiKey, sport) {
  const url = new URL(`${BASE}/sports/${sport}/odds`);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("regions", "us");
  url.searchParams.set("markets", "spreads,h2h");
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
 * Which side won a completed event, or null when it is not final or the
 * payload is missing scores.
 *
 * @param {object} event
 * @returns {{winner:string, loser:string}|null}
 */
export function winnerOf(event) {
  if (!event?.completed || !Array.isArray(event.scores) || event.scores.length < 2) return null;

  const [a, b] = event.scores.map((entry) => ({
    name: entry.name,
    score: Number(entry.score),
  }));
  if (!Number.isFinite(a.score) || !Number.isFinite(b.score)) return null;
  if (a.score === b.score) return null; // ties do not exist in this sport, so this is bad data

  return a.score > b.score ? { winner: a.name, loser: b.name } : { winner: b.name, loser: a.name };
}

/** Do two spellings refer to the same programme? */
export function sameTeam(a, b) {
  const x = normalise(a);
  const y = normalise(b);
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * Reduce one event to the consensus spread and moneyline for a given team.
 * Takes the median across books so a single outlier cannot move the number.
 *
 * @param {object} event
 * @param {string} team Team name as it appears in data/plan.json.
 * @returns {{spread:number, moneyline:number|null, opponentMoneyline:number|null}|null}
 */
export function consensusFor(event, team) {
  const matched = matchTeamName(event, team);
  if (!matched) return null;

  const spreads = [];
  const moneylines = [];
  const opponentMoneylines = [];

  for (const bookmaker of event.bookmakers ?? []) {
    for (const market of bookmaker.markets ?? []) {
      for (const outcome of market.outcomes ?? []) {
        const isTeam = normalise(outcome.name) === normalise(matched);
        if (market.key === "spreads" && isTeam && typeof outcome.point === "number") {
          spreads.push(outcome.point);
        }
        if (market.key === "h2h" && typeof outcome.price === "number") {
          (isTeam ? moneylines : opponentMoneylines).push(outcome.price);
        }
      }
    }
  }

  if (spreads.length === 0) return null;

  return {
    spread: median(spreads),
    moneyline: moneylines.length ? median(moneylines) : null,
    opponentMoneyline: opponentMoneylines.length ? median(opponentMoneylines) : null,
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
