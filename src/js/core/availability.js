/**
 * Player availability as a points adjustment, not an injury count.
 *
 * A team without its quarterback is a different team; a team without its
 * fourth receiver is the same team. So each entry in data/<league>/
 * availability.json is one player, and what it is worth is
 *
 *   expected adjustment = probability the player is out
 *                         x points the team is worse without them
 *
 * summed over the team's entries for the week, capped so no roster of doubts
 * can move a rating further than losing its whole first unit would.
 *
 * Where it applies is the subtle part. The market has already read the injury
 * report: a line posted this morning prices a quarterback who was ruled out
 * yesterday, and taking the points off again would count him twice. So an
 * adjustment moves a market line only when the report is newer than the line,
 * and moves a projected line always, because a projection knows nothing the
 * ratings do not.
 *
 * The file is a human's (see docs/CODE_STANDARDS.md): the conferences publish
 * availability on their own schedules, most non-conference games have no
 * report at all, and the nflverse injury feed that once covered the NFL went
 * dark after 2024. Every entry therefore carries where it came from and when.
 * No entry means no adjustment - which is the same number as "healthy", but is
 * reported as "no report", because they are not the same fact.
 *
 * Pure and environment-free.
 */

/**
 * Points a team is worse without a player, by position, when the entry does
 * not say. Deliberately modest and deliberately steep for the quarterback:
 * every published study of replacement value puts the starting quarterback
 * several times any other position, and the rest inside a point or two.
 */
export const POINTS_BY_POSITION = Object.freeze({
  QB: 6,
  RB: 1,
  WR: 1.2,
  TE: 0.7,
  OL: 0.8,
  OT: 1,
  OG: 0.7,
  C: 0.7,
  DL: 0.8,
  DT: 0.7,
  EDGE: 1.2,
  DE: 1.1,
  LB: 0.6,
  CB: 1,
  S: 0.6,
  K: 0.5,
  P: 0.2,
});

/** Chance a player misses the game, by report status, when the entry does not say. */
export const PROBABILITY_BY_STATUS = Object.freeze({
  out: 1,
  suspended: 1,
  ir: 1,
  doubtful: 0.75,
  questionable: 0.5,
  probable: 0.15,
  available: 0,
  in: 0,
});

/** No collection of doubts moves a team more than this, in points. */
export const TEAM_CAP = 12;

/**
 * Points to take off a team's rating for one game.
 *
 * @param {object} args
 * @param {object|null} args.availability The parsed availability.json, or null.
 * @param {string} args.team
 * @param {number} args.week
 * @param {"market"|"projected"} args.source Where the line comes from.
 * @param {string|null} [args.lineAt] When the market line was pulled (ISO).
 *   An entry reported after it moves the line; one reported before is priced.
 * @returns {{points:number, applied:Array<object>, priced:Array<object>, reported:boolean}}
 *   `applied` is what moved the number, `priced` what the market already had,
 *   `reported` whether the team has any entry at all for the week.
 */
export function availabilityAdjustment({ availability, team, week, source, lineAt = null }) {
  const none = { points: 0, applied: [], priced: [], reported: false };
  const entries = availability?.entries;
  if (!Array.isArray(entries)) return none;

  const lineTime = lineAt ? Date.parse(lineAt) : NaN;
  const applied = [];
  const priced = [];

  for (const entry of entries) {
    if (entry?.team !== team) continue;
    if (!coversWeek(entry, week)) continue;

    const probability = probabilityOut(entry);
    const points = pointsFor(entry);
    const expected = probability * points;
    const reportedAt = Date.parse(entry.reportedAt ?? "");
    const detail = {
      player: entry.player ?? "unnamed",
      position: entry.position ?? "",
      status: entry.status ?? "",
      probability,
      points,
      expected: round(expected, 2),
      source: entry.source ?? "",
      reportedAt: entry.reportedAt ?? null,
    };

    // A market line already prices any report that came before it.
    const newer =
      !Number.isFinite(lineTime) || !Number.isFinite(reportedAt) || reportedAt > lineTime;
    if (source === "market" && !newer) {
      priced.push(detail);
      continue;
    }
    if (expected > 0) applied.push(detail);
  }

  const total = applied.reduce((sum, detail) => sum + detail.expected, 0);
  return {
    points: round(Math.min(TEAM_CAP, total), 2),
    applied,
    priced,
    reported: applied.length + priced.length > 0,
  };
}

/** Whether an entry speaks to a week: the weeks it lists, or every week if none. */
function coversWeek(entry, week) {
  if (Array.isArray(entry.weeks) && entry.weeks.length) return entry.weeks.includes(week);
  if (Number.isFinite(entry.fromWeek) && week < entry.fromWeek) return false;
  if (Number.isFinite(entry.throughWeek) && week > entry.throughWeek) return false;
  return true;
}

function probabilityOut(entry) {
  if (Number.isFinite(entry.probabilityOut)) return Math.min(1, Math.max(0, entry.probabilityOut));
  return PROBABILITY_BY_STATUS[String(entry.status ?? "").toLowerCase()] ?? 0.5;
}

function pointsFor(entry) {
  if (Number.isFinite(entry.points)) return Math.max(0, entry.points);
  return POINTS_BY_POSITION[String(entry.position ?? "").toUpperCase()] ?? 0.5;
}

/**
 * One line of text for a team's availability in a week, or "" when there is
 * nothing to say. The UI shows it beside a pick; "no report" is not shown, so
 * silence stays silence rather than reading as health.
 */
export function availabilityNote(adjustment) {
  if (!adjustment || adjustment.applied.length === 0) return "";
  const names = adjustment.applied
    .slice(0, 2)
    .map((detail) => `${detail.player}${detail.status ? ` ${detail.status}` : ""}`)
    .join(", ");
  const more = adjustment.applied.length > 2 ? ` +${adjustment.applied.length - 2}` : "";
  return `${names}${more}: −${adjustment.points.toFixed(1)} pts`;
}

function round(value, places) {
  return Number(value.toFixed(places));
}
