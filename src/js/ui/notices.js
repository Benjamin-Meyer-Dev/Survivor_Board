/**
 * One-line banners: a message from app.js, storage mode, and any rule break
 * on the board.
 *
 * Shown on both screens, so `board` and `store` are optional: on the home
 * page there is no league open and a message from app.js is all there is to
 * say.
 */

import { escapeHtml } from "../core/format.js";
import { paint } from "./patch.js";

export function renderNotices(root, { store = null, board = null, message = "" }) {
  const notices = [];
  // Said once, above every view: the run is over and the board is in review.
  const banner = board?.eliminated ? reviewBanner(board) : "";

  if (message) notices.push(message);

  if (store && !store.shared) {
    notices.push(
      "Shared saving is off, so picks and locks stay on this device only. The coach's suggestions, the odds and the results are still current.",
    );
  }

  // A store that will not take a write. Not reachable in the normal case - a
  // device holding a league's code may write to it - so this is here to say
  // something rather than to grey out every button and explain nothing.
  if (store && !store.canWrite) {
    notices.push("You are viewing in read-only mode: this device cannot save to this league.");
  }

  for (const conflict of board?.conflicts ?? []) {
    notices.push(
      `Rule break: ${conflict.team} is now picked in both week ${conflict.weeks[0]} and week ${conflict.weeks[1]}. Swap one of them.`,
    );
  }

  paint(
    root,
    banner +
      notices.map((text) => `<div class="notice notice--warn">${escapeHtml(text)}</div>`).join(""),
  );
}

/**
 * How the season ended. The board beneath it is in review from here on: the
 * run as it happened, with nothing left to pick or lock, opened on the week it
 * ended. There is no way back from this short of the result itself changing.
 */
function reviewBanner(board) {
  const { week, losses } = board.elimination;
  const label = board.weeks.find((entry) => entry.week === week)?.labelFull ?? `Week ${week}`;
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
