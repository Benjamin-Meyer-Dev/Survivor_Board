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
