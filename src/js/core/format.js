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

/** Coarse relative time: "4h ago", "2d ago". */
export function timeAgo(isoString, now = Date.now()) {
  const minutes = Math.round((now - new Date(isoString).getTime()) / 60000);
  if (!Number.isFinite(minutes)) return "unknown";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Escape untrusted text before it goes into innerHTML. */
export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
}

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
  const day = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(
    date,
  );
  return `${day} · ${time}`;
}
