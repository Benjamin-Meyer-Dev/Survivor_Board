/**
 * Status strip: the numbers worth knowing before anything else.
 */

import { formatPercent, timeAgo, escapeHtml } from "../core/format.js";
import { formatDuration } from "../core/refresh.js";

export function renderStrip(root, board) {
  const season = seasonSurvival(board);
  const cells = [
    {
      key: "On the Clock",
      value: `Week ${board.currentWeek}`,
      note: board.weeks[board.currentWeek - 1]?.labelFull ?? "",
    },
    {
      key: "Season Survival",
      ...season,
    },
    {
      key: "Next Refresh",
      // Ticked in place by app.js rather than re-rendered, so the button below
      // it never loses focus mid-second.
      value: `<span id="countdown">${escapeHtml(formatDuration(board.nextRefreshAt - Date.now()))}</span>`,
      raw: true,
      note: `daily at ${refreshTime(board.nextRefreshAt)} local · last ${timeAgo(board.updatedAt)}`,
    },
  ];

  root.innerHTML = cells
    .map(
      (cell) => `
      <div class="strip__cell">
        <span class="strip__key">${escapeHtml(cell.key)}</span>
        <span class="strip__value">${cell.raw ? cell.value : escapeHtml(cell.value)}</span>
        <span class="strip__note">${cell.noteRaw ? cell.note : escapeHtml(cell.note)}</span>
      </div>`,
    )
    .join("");
}

/** The next run's clock time in the viewer's own timezone. */
function refreshTime(nextRefreshAt) {
  return new Date(nextRefreshAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function seasonSurvival(board) {
  if (board.eliminated) return { value: "Out", note: "run is over" };
  if (board.recommendationPending) return { value: "…", note: "working out the path" };
  if (board.previewPathProbability === null) {
    return { value: formatPercent(board.pathProbability), note: survivalNote(board) };
  }

  const change =
    board.previewPathProbability > board.pathProbability
      ? "better"
      : board.previewPathProbability < board.pathProbability
        ? "worse"
        : "even";
  return {
    value: formatPercent(board.pathProbability),
    note: `<span class="strip__preview strip__preview--${change}">→ ${formatPercent(board.previewPathProbability)} if locked</span>`,
    noteRaw: true,
  };
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
