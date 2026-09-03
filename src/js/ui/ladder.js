/**
 * The full path, week by week. Read-only; clicking a row moves the week panel.
 */

import { formatSpread, formatPercent, formatMatchup, escapeHtml } from "../core/format.js";

export function renderLadder(tbody, board, onSelectWeek) {
  tbody.innerHTML = board.weeks
    .map((week) => week.picks.map((pick) => rowMarkup(week, pick, board)).join(""))
    .join("");

  tbody.querySelectorAll("[data-week]").forEach((row) => {
    row.addEventListener("click", () => onSelectWeek(Number(row.dataset.week)));
  });
}

function rowMarkup(week, pick, board) {
  const isFirstSlot = pick.slot === 0;
  const shown = pick.coachPick;
  const classes = [
    week.week === board.currentWeek ? "is-current" : "",
    pick.status.result ? "is-resolved" : "",
    pick.status.selected ? "is-selected" : shown ? "is-planned" : "is-unselected",
  ]
    .filter(Boolean)
    .join(" ");

  return `
    <tr class="${classes}" data-week="${week.week}">
      <td class="ladder__week">${isFirstSlot ? week.week : ""}</td>
      <td class="is-wide-only" style="color:var(--ink-3);font-size:12px">${isFirstSlot ? escapeHtml(week.labelFull) : ""}</td>
      <td class="ladder__team">${shown ? escapeHtml(shown.team) : "No pick"}</td>
      <td class="is-wide-only">${shown ? escapeHtml(formatMatchup(shown.site, shown.opponent)) : "—"}</td>
      <td class="is-narrow-only ladder__opponent">${shown ? escapeHtml(shown.opponent) : "—"}</td>
      <td class="is-wide-only" style="color:var(--ink-3)">${shown ? escapeHtml(shown.site) : "—"}</td>
      <td class="ladder__num">${shown ? formatSpread(shown.spread) : "—"}</td>
      <td class="is-wide-only" style="font-size:11.5px;color:var(--ink-3)">${shown ? (shown.source === "market" ? "Market" : "Projected") : "—"}</td>
      <td class="ladder__num">${shown ? formatPercent(shown.winProb) : "—"}</td>
      <td class="is-wide-only">
        ${
          shown
            ? `<div class="meter" role="img" aria-label="${formatPercent(shown.winProb)} win probability">
          <i class="meter__fill" style="width:${(shown.winProb * 100).toFixed(0)}%"></i>
        </div>`
            : "—"
        }
      </td>
      <td class="is-wide-only ladder__num">${isFirstSlot && week.coachWinProb !== null ? formatPercent(week.coachWinProb) : ""}</td>
      <td>${statusChip(pick.status, Boolean(shown))}</td>
    </tr>`;
}

function statusChip(status, hasPlan) {
  if (status.result === "W") return '<span class="chip chip--safe">Won</span>';
  if (status.result === "L") return '<span class="chip chip--danger">Lost</span>';
  if (status.selected) return '<span class="chip chip--selected">Selected</span>';
  return hasPlan
    ? '<span class="chip chip--planned">Coach plan</span>'
    : '<span class="ladder__blank">No selection</span>';
}
