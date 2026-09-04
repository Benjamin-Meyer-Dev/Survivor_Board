/**
 * Status strip: the numbers worth knowing before anything else.
 */

import { formatPercent, timeAgo, escapeHtml } from "../core/format.js";
import { formatDuration } from "../core/refresh.js";

export function renderStrip(root, board) {
  const season = seasonSurvival(board);
  // In review the clock has stopped: the cell names the week the run ended
  // instead of the week the league is in.
  const shownWeek = board.eliminated ? board.eliminatedWeek : board.currentWeek;
  const cells = [
    {
      id: "clock",
      key: board.eliminated ? "Eliminated" : "On the clock",
      value: `Week ${shownWeek}`,
      note: board.weeks[shownWeek - 1]?.labelFull ?? "",
      motionValue: true,
      motionNote: true,
    },
    {
      id: "survival",
      key: "Season survival",
      ...season,
      motionValue: true,
      motionNote: true,
    },
    {
      id: "refresh",
      key: "Next refresh",
      // Ticked in place by app.js rather than re-rendered, so the button below
      // it never loses focus mid-second.
      value: `<span id="countdown">${escapeHtml(formatDuration(board.nextRefreshAt - Date.now()))}</span>`,
      raw: true,
      note: `Daily at ${refreshTime(board.nextRefreshAt)} local · Last ${timeAgo(board.updatedAt)}`,
      motionNote: true,
    },
  ];

  root.innerHTML = cells
    .map(
      (cell) => `
      <div class="strip__cell">
        <span class="strip__key">${escapeHtml(cell.key)}</span>
        <span class="strip__value"${cell.motionValue ? ` data-motion-key="strip-value-${cell.id}"` : ""}>${cell.raw ? cell.value : escapeHtml(cell.value)}</span>
        <span class="strip__note"${cell.motionNote ? ` data-motion-key="strip-note-${cell.id}"` : ""}>${cell.noteRaw ? cell.note : escapeHtml(cell.note)}</span>
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
  if (board.eliminated) {
    return { value: "Out", note: `Final record ${board.record.won}-${board.record.lost}` };
  }
  // Only with nothing to show. When the previous plan is standing in for the
  // one being worked out, its number holds until the new one lands.
  if (board.recommendationPending && !board.recommendationStale) {
    return { value: "…", note: "Working out the path" };
  }
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
  if (!board.buyBack) return "If all hold";
  if (board.buyBack.left === 0) return "Buy back spent";
  const count = board.buyBack.left;
  return `${count} buy back${count === 1 ? "" : "s"} counted`;
}
