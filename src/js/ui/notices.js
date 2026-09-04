/**
 * One-line banners: a message from app.js, storage mode, and any rule break
 * on the board.
 */

import { escapeHtml } from "../core/format.js";

export function renderNotices(root, { store, board, message }) {
  const notices = [];
  // Said once, above every view: the run is over and the board is in review.
  const banner = board.eliminated ? reviewBanner(board) : "";

  if (message) notices.push(message);

  if (!store.shared) {
    notices.push(
      "Shared saving is off, so picks and locks stay on this device only. The coach's suggestions, the odds and the results are still current.",
    );
  }

  // Unreachable once the passcode gate has passed, since the same digest opens
  // the store. Kept so a mismatch says something rather than greying out buttons.
  if (!store.canWrite) {
    notices.push("You are viewing in read-only mode. This device's passcode does not match.");
  }

  for (const conflict of board.conflicts) {
    notices.push(
      `Rule break: ${conflict.team} is now picked in both week ${conflict.weeks[0]} and week ${conflict.weeks[1]}. Swap one of them.`,
    );
  }

  root.innerHTML =
    banner +
    notices.map((text) => `<div class="notice notice--warn">${escapeHtml(text)}</div>`).join("");
}

/**
 * How the season ended. The board beneath it is in review from here on: the
 * run as it happened, with nothing left to pick or lock, opened on the week it
 * ended. There is no way back from this short of the result itself changing.
 */
function reviewBanner(board) {
  const { week, losses } = board.elimination;
  const label = board.weeks[week - 1]?.labelFull ?? `Week ${week}`;
  const what = losses.length
    ? losses.map((loss) => `${loss.team} lost to ${loss.opponent}`).join(" and ") + "."
    : "";
  const { won, lost } = board.record;
  const used = board.buyBack?.used ?? 0;
  const buyBacks = used ? `, ${used} buy back${used === 1 ? "" : "s"} used` : "";

  return `<div class="notice notice--out" role="status">
    <span class="notice__eyebrow">Season over</span>
    <strong class="notice__title">Eliminated in week ${week}</strong>
    <span class="notice__text">${escapeHtml(`${label}. ${what} Final record ${won}-${lost}${buyBacks}. The board is in review: the run as it happened, with nothing left to pick or lock.`)}</span>
  </div>`;
}
