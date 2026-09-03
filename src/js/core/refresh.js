/**
 * The odds schedule.
 *
 * The bot runs once a day and the board shows when the next pull is due.
 * Derived from the cron rather than from the last run, so a skipped or late
 * run does not drag the countdown with it. Pure and environment free, so it is
 * shared with the Node scripts.
 */

/**
 * When the next scheduled run is due. The workflow fires at `hourUtc`:`minuteUtc`
 * every day.
 *
 * @returns {number} epoch ms
 */
export function nextRefreshAt(now = Date.now(), { hourUtc = 14, minuteUtc = 0 } = {}) {
  const next = new Date(now);
  next.setUTCHours(hourUtc, minuteUtc, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
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
