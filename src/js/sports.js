/**
 * Sport registry.
 *
 * What a league is made of that nobody chooses: the schedule, the teams, the
 * lines, the ratings and the calibrated model. There are two, they live in
 * data/<id>/, and the daily job pulls them.
 *
 * This file used to be the pool registry, back when the three pools were the
 * app. Pools are leagues now - created from the home page, stored by code, and
 * carrying their own rules (see store/directory.js and core/rules.js) - so what
 * is left here is the half of a league that comes out of the repo rather than
 * out of a person. A league picks one or more of these to play - a board for
 * each, under one code - and everything below reads the sport for its games
 * and the league for its rules.
 *
 * `theme` names a palette in src/css/leagues.css, stamped on the root element
 * as data-league so the whole app changes colour with the sport. A league
 * picking losers takes the same palette turned warm, off data-objective.
 *
 * Adding a sport is a folder under data/ and an entry here.
 */

export const SPORTS = Object.freeze({
  nfl: {
    id: "nfl",
    label: "NFL",
    short: "NFL",
    /* Primetime: cool navy under stadium lights. */
    theme: "primetime",
    season: 2026,
    firstKickoff: "2026-09-13",
    /* A line that has moved this far since the week was first priced is
       flagged by the refresh job. A field goal is a lot in the NFL. */
    lineMoveFlag: 2.5,
    ratingLabel: "Power",
    /* The conferences a league on this sport can pick from. */
    conferences: ["AFC", "NFC"],
    /* What a new league on this sport starts with, before anyone changes it in
       the settings sheet. The NFL's own pool convention: one pick a week and a
       single buy back over the opening two weeks. */
    defaultRules: {
      picksPerWeek: 1,
      objective: "win",
      buyBackWeeks: [1, 2],
      buyBacks: 1,
    },
  },

  cfb: {
    id: "cfb",
    label: "College",
    short: "NCAA",
    /* Night turf: near-black green surfaces under a home-field green accent. */
    theme: "turf",
    season: 2026,
    firstKickoff: "2026-09-05",
    /* College lines swing further, so the flag waits for a bigger move. */
    lineMoveFlag: 4,
    ratingLabel: "SP+",
    conferences: ["SEC", "Big Ten", "Big 12"],
    /* Two picks a week and no forgiveness, which is how the college pools
       these boards were built for run. */
    defaultRules: {
      picksPerWeek: 2,
      objective: "win",
      buyBackWeeks: [],
      buyBacks: 0,
    },
  },
});

/** Ids in the order a new league offers them. The first is the default. */
export const SPORT_IDS = Object.keys(SPORTS);

/** The sport to fall back on for anything that names one that is gone. */
export function resolveSport(id) {
  return id && id in SPORTS ? id : SPORT_IDS[0];
}

/** A sport's display name, for a league card or a script's log. */
export function sportLabel(id) {
  return SPORTS[resolveSport(id)].label;
}

/**
 * The seasons a league plays, as a clean list: known ids only, each once, in
 * the registry's order. Empty when nothing usable was given, and the caller
 * decides what that means - an error for a league being made, a fallback for
 * a cached row from before a league could hold more than one season.
 *
 * @param {string|string[]|undefined} ids
 * @returns {string[]}
 */
export function normaliseSports(ids) {
  const given = Array.isArray(ids) ? ids : [ids];
  const wanted = new Set(given.filter((id) => typeof id === "string" && id in SPORTS));
  return SPORT_IDS.filter((id) => wanted.has(id));
}

/** The seasons a league plays, named: "NFL", or "NFL & College". */
export function sportsLabel(ids) {
  return normaliseSports(ids)
    .map((id) => SPORTS[id].label)
    .join(" & ");
}
