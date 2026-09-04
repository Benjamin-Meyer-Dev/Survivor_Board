/**
 * League registry.
 *
 * Two pools run on the same board. Everything that differs between them lives
 * here, so nothing downstream has to know which one is loaded:
 *
 *   nfl      18 weeks, one pick a week, one buy back covering weeks 1 and 2
 *   college  13 weeks, two picks a week, no forgiveness
 *
 * A buy back is spent, not refunded: the team stays burned either way, so
 * losing week 1 costs you both the team and the cushion.
 *
 * Order matters twice over: it is the order of the switch, and the first entry
 * is what opens on a device that has not chosen yet. The NFL pool leads.
 *
 * `theme` names a palette in src/css/leagues.css, stamped on the root element
 * as data-league so the whole app changes colour with the pool.
 *
 * Data lives under data/<id>/, so adding a third pool is a folder and an entry.
 */

export const LEAGUES = Object.freeze({
  nfl: {
    id: "nfl",
    label: "NFL",
    short: "NFL",
    title: "Survivor Board",
    /* Primetime: cool navy under stadium lights. */
    theme: "primetime",
    season: 2026,
    firstKickoff: "2026-09-13",
    dangerThreshold: -6,
    /* A line that has moved this far since the week was first priced is
       flagged by the refresh job. A field goal is a lot in the NFL. */
    lineMoveFlag: 2.5,
    ratingLabel: "Power",
    /* Lower, because the NFL does not produce college numbers: a 12 point
       favourite is about as safe as this league gets, and calling it "Shaky"
       on a college scale would make every week look like a coin flip. Roughly
       -16, -11 and -7 on an NFL spread. */
    tiers: { safe: 0.85, solid: 0.78, thin: 0.7 },
    rules: {
      picksPerWeek: 1,
      conferences: ["AFC", "NFC"],
      reuseTeams: false,
      opponentMustBeFbs: false,
      winCondition: "straight-up",
      buyBackWeeks: [1, 2],
      buyBacks: 1,
    },
    planComment:
      "The 18-week NFL survivor path. One pick a week, no team twice. A single buy back " +
      "covers a loss in week 1 or week 2, which is why the opening weeks take on more risk " +
      "than the rest of the path. Spreads are power-rating projections and act as the " +
      "fallback when data/nfl/odds.json carries no market line.",
  },

  cfb: {
    id: "cfb",
    label: "College",
    short: "NCAA",
    title: "Survivor Board",
    /* Night turf: near-black green surfaces under a home-field green accent. */
    theme: "turf",
    season: 2026,
    firstKickoff: "2026-09-05",
    dangerThreshold: -10,
    /* College lines swing further, so the flag waits for a bigger move. */
    lineMoveFlag: 4,
    ratingLabel: "SP+",
    /* Win probability cut-offs for Lock / Solid / Shaky. Roughly -20, -14 and
       -10 on a college spread. */
    tiers: { safe: 0.92, solid: 0.85, thin: 0.78 },
    rules: {
      picksPerWeek: 2,
      conferences: ["SEC", "Big Ten", "Big 12"],
      reuseTeams: false,
      opponentMustBeFbs: true,
      winCondition: "straight-up",
      buyBackWeeks: [],
      buyBacks: 0,
    },
    planComment:
      "The 13-week college survivor path. Two picks a week from the SEC, Big Ten and Big 12, " +
      "no team twice, opponents must be FBS. Spreads are SP+ projections and act as the " +
      "fallback when data/cfb/odds.json carries no market line.",
  },
});

/** Ids in the order the switch shows them. The first is the default. */
export const LEAGUE_IDS = Object.keys(LEAGUES);

/** The league to open with, honouring whatever was chosen last. */
export function resolveLeague(stored) {
  return stored && stored in LEAGUES ? stored : LEAGUE_IDS[0];
}
