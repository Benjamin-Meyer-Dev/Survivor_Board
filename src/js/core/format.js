/**
 * Display formatting. Pure, no DOM.
 */

/** "-13.0" / "+2.5" */
export function formatSpread(spread) {
  return `${spread > 0 ? "+" : ""}${spread.toFixed(1)}`;
}

/** 0.8734 -> "87.3%" */
export function formatPercent(value, decimals = 1) {
  return `${(value * 100).toFixed(decimals)}%`;
}

/** "vs Purdue" / "at Purdue" */
export function formatMatchup(site, opponent) {
  return `${site === "Home" ? "vs" : "at"} ${opponent}`;
}

/**
 * A week as a sentence names it: "week 12", or a playoff round's own name -
 * "the Wild Card round", "the Super Bowl" (core/plan.js weekNames).
 *
 * @param {object} board Result of buildBoard().
 * @param {number} week
 */
export function weekPhrase(board, week) {
  return board?.weekNames?.[week]?.phrase ?? `week ${week}`;
}

/** A week as a tag names it: "Week 12", or a playoff round's short name - "WC". */
export function weekTag(board, week) {
  const names = board?.weekNames?.[week];
  return names && names.short !== String(week) ? names.short : `Week ${week}`;
}

/** Escape untrusted text before it goes into innerHTML. */
export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
}

/* Made once. A formatter is expensive to build and cheap to use, and the card
   asks for a kickoff for every pick of the season each time it measures its
   floor (holdEveryWeek in ui/call.js) - two new formatters a game was most of
   what that cost. */
const KICKOFF_DAY = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const KICKOFF_TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

/**
 * When a game kicks off, in the reader's own time: "Sun Sep 13 · 4:25 PM".
 * Nothing for a game the feed has not timed.
 *
 * @param {string|null|undefined} iso
 * @returns {string}
 */
export function formatKickoff(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${KICKOFF_DAY.format(date)} · ${KICKOFF_TIME.format(date)}`;
}
