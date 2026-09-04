/**
 * Season calendar. Weeks run Tuesday to Monday so a Thursday or Friday game
 * lands in the same bucket as the Saturday slate.
 */

const DAY_MS = 24 * 3600 * 1000;

/**
 * How far ahead of a week's listed kickoff that week is already live.
 *
 * `kickoff` in plan.json is the Saturday slate, not the week's first game, and
 * it is also about when books post the lines. Five days covers both: a
 * Thursday or Friday opener sits ahead of the Saturday date, and the lines for
 * it are up before that.
 */
const LEAD_MS = 5 * DAY_MS;

/**
 * Which pool week a date falls in.
 *
 * @param {object} plan data/plan.json
 * @param {Date} now
 * @returns {number|null} 1-13, or null when the season has not started or is over.
 */
export function currentWeekFor(plan, now = new Date()) {
  const weeks = plan.weeks;
  const time = now.getTime();

  for (let i = 0; i < weeks.length; i += 1) {
    const kickoff = new Date(`${weeks[i].kickoff}T00:00:00Z`).getTime();
    const nextKickoff =
      i + 1 < weeks.length
        ? new Date(`${weeks[i + 1].kickoff}T00:00:00Z`).getTime()
        : kickoff + 7 * DAY_MS;

    // A week becomes "current" five days before its first listed kickoff,
    // which is when books post the lines for it.
    if (time >= kickoff - LEAD_MS && time < nextKickoff - LEAD_MS) return weeks[i].week;
  }

  if (time < new Date(`${weeks[0].kickoff}T00:00:00Z`).getTime() - LEAD_MS) return weeks[0].week;

  return null;
}

/**
 * Whether there can be final scores worth reading.
 *
 * From when the opening week goes live until a week after the last kickoff.
 * Both ends of that window are wider than the plan's listed kickoff dates, and
 * for the same reason: `kickoff` is the Saturday slate. At the front, week 1's
 * Thursday opener is played two days before the date the plan names, and
 * gating on the date itself skips the scores call for exactly the days those
 * openers settle. At the back, currentWeekFor calls the season over two days
 * after the final kickoff while that week is still being played, and without
 * the trailing week the last Monday night result would never reach the board.
 *
 * @param {object} plan data/plan.json
 * @param {Date} now
 * @returns {boolean}
 */
export function resultsDueFor(plan, now = new Date()) {
  const weeks = plan.weeks;
  const time = now.getTime();
  const first = new Date(`${weeks[0].kickoff}T00:00:00Z`).getTime() - LEAD_MS;
  const last = new Date(`${weeks[weeks.length - 1].kickoff}T00:00:00Z`).getTime();
  return time >= first && time < last + 7 * DAY_MS;
}
