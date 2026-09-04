/**
 * Status strip: the numbers worth knowing before anything else.
 */

import { formatPercent, timeAgo, escapeHtml } from "../core/format.js";
import { formatDuration } from "../core/refresh.js";

/** How long the season number takes to count to a new value. */
const TWEEN_MS = 480;

/**
 * The last season number shown for each league. Held while a search is owed
 * (see seasonSurvival) and counted from when the new number lands (see
 * animateSurvival). Keyed by league so a switch never shows one pool's number
 * on the other's board.
 */
const shown = new Map();

let tweenFrame = 0;

export function renderStrip(root, board) {
  const before = shown.get(board.league)?.probability;
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

  animateSurvival(root, before, season.probability);
}

/**
 * Count the season number from what it was to what it is, instead of cutting.
 * The text is set back to the old value in the same frame it is rendered, so
 * the settle in app.js sees no change there and the count is the only motion.
 * Nothing to do on a league's first paint, when the value is not a number (Out,
 * the dots), when it did not change, or when motion is reduced.
 */
function animateSurvival(root, from, to) {
  cancelAnimationFrame(tweenFrame);
  const el = root.querySelector('[data-motion-key="strip-value-survival"]');
  if (!el || typeof from !== "number" || typeof to !== "number" || from === to) return;
  if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

  el.textContent = formatPercent(from);
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / TWEEN_MS);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = formatPercent(from + (to - from) * eased);
    if (t < 1) tweenFrame = requestAnimationFrame(step);
  };
  tweenFrame = requestAnimationFrame(step);
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
  if (board.recommendationPending && !board.recommendationStale) {
    // A search is owed and no plan stands in. The last number holds, with its
    // note brought up to date: the search lands within a second and the number
    // moves once, from here, rather than via a flash of dots. Only a league's
    // first paint has nothing to hold.
    const last = shown.get(board.league);
    if (last)
      return { probability: last.probability, value: last.value, note: survivalNote(board) };
    return { value: "…", note: "Working out the path" };
  }

  const probability = board.pathProbability;
  const cell = { probability, value: formatPercent(probability) };
  if (board.previewPathProbability === null) {
    cell.note = survivalNote(board);
  } else {
    const change =
      board.previewPathProbability > probability
        ? "better"
        : board.previewPathProbability < probability
          ? "worse"
          : "even";
    cell.note = `<span class="strip__preview strip__preview--${change}">→ ${formatPercent(board.previewPathProbability)} if locked</span>`;
    cell.noteRaw = true;
  }
  shown.set(board.league, cell);
  return cell;
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
