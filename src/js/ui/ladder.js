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
  const classes = [
    week.week === board.currentWeek ? "is-current" : "",
    pick.status.result ? "is-resolved" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `
    <tr class="${classes}" data-week="${week.week}">
      <td class="ladder__week">${isFirstSlot ? week.week : ""}</td>
      <td class="is-wide-only" style="color:var(--ink-3);font-size:12px">${isFirstSlot ? escapeHtml(week.labelFull) : ""}</td>
      <td class="ladder__team">${escapeHtml(pick.team)}</td>
      <td class="is-wide-only">${escapeHtml(formatMatchup(pick.site, pick.opponent))}</td>
      <td class="is-narrow-only ladder__opponent">${escapeHtml(pick.opponent)}</td>
      <td class="is-wide-only" style="color:var(--ink-3)">${escapeHtml(pick.site)}</td>
      <td class="ladder__num">${formatSpread(pick.spread)}</td>
      <td class="is-wide-only" style="font-size:11.5px;color:var(--ink-3)">${pick.source === "market" ? "Market" : "Projected"}</td>
      <td class="ladder__num">${formatPercent(pick.winProb)}</td>
      <td class="is-wide-only">
        <div class="meter" role="img" aria-label="${formatPercent(pick.winProb)} win probability">
          <i class="meter__fill" style="width:${(pick.winProb * 100).toFixed(0)}%"></i>
        </div>
      </td>
      <td class="is-wide-only ladder__num">${isFirstSlot ? formatPercent(week.weekWinProb) : ""}</td>
      <td>${statusChip(pick.status)}</td>
    </tr>`;
}

function statusChip(status) {
  if (status.result === "W") return '<span class="chip chip--safe">Won</span>';
  if (status.result === "L") return '<span class="chip chip--danger">Lost</span>';
  if (status.locked) return '<span class="chip chip--lock">Locked</span>';
  return '<span class="ladder__blank">Open</span>';
}
