/**
 * Status strip: the numbers worth knowing before anything else.
 */

import { formatPercent, timeAgo, escapeHtml } from "../core/format.js";
import { formatDuration } from "../core/refresh.js";

/** How long the season number wears the colour of its change (see motion.css). */
const PULSE_MS = 1400;

/**
 * The last season number shown for each league. Held while a search is owed
 * (see seasonSurvival) and compared against when the new number lands (see
 * markChange). Keyed by league so a switch never shows one pool's number on the
 * other's board.
 */
const shown = new Map();

/**
 * The change the season number is currently wearing, so a render that lands
 * mid-pulse without moving the number (a store echo, a tab change) resumes it
 * on the fresh node instead of cutting it short.
 */
let pulse = null;

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
      // No motion keys: the cell's only cue is the direction tint markChange
      // puts on the number. The settle's fade on top of it read as a blink,
      // and the note (which changes when the user taps a lock) just cuts.
      id: "survival",
      key: "Season survival",
      ...season,
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
      <div class="strip__cell" data-cell="${cell.id}">
        <span class="strip__key">${escapeHtml(cell.key)}</span>
        <span class="strip__value"${cell.motionValue ? ` data-motion-key="strip-value-${cell.id}"` : ""}>${cell.raw ? cell.value : escapeHtml(cell.value)}</span>
        <span class="strip__note"${cell.motionNote ? ` data-motion-key="strip-note-${cell.id}"` : ""}>${cell.noteRaw ? cell.note : escapeHtml(cell.note)}</span>
      </div>`,
    )
    .join("");

  markChange(root, board.league, before, season.probability);
}

/**
 * Say which way the season number went rather than that it moved. The number
 * cuts to its new value and wears the colour of the direction for a beat (the
 * keyframes in motion.css), then eases back to ink. Nothing dims, nothing
 * shifts, no digits flicker: the strip is a fixed scoreboard line and stays one.
 *
 * Nothing to mark on a league's first paint, when the value is not a number
 * (Out, the dots) or when it did not change. Reduced motion needs no check
 * here: base.css switches the keyframes off and the number simply cuts.
 */
function markChange(root, league, from, to) {
  const el = root.querySelector('[data-cell="survival"] .strip__value');
  if (!el || typeof to !== "number") return;

  if (typeof from === "number" && from !== to) {
    pulse = {
      league,
      to,
      direction: to > from ? "is-rising" : "is-falling",
      startedAt: performance.now(),
    };
  }
  if (!pulse || pulse.league !== league || pulse.to !== to) return;
  const elapsed = performance.now() - pulse.startedAt;
  if (elapsed >= PULSE_MS) return;

  el.classList.add(pulse.direction);
  // A negative delay starts the fresh node's keyframe part way through, where
  // the one the render just destroyed had got to.
  if (elapsed > 0) el.style.animationDelay = `-${Math.round(elapsed)}ms`;
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
