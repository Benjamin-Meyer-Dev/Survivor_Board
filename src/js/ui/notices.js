/**
 * One-line banners: a message from app.js, storage mode, and any rule break
 * on the board. And, separately, how a run ended once it has.
 *
 * Shown on both screens, so `board` and `store` are optional: on the home
 * page there is no league open and a message from app.js is all there is to
 * say.
 *
 * A banner appearing pushes everything under it down, and one going takes the
 * room back, so neither is allowed to happen between one frame and the next:
 * the region crossfades its contents and travels between the two heights
 * (swapContents in ui/motion.js). The first paint is exempt - there was
 * nothing there to change - and so is a page arriving or leaving, which has a
 * move of its own going on.
 *
 * The season's end is not one of these. It used to be - the loudest banner of
 * the lot, above everything - and it was in the wrong place twice over: at the
 * top of the board it pushed the field, the strip and the card down by a
 * hundred and forty pixels to report a season that is over, and it left the
 * list of what actually happened with what was left. So renderReview draws it
 * in the drawer instead, along its bottom edge (see index.html), and the
 * banners here are only ever things that are still true of a board you can
 * still play.
 */

import { escapeHtml } from "../core/format.js";
import { prefersReducedMotion, swapContents } from "./motion.js";

/**
 * The markup each notices region is showing. Its own rather than patch.js's,
 * because the swap writes the region itself and a memo that did not know about
 * it would skip the write that put a banner back.
 */
const shown = new WeakMap();

export function renderNotices(root, { store = null, board = null, message = "" }) {
  const notices = [];

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

  const html = notices
    .map((text) => `<div class="notice notice--warn">${escapeHtml(text)}</div>`)
    .join("");

  if (!root) return;
  const before = shown.get(root);
  if (before === html) return;
  shown.set(root, html);

  // Nothing to move from, or a page change already moving everything: write it
  // and let the page's own entrance carry it in.
  const busy =
    root.closest(".shell")?.classList.contains("is-swapping") ||
    document.body.classList.contains("is-starting");
  if (before === undefined || busy || prefersReducedMotion()) {
    root.innerHTML = html;
    return;
  }
  swapContents(root, html);
}

/**
 * How the season ended, along the bottom of the drawer.
 *
 * The board above it is in review from here on: the run as it happened, with
 * nothing left to pick or lock, opened on the week it ended and going no
 * further than that week (lastWeekInPlay in app.js). There is no way back from
 * this short of the result itself changing.
 *
 * The drawer is emptied when this arrives, and this is what is left in it. The
 * bar goes, because nothing can be picked and so there is nothing to switch
 * between; the lists go with it, because neither of them is about a season
 * that is over. The sideline is a list you cannot pick from, and the bench a
 * list of teams you will not need. So the drawer holds the ending and nothing
 * else (app.js puts the rest away).
 *
 * Still on the bottom edge, which is where the list it replaces began: the run
 * reads down the board, and the ending
 * belongs at the end of it rather than above the season it is the last line
 * of. The band itself takes the whole of the drawer, because a chalkboard left
 * bare over three lines reads as something that failed to load rather than as
 * a board with nothing left to write on it.
 *
 * Shorter than the banner it replaces, because it is now spending the drawer's
 * room rather than the board's: the sentence that said the board is in review
 * is gone, which the disabled lock and the emptied drawer say for themselves,
 * and what is left is the three facts - when it ended, what ended it, and what
 * the run came to.
 *
 * @param {HTMLElement|null} root
 * @param {object|null} board Null, or a board that is still alive: either way
 *   the region is emptied.
 */
export function renderReview(root, board) {
  if (!root) return;
  const html = board?.eliminated ? reviewMarkup(board) : "";
  if (shown.get(root) === html) return;
  shown.set(root, html);
  root.innerHTML = html;
}

function reviewMarkup(board) {
  const { week, losses } = board.elimination;
  const label = board.weeks.find((entry) => entry.week === week)?.labelFull ?? `Week ${week}`;
  // What the team did, not what the pick did. `status.result` is the entry's
  // result, swapped for a losers pool (core/objective.js), so the pick that
  // ended the run there is a team that WON its game - and "Seahawks lost to
  // Patriots" was the one sentence on the board that had the score backwards.
  const beat = board.rules?.objective === "lose";
  const what = losses.length
    ? losses
        .map((loss) => `${loss.team} ${beat ? "beat" : "lost to"} ${loss.opponent}`)
        .join(" and ")
    : "";
  const { won, lost } = board.record;
  const used = board.buyBack?.used ?? 0;
  const buyBacks = used ? ` · ${used} buy back${used === 1 ? "" : "s"} used` : "";
  // The three facts on one line, in the order they are asked in: when, what,
  // and what it came to. A week that ended with no loss on the board - a slot
  // left empty past its kickoff - simply says nothing in the middle.
  const line = [label, what, `Final ${won}-${lost}${buyBacks}`].filter(Boolean).join(" · ");

  return `<div class="review" role="status">
    <span class="review__eyebrow">Season over</span>
    <strong class="review__title">Eliminated in week ${week}</strong>
    <span class="review__line">${escapeHtml(line)}</span>
  </div>`;
}
