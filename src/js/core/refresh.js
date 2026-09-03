/**
 * The odds schedule.
 *
 * The bot runs once a day and the board shows when the next pull is due.
 * Derived from the cron rather than from the last run, so a skipped or late
 * run does not drag the countdown with it. Pure and environment free, so it is
 * shared with the Node scripts.
 */

/**
 * When the next scheduled run is due in the configured local timezone. Working
 * from calendar fields rather than a fixed UTC offset keeps the clock time
 * stable across daylight-saving changes.
 *
 * @returns {number} epoch ms
 */
export function nextRefreshAt(
  now = Date.now(),
  { hour = 9, minute = 0, timeZone = "America/Toronto" } = {},
) {
  const localNow = zonedParts(now, timeZone);
  let next = zonedTimeToEpoch({ ...localNow, hour, minute, second: 0 }, timeZone);

  if (next <= now) {
    const tomorrow = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day + 1));
    next = zonedTimeToEpoch(
      {
        year: tomorrow.getUTCFullYear(),
        month: tomorrow.getUTCMonth() + 1,
        day: tomorrow.getUTCDate(),
        hour,
        minute,
        second: 0,
      },
      timeZone,
    );
  }

  return next;
}

function zonedTimeToEpoch(target, timeZone) {
  const wallTime = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
  );
  let candidate = wallTime;

  // Re-evaluate the offset at the candidate time so dates on either side of a
  // daylight-saving boundary resolve using the correct side of the boundary.
  for (let pass = 0; pass < 3; pass += 1) {
    const shown = zonedParts(candidate, timeZone);
    const shownAsUtc = Date.UTC(
      shown.year,
      shown.month - 1,
      shown.day,
      shown.hour,
      shown.minute,
      shown.second,
    );
    candidate += wallTime - shownAsUtc;
  }

  return candidate;
}

function zonedParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));

  return Object.fromEntries(
    parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, Number(value)]),
  );
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
