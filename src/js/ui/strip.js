/**
 * Status strip: the numbers worth knowing before anything else.
 */

import { formatPercent, timeAgo, escapeHtml } from "../core/format.js";
import { formatDuration } from "../core/refresh.js";

export function renderStrip(root, board) {
  const cells = [
    {
      key: "On the clock",
      value: `Week ${board.currentWeek}`,
      note: board.weeks[board.currentWeek - 1]?.labelFull ?? "",
    },
    {
      key: "Season survival",
      // While the coach is still planning, the open slots have no number yet.
      value: board.eliminated
        ? "Out"
        : board.recommendationPending
          ? "…"
          : formatPercent(board.pathProbability),
      note: board.eliminated
        ? "run is over"
        : board.recommendationPending
          ? "working out the path"
          : survivalNote(board),
    },
    {
      key: "Next refresh",
      // Ticked in place by app.js rather than re-rendered, so the button below
      // it never loses focus mid-second.
      value: `<span id="countdown">${escapeHtml(formatDuration(board.nextRefreshAt - Date.now()))}</span>`,
      raw: true,
      note: `last ${timeAgo(board.updatedAt)}`,
    },
  ];

  root.innerHTML = cells
    .map(
      (cell) => `
      <div class="strip__cell">
        <span class="strip__key">${escapeHtml(cell.key)}</span>
        <span class="strip__value">${cell.raw ? cell.value : escapeHtml(cell.value)}</span>
        <span class="strip__note">${escapeHtml(cell.note)}</span>
      </div>`,
    )
    .join("");
}

/**
 * What the number means. The strip stays three cells wide on a phone, so the
 * buy back is reported here rather than claiming a fourth: the number above
 * already has it counted in, and the weeks it covers are badged on the panel.
 */
function survivalNote(board) {
  if (!board.buyBack) return "if all hold";
  if (board.buyBack.left === 0) return "buy back spent";
  const count = board.buyBack.left;
  return `${count} buy back${count === 1 ? "" : "s"} counted`;
}
