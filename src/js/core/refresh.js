/**
 * Manual refresh: state and cooldown maths.
 *
 * Pure and environment free, so the rules are testable and identical on both
 * devices. The actual network work lives in ui/refresh.js and app.js.
 *
 * Three independent guards stop this piling up, because any one of them can
 * be bypassed on its own:
 *
 *   1. The cooldown here, stored in the SHARED entry. Both phones see the same
 *      countdown, so two people cannot each fire one.
 *   2. `concurrency` in the workflow, which never runs two jobs at once.
 *   3. A freshness check inside scripts/refresh-odds.mjs, which no-ops when the
 *      lines were pulled moments ago. This is the one that actually holds,
 *      since it is server side and nothing in the browser can skip it.
 *
 * The scheduled run is untouched by any of this. `workflow_dispatch` and
 * `schedule` are separate triggers in GitHub Actions; firing one by hand does
 * not shift the next cron.
 */

/** How long after a request before another may be made. */
export const COOLDOWN_MS = 5 * 60 * 1000;

/** How long to keep watching for new numbers after a request. */
export const WATCH_MS = 2 * 60 * 1000;

/** Gap between checks while watching. */
export const POLL_MS = 8000;

/**
 * @param {object|undefined} refresh entry.refresh, the shared record
 * @param {number} now
 * @returns {{state:"ready"|"cooling"|"watching", remainingMs:number, by:string|null}}
 */
export function refreshState(refresh, now = Date.now()) {
  const requestedAt = refresh?.requestedAt ?? 0;
  const since = now - requestedAt;

  if (!requestedAt || since >= COOLDOWN_MS) {
    return { state: "ready", remainingMs: 0, by: null };
  }

  return {
    state: since < WATCH_MS ? "watching" : "cooling",
    remainingMs: COOLDOWN_MS - since,
    by: refresh?.by ?? null,
  };
}

/**
 * When the next scheduled run is due.
 *
 * Derived from the cron rather than from the last run, so a skipped or delayed
 * run does not drag the countdown with it. The workflow fires at minute
 * `minuteUtc` of every `everyHours`-th UTC hour.
 *
 * @returns {number} epoch ms
 */
export function nextRefreshAt(now = Date.now(), { everyHours = 6, minuteUtc = 0 } = {}) {
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(minuteUtc);

  // Walk forward to the next slot hour, then past `now` if we landed early.
  while (next.getUTCHours() % everyHours !== 0 || next.getTime() <= now) {
    next.setUTCHours(next.getUTCHours() + 1);
    next.setUTCMinutes(minuteUtc, 0, 0);
  }

  return next.getTime();
}

/** "2:41:07", or "41:07" under an hour. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** "4:07" for a countdown. */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
