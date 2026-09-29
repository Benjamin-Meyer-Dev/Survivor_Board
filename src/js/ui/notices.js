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

import { escapeHtml, formatPercent, formatSpread } from "../core/format.js";
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
 * It tells the story the readout above it cannot. That already says the week
 * and the record - Eliminated, Wk 1, 0-1 - so this is the drive and the play
 * that ended it. The band is the end zone the run never reached, painted as
 * the field's are and carrying the field's own SURVIVE, struck out. Across it
 * the season as a drive chart from kickoff, stopped with a chalk cross on the
 * week it ended; the game that did it, with the margin, as the headline; and
 * under it a box score - the line, the chance the week gave you, how far the
 * drive got, and what the coach had called instead.
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
  const ended = board.weeks.find((entry) => entry.week === week) ?? null;
  const gameOf = (team) => ended?.optionByTeam?.get(team) ?? null;
  const byOf = (margin) =>
    Number.isFinite(margin) && margin !== 0 ? ` by ${Math.abs(margin)}` : "";

  // What the team did, not what the pick did. `status.result` is the entry's
  // result, swapped for a losers pool (core/objective.js), so the pick that
  // ended the run there is a team that WON its game - and "Seahawks lost to
  // Patriots" was the one sentence on the board that had the score backwards.
  const beat = board.rules?.objective === "lose";
  const title = losses.length
    ? losses
        .map(
          (loss) =>
            `${loss.team} ${beat ? "beat" : "lost to"} ${loss.opponent}${byOf(gameOf(loss.team)?.margin)}`,
        )
        .join(" and ")
    : `Eliminated in week ${week}`;

  // The box score under the headline: a label over a figure, the way the
  // readout above sets its own, so the ending reads as the board's last stat
  // line rather than a sentence about it.
  const stats = [];

  // The line the game was played at - what the market made of the pick, which
  // is what makes the result an upset - and the chance the week gave you.
  const spreads = losses
    .map((loss) => gameOf(loss.team)?.spread)
    .filter(Number.isFinite)
    .map((spread) => (spread === 0 ? "PK" : formatSpread(spread)));
  if (spreads.length) stats.push({ label: "The line", value: escapeHtml(spreads.join(" / ")) });
  if (Number.isFinite(ended?.pathWinProb)) {
    stats.push({ label: "Your shot", value: escapeHtml(formatPercent(ended.pathWinProb, 1)) });
  }

  // How far the drive got, out of how far it had to go.
  const survived = board.weeks.filter((entry) => entry.week < week).length;
  stats.push({ label: "Survived", value: `${survived} of ${board.weeks.length}` });

  // The road not taken: what the coach had called that week (week.recommended,
  // the call as it stood when the slot was locked) wherever it was not the
  // lock, each with whether that pick would have come through its game.
  const locked = new Set(losses.map((loss) => loss.team));
  const calls = ended?.recommended ?? [];
  const others = calls.filter((call) => !locked.has(call.team));
  if (calls.length) {
    stats.push({
      label: "Coach had",
      value: others.length
        ? others
            .map(
              (call) =>
                `${escapeHtml(call.team)}${call.result ? MARKS[call.result === "W" ? "won" : "lost"] : ""}`,
            )
            .join(" ")
        : "Same pick",
      team: true,
    });
  }

  const used = board.buyBack?.used ?? 0;
  if (used) stats.push({ label: "Buy backs", value: `${used} used` });

  const last = board.weeks.at(-1)?.week ?? week;

  // "Season over" is written into the turf nobody played on (driveOf), which
  // a screen reader does not see, so it is said to one ahead of the headline.
  // Behind it all, the word the far end zone carries on the field above, which
  // is where the drive was going, struck out.
  return `<div class="review" role="status">
    <span class="review__mark" aria-hidden="true">Survive</span>
    ${driveOf(board)}
    <strong class="review__title"><span class="u-visually-hidden">Season over in week ${week} of ${last}: </span>${escapeHtml(title)}</strong>
    <dl class="review__stats">${stats
      .map(
        (stat) =>
          `<div class="review__stat${stat.team ? " review__stat--team" : ""}"><dt>${stat.label}</dt><dd>${stat.value}</dd></div>`,
      )
      .join("")}</dl>
  </div>`;
}

/** Whether a pick the coach had would have come through its game. */
const MARKS = {
  won: '<svg class="review__verdict review__verdict--won" viewBox="0 0 12 12" width="12" height="12" aria-label="would have survived" role="img"><path d="M2.5 6.5l2.5 2.5 4.5-5.5" /></svg>',
  lost: '<svg class="review__verdict review__verdict--lost" viewBox="0 0 12 12" width="12" height="12" aria-label="out too" role="img"><path d="M3 3l6 6M9 3l-6 6" /></svg>',
};

/**
 * The season as a drive chart: the field at the top of the board again, end
 * zone to end zone, a yard a week. The drive runs from kickoff through every
 * week survived - orange where the pool bought a loss back - and stops on a
 * chalk cross at the week that ended it. The yards past it were never played,
 * and "Season over" is chalked across them where there is the room.
 */
function driveOf(board) {
  const bought = new Set(board.buyBack?.spent ?? []);
  const cross =
    '<svg viewBox="0 0 12 12" width="12" height="12" focusable="false"><path d="M2 2l8 8M10 2l-8 8" /></svg>';
  const played = board.weeks
    .filter((entry) => entry.week <= board.eliminatedWeek)
    .map((entry) =>
      entry.week === board.eliminatedWeek
        ? `<i class="review__yard review__yard--out">${cross}</i>`
        : `<i class="review__yard review__yard--${bought.has(entry.week) ? "bought" : "run"}"></i>`,
    )
    .join("");
  const ahead = board.weeks.filter((entry) => entry.week > board.eliminatedWeek).length;
  const rest = ahead
    ? `<span class="review__rest" style="flex-grow:${ahead}">${'<i class="review__yard"></i>'.repeat(ahead)}<b class="review__rest-label">Season over</b></span>`
    : "";
  return `<span class="review__drive" aria-hidden="true"><i class="review__zone"></i>${played}${rest}<i class="review__zone"></i></span>`;
}
