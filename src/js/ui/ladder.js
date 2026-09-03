/**
 * The full path, week by week. Read-only; clicking a row moves the week panel.
 *
 * A row shows whatever the slot holds on the path: a locked or picked team
 * drawn solid, or the coach's suggestion drawn faint, so the season reads as
 * one line while staying clear about which weeks are actually decided.
 */

import { formatSpread, formatPercent, formatMatchup, escapeHtml } from "../core/format.js";

/** What an open row says while the optimiser has not reported yet. */
const PLANNING = "Working out the path…";

export function renderLadder(tbody, board, onSelectWeek) {
  const showWeekProbability = board.rules.picksPerWeek > 1;
  const weekHeader = tbody.closest("table")?.querySelector("[data-week-probability]");
  weekHeader?.toggleAttribute("hidden", !showWeekProbability);

  tbody.innerHTML = board.weeks
    .map((week) =>
      week.picks.map((pick) => rowMarkup(week, pick, board, showWeekProbability)).join(""),
    )
    .join("");

  tbody.querySelectorAll("[data-week]").forEach((row) => {
    row.addEventListener("click", () => onSelectWeek(Number(row.dataset.week)));
  });
}

function rowMarkup(week, pick, board, showWeekProbability) {
  const isFirstSlot = pick.slot === 0;
  const shown = pick.onPath;
  const kind = shown?.kind ?? "empty";
  const pending = !shown && board.recommendationPending && week.week >= board.currentWeek;
  const classes = [
    week.week === board.currentWeek ? "is-current" : "",
    pick.status.result ? "is-resolved" : "",
    `is-${kind}`,
  ]
    .filter(Boolean)
    .join(" ");

  return `
    <tr class="${classes}" data-week="${week.week}" data-motion-key="ladder-${week.week}-${pick.slot}">
      <td class="ladder__week ladder__sticky ladder__sticky--week">${isFirstSlot ? week.week : ""}</td>
      <td class="is-wide-only ladder__date">${isFirstSlot ? escapeHtml(week.labelFull) : ""}</td>
      <td class="ladder__team ladder__sticky ladder__sticky--pick">${shown ? escapeHtml(shown.team) : pending ? PLANNING : "No pick"}</td>
      <td class="is-wide-only">${shown ? escapeHtml(formatMatchup(shown.site, shown.opponent)) : "—"}</td>
      <td class="is-wide-only ladder__site">${shown ? escapeHtml(shown.site) : "—"}</td>
      <td class="ladder__num${shown ? ` confidence--${shown.tier}` : ""}">${shown ? formatSpread(shown.spread) : "—"}</td>
      <td class="is-wide-only ladder__source">${shown ? (shown.source === "market" ? "Market" : "Projected") : "—"}</td>
      <td class="ladder__num${shown ? ` confidence--${shown.tier}` : ""}">${shown ? formatPercent(shown.winProb) : "—"}</td>
      ${
        showWeekProbability
          ? `<td class="is-wide-only ladder__num${isFirstSlot && week.pathTier ? ` confidence--${week.pathTier}` : ""}">${isFirstSlot && week.pathWinProb !== null ? formatPercent(week.pathWinProb) : ""}</td>`
          : ""
      }
      <td class="ladder__num ladder__season${isFirstSlot && week.seasonTier ? ` confidence--${week.seasonTier}` : ""}">${isFirstSlot && week.seasonWinProb !== null ? formatPercent(week.seasonWinProb) : ""}</td>
      <td>${statusChip(pick.status, kind)}</td>
    </tr>`;
}

function statusChip(status, kind) {
  if (status.result === "W") return '<span class="chip chip--safe">Won</span>';
  if (status.result === "L") return '<span class="chip chip--danger">Lost</span>';
  if (kind === "locked") return '<span class="chip chip--locked">Locked</span>';
  if (kind === "picked") return '<span class="chip chip--picked">Picked</span>';
  if (kind === "coach") return '<span class="chip chip--coach">Coach plan</span>';
  return '<span class="ladder__blank">No pick</span>';
}
