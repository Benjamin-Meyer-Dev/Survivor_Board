/**
 * The drive: the season, week by week, as yard-line bands.
 *
 * Read-only; tapping a row looks at that week (the call and the sideline
 * follow, the ball stays where it is). A row shows whatever the week holds on
 * the path: a locked or picked team drawn solid, or the coach's suggestion
 * pencilled in, so the season reads as one line while staying clear about
 * which weeks are actually decided. The last column is how much of the season
 * is still alive by that week on today's numbers.
 *
 * Nothing in a row depends on which week is being looked at except the bracket
 * around it, so a week change moves that in place (markDriveViewing) exactly as
 * the field moves its own. Rebuilding eighteen rows to light one of them was
 * the most expensive part of a scrub along the field.
 */

import { formatSpread, formatPercent, formatMatchup, escapeHtml } from "../core/format.js";
import { delegate } from "./events.js";

/** What an open row says while the optimiser has not reported yet. */
const PLANNING = "Working out the path…";

/**
 * The ball on the row of the week on the clock: the flag, laced in black. The
 * mark is 14px wide (.drive__wk svg), so the seam and three laces are drawn
 * heavy enough to survive that. The field draws a bigger one of its own
 * (ui/pitch.js).
 */
const ROW_BALL = `<svg viewBox="0 0 34 21" aria-hidden="true"><ellipse cx="17" cy="10.5" rx="15.6" ry="9.2" style="fill: var(--flag)" /><path d="M9.5 10.5h15M12.5 8v5M17 8v5M21.5 8v5" fill="none" stroke="#000" stroke-width="2.6" stroke-linecap="round" /></svg>`;

/**
 * @param {HTMLElement} root
 * @param {object} board Result of buildBoard().
 * @param {number} viewWeek
 * @param {(week:number)=>void} onSelectWeek
 */
export function renderDrive(root, board, viewWeek, onSelectWeek) {
  delegate(root, "click", "[data-week]", (row) => onSelectWeek(Number(row.dataset.week)));

  root.innerHTML = `
    <div class="drive">
      <div class="drive__head" aria-hidden="true">
        <span>Wk</span><span>Pick</span><span class="drive__wide">Spread</span><span>Win %</span><span title="Chance of still being in the pool after this week">Survival</span><span class="drive__wide">Status</span>
      </div>
      ${board.weeks.map((week) => weekRowMarkup(week, board, viewWeek)).join("")}
    </div>`;
}

/** Move the bracket to a week's row without rebuilding the drive. */
export function markDriveViewing(root, week) {
  for (const row of root.querySelectorAll("[data-week]")) {
    const viewing = Number(row.dataset.week) === week;
    row.classList.toggle("drive__row--viewing", viewing);
    row.setAttribute("aria-pressed", String(viewing));
  }
}

function weekRowMarkup(week, board, viewWeek) {
  const shown = week.picks.map((pick) => pick.onPath).filter(Boolean);
  const kinds = new Set(shown.map((entry) => entry.kind));
  const pending =
    shown.length === 0 && board.recommendationPending && week.week >= board.currentWeek;
  const moot = board.eliminated && week.week > board.eliminatedWeek;
  const resolved = week.picks.some((pick) => pick.status.result);
  const kind = kinds.has("locked")
    ? "locked"
    : kinds.has("picked")
      ? "picked"
      : kinds.has("coach")
        ? "coach"
        : "empty";

  const classes = [
    "drive__row",
    `drive__row--${kind}`,
    week.week === board.currentWeek && !board.eliminated ? "drive__row--now" : "",
    week.week === viewWeek ? "drive__row--viewing" : "",
    moot ? "drive__row--moot" : "",
    resolved ? "drive__row--resolved" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const teams = shown.map((entry) => entry.team).join(" & ");
  const games = shown.map((entry) => formatMatchup(entry.site, entry.opponent)).join(" · ");
  // One number for the week: the pool's chance of getting through it, which
  // for a two-pick week is both picks together.
  const win = week.pathWinProb ?? shown[0]?.winProb ?? null;
  const tier = week.pathTier ?? shown[0]?.tier ?? null;

  // What the row is showing, for the settle that plays when it changes under
  // no tap of yours (playDataUpdates in app.js). The week being looked at is
  // deliberately not in it: the bracket moving is not the row changing.
  const signature = [kind, teams, win ?? "", week.seasonWinProb ?? "", results(week).join("")].join(
    "|",
  );

  return `
    <button type="button" class="${classes}" data-week="${week.week}" data-motion-key="drive-${week.week}"
            data-motion-signature="${escapeHtml(signature)}"
            aria-label="Week ${week.week}, ${escapeHtml(week.labelFull)}${teams ? `, ${escapeHtml(teams)}` : ""}"
            aria-pressed="${week.week === viewWeek}">
      <span class="drive__wk">${week.week}${week.week === board.currentWeek && !board.eliminated ? ROW_BALL : ""}</span>
      <span class="drive__pick">
        <span class="drive__team">${teams ? escapeHtml(teams) : moot ? "Not played" : pending ? PLANNING : "No pick"}</span>
        <span class="drive__sub">${escapeHtml(games || week.labelFull)}</span>
      </span>
      <span class="drive__wide drive__win${shown[0] ? ` confidence--${shown[0].tier}` : ""}">${shown[0] ? formatSpread(shown[0].spread) : "—"}</span>
      <span class="drive__win${tier ? ` confidence--${tier}` : ""}">${win !== null ? formatPercent(win, 0) : "—"}</span>
      <span class="drive__alive">${week.seasonWinProb !== null ? formatPercent(week.seasonWinProb, 0) : ""}</span>
      <span class="drive__wide">${statusChip(week, kind, moot)}</span>
    </button>`;
}

/** The week's finals, in slot order. */
function results(week) {
  return week.picks.map((pick) => pick.status.result).filter(Boolean);
}

function statusChip(week, kind, moot) {
  const finals = results(week);
  if (finals.includes("L")) return '<span class="chip chip--danger">Lost</span>';
  if (finals.length) return '<span class="chip chip--safe">Won</span>';
  if (moot) return "";
  if (kind === "locked") return '<span class="chip chip--locked">Locked</span>';
  if (kind === "picked") return '<span class="chip chip--picked">Picked</span>';
  if (kind === "coach") return '<span class="chip chip--coach">Coach plan</span>';
  return "";
}
