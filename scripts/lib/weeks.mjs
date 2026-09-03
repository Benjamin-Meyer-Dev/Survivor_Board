/**
 * Season calendar. Weeks run Tuesday to Monday so a Thursday or Friday game
 * lands in the same bucket as the Saturday slate.
 */

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
        : kickoff + 7 * 24 * 3600 * 1000;

    // A week becomes "current" five days before its first listed kickoff,
    // which is when books post the lines for it.
    const opens = kickoff - 5 * 24 * 3600 * 1000;
    if (time >= opens && time < nextKickoff - 5 * 24 * 3600 * 1000) return weeks[i].week;
  }

  const firstOpens = new Date(`${weeks[0].kickoff}T00:00:00Z`).getTime() - 5 * 24 * 3600 * 1000;
  if (time < firstOpens) return weeks[0].week;

  return null;
}
