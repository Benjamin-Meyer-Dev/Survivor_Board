/**
 * The call: the week being looked at, and the one thing you can do about it.
 *
 * Under the field sits the week's date and tags, with the one action at the
 * end of that row as a mark in the flag's colour: lock the pick in, or take the
 * coach's call when the slot is empty. The other side of the game sits beside
 * it as a flip. Then the slot - or two, in a pool that takes two picks. The
 * actions are marks rather than words so the drawer under the card gets the
 * room; the slot's eyebrow says in words what state it is in.
 *
 * A slot is one of three things: empty, with the coach's suggestion pencilled
 * in; picked, a team the users chose but have not committed to; or locked. The
 * coach never fills a slot.
 *
 * One slot is on the card at a time, whatever the pool. A week that takes more
 * than one pick pages between them from a stepper on the slot's own head row -
 * "1 of 2", an arrow either side - and the slot on the card is the slot the
 * sideline is filling, so there is one answer to "which pick am I working on"
 * rather than a bracket saying it about one of two cards.
 *
 * They used to stand side by side, and it cost the pool that has them the
 * thing the card is for. Half a card is 142 pixels on a phone: the name came
 * down a size and still wrapped, the game line broke over three lines, the
 * tiles gave up their keys, and the card came out 33 pixels taller than an NFL
 * one on a phone and 95 on a desktop. The coach's case is handed what the
 * field and the card leave over (layout.css), so every one of those pixels was
 * off the chart - the college pool, which is the one with two picks to weigh,
 * was reading them in the smallest chart on the board. Paged, both pools draw
 * the same card and the same chart, and a week that ever takes three picks is
 * a longer count in the same stepper rather than a third column nothing would
 * fit in.
 *
 * The fallbacks behind the calls are not repeated here. They are marked where
 * they can be tapped - on the team list's own rows, each carrying the rank the
 * coach gives it (ui/sideline.js) - and a readout with no rows to spare must
 * not spend one saying the same thing twice.
 *
 * Every slot has the same rows in the same order - head, marks, team, matchup,
 * tiles - so a pick, a lock or a page changes what the rows say without moving
 * anything under the thumb that just tapped it. The head carries the eyebrow
 * and, where there is more than one pick, the pager. The marks (how safe the
 * coach rates the pick, whether it was the coach's call) take the line under
 * it. The result, once it is in, is not one of them - it is paint rather than
 * chalk, and it stands at the far end of that row on its own (resultStamp).
 * The game and its numbers hold the foot of the slot.
 *
 * Handlers are injected; this module knows nothing about the store.
 */

import {
  formatSpread,
  formatPercent,
  formatMatchup,
  formatKickoff,
  escapeHtml,
} from "../core/format.js";
import { TIER_LABEL } from "../core/probability.js";
import { delegate } from "./events.js";
import { frame, reconcile } from "./patch.js";

/** What an open slot says while the optimiser has not reported yet. */
const WORKING = "Working out the path…";

const LOCK_OPEN = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.6-1.2" /></svg>`;
const LOCK_SHUT = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>`;
/* Two arrows passing, one each way. A unit further apart than they read
   naturally, because at 17px the heads met in the middle and the pair became
   one zigzag: the tip of each head reaches four units off its own shaft, and
   with the stroke on top of that there was nothing between them. */
const FLIP = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h13m-4-4 4 4-4 4M21 18H8m4 4-4-4 4-4" /></svg>`;
/** Taking the coach's call: a check. */
const TAKE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7" /></svg>`;
/* The result, once the game is in the books. The check is the take's, drawn
   again at the weight a stamp wants; the cross is its answer. */
const WON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 13 5.5 5.5L20 5.5" /></svg>`;
const LOST = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6 18 18M18 6 6 18" /></svg>`;
/* The pager's two ways. Chevrons rather than arrows: the card's one arrow pair
   is the flip, which means the other side of this game, and a pager that wore
   the same mark would be reading as a second flip. */
const PREV = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7" /></svg>`;
const NEXT = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>`;

/**
 * @param {HTMLElement} root
 * @param {object} board Result of buildBoard().
 * @param {number} viewWeek The week being looked at (1-based).
 * @param {number} activeSlot Which of the week's slots the sideline is filling.
 * @param {{onAction:Function, onSlot:(slot:number)=>void, canWrite:boolean}} handlers
 */
export function renderCall(root, board, viewWeek, activeSlot, handlers) {
  const week = board.weeks.find((entry) => entry.week === viewWeek) ?? board.weeks[0];
  const active = slotInRange(activeSlot, week);

  // Bound to the card's root, which no render replaces: the week's markup is
  // rewritten on every pick and lock, and a listener per control meant a fresh
  // closure for each of them every time (see ui/events.js).
  delegate(root, "click", "[data-action]", (button) => {
    handlers.onAction({
      action: button.dataset.action,
      week: Number(button.dataset.week),
      slot: Number(button.dataset.slot),
      team: button.dataset.team,
    });
  });

  // The pager's two steps. Real buttons, so Enter and Space are the browser's
  // to handle - the slot used to be a div wearing a button's clothes and
  // needed its own keydown for them.
  delegate(root, "click", "[data-activate]", (step) => {
    handlers.onSlot(Number(step.dataset.activate));
  });

  // The card's frame is kept and its parts patched (ui/patch.js): the head
  // when the week or its action changes, and each slot on its own. A lock
  // rewrites the slot it locked and leaves the other where it is, and the
  // search landing a moment later - which changes nothing about a slot - now
  // leaves the slot's feedback playing rather than cutting it dead.
  const box = frame(root, `<div class="call"><div class="call__box"></div></div>`).querySelector(
    ".call__box",
  );
  reconcile(
    box,
    `<div class="call__head" data-key="head">
      <span class="call__when${isNow(week, board) ? " call__when--now" : ""}">${escapeHtml(whenLine(week, board))}</span>
      <span class="call__tags">${weekTags(week, board)}</span>
      ${actionsMarkup(week.picks[active], board, handlers.canWrite)}
    </div>
    <div class="call__slots" data-key="slots"></div>`,
  );
  const slots = box.querySelector(".call__slots");
  reconcile(slots, slotsMarkup(week, board, active));
  holdEveryWeek(root, slots, board);
}

/**
 * Which slot a card is showing, given the one the board thinks is in hand.
 *
 * A week can hold fewer picks than the week before it - the last week of a
 * pool that ends mid-season, or a rules change - and the slot in hand is
 * settled for the board rather than per week.
 */
function slotInRange(slot, week) {
  return Math.min(Math.max(slot, 0), week.picks.length - 1);
}

/** The one slot the card is showing. */
function slotsMarkup(week, board, active) {
  return slotMarkup(week.picks[active], board, week.picks.length, active);
}

/** The markup a card's floor was measured from. */
const held = new WeakMap();

/** What each card is currently showing, for a re-measure off a resize. */
const latest = new WeakMap();

/** Cards whose width is already being watched. */
const watching = new WeakSet();

/**
 * Stand the card at the same height in every week of the season.
 *
 * The coach's case above the card is handed whatever the field and the card
 * leave over (layout.css). So the card's height is the chart's height: a week
 * whose name wraps to two lines, or whose kickoff is known and takes a line of
 * its own, hands the case a shorter box than the week beside it does. Turning
 * the week then re-laid the whole chart - the plot rescaled, every mark and
 * both routes moved with it, and within a fold of one of the case's gates the
 * pricing chain itself came and went. Nothing about the season had changed;
 * the card had. It read as the board working the season out again every time
 * the week turned, which is the one thing the chart is built not to do (the
 * band moves, the season holds still - see ui/coach.js).
 *
 * The card is the part whose contents are about the week, so the card is the
 * part that reserves the room. The slots grow to the floor and the game line
 * and tiles stay at their foot, which is where they already stand.
 *
 * Measured rather than assumed. Two lines for the name and one for the kickoff
 * would hold every week of every pool, and would spend the room on pools that
 * never needed it - an NFL card is the same height in all eighteen weeks of a
 * 430 phone, and would have given up fifty pixels of chart for a wrap that
 * never happens. So every week is laid out once, off the page and at the
 * card's own width, and the floor is the tallest of them. It is keyed by the
 * markup it measured, so it is taken again when the season's names change and
 * not on every tap.
 *
 * Every pick of every week, not every week: the card shows one pick at a time
 * now, and a floor that had only ever seen each week's first pick would let
 * the card change height when the pager moved - which is the same jump under
 * the chart, asked for by the same hand, one control along.
 */
function holdEveryWeek(root, slots, board) {
  // The live card only. A week staged for a swipe is rendered into a detached
  // root (stageWeek in app.js) and then laid over the edge of this one, where
  // it inherits the floor already measured here - a copy that is about to
  // travel across the screen has nothing to measure and no time to do it in.
  if (!root.isConnected) return;

  latest.set(root, { slots, board });
  if (!watching.has(root)) {
    watching.add(root);
    // A rotation changes the width without a render, and a floor measured at
    // the other width is a card held at the wrong height with nothing coming
    // to correct it.
    new ResizeObserver(() => measureEveryWeek(root)).observe(root);
    // The display face is fetched rather than shipped (index.html, swap), so
    // the first measurement can be of a name in the fallback, which is not the
    // name that ends up drawn.
    document.fonts?.ready?.then(() => measureEveryWeek(root));
  }
  measureEveryWeek(root);
}

function measureEveryWeek(root) {
  const { slots, board } = latest.get(root) ?? {};
  // Raised, the card is trimmed to its name alone and the case is not on the
  // screen to be steadied (components.css drops the floor with it), so there
  // is nothing to measure and the floor already taken is still the right one.
  if (!slots?.isConnected || root.closest(".board")?.classList.contains("is-raised")) return;
  const width = slots.clientWidth;
  if (!width) return;

  const markup = board.weeks
    .flatMap((week) =>
      week.picks.map(
        (_, slot) => `<div class="${slots.className}">${slotsMarkup(week, board, slot)}</div>`,
      ),
    )
    .join("");
  const key = `${width}|${markup}`;
  if (held.get(root) === key) return;

  // One box, one layout: every week stands in it at once and is read in a
  // single pass, and it is gone again before the frame it was built in goes
  // out - nothing is ever painted, and nothing it holds can be tabbed to.
  const probe = document.createElement("div");
  probe.className = "call__probe";
  probe.setAttribute("aria-hidden", "true");
  probe.style.width = `${width}px`;
  probe.innerHTML = markup;
  slots.parentElement.append(probe);
  const floor = Math.max(0, ...[...probe.children].map((week) => week.offsetHeight));
  probe.remove();

  held.set(root, key);
  // On the card's own root rather than on the row it floors, so the week a
  // swipe stages inside it stands at the same height as the week it is
  // replacing.
  root.style.setProperty("--call-floor", `${Math.round(floor)}px`);
}

function isNow(week, board) {
  return week.week === board.currentWeek && !board.eliminated;
}

/** "Wk 01 · Sep 13, 2026 · on the clock", or how far off the week is. */
function whenLine(week, board) {
  const stamp = `Wk ${String(week.week).padStart(2, "0")} · ${week.labelFull}`;
  if (board.eliminated) {
    // The week it ended has the chip beside it saying so, in the paint it
    // deserves. The line said it a second time in chalk, and the two together
    // were longer than the row: the line gives way first, so what a person
    // actually read was the date and half the word "eliminated", with the
    // whole of it in a box to the right of the cut.
    if (week.week === board.eliminatedWeek) return stamp;
    if (week.week > board.eliminatedWeek) return `${stamp} · not played`;
    return `${stamp} · played`;
  }
  const away = week.week - board.currentWeek;
  if (away === 0) return `${stamp} · on the clock`;
  if (away < 0) return `${stamp} · played`;
  return `${stamp} · ${away} week${away === 1 ? "" : "s"} out`;
}

function weekTags(week, board) {
  const tags = [];
  // The week on the clock is already said by the live dot on the when-line;
  // a tag saying it again only cost the drawer a row.
  if (board.eliminated && week.week === board.eliminatedWeek) {
    tags.push('<span class="chip chip--danger">Eliminated</span>');
  }
  return tags.join("");
}

/**
 * One slot. The rows are the same whatever it holds: who the team belongs to,
 * the team, its game, its numbers. Where the week takes more than one pick the
 * head row carries the pager that reaches the others.
 */
function slotMarkup(pick, board, count, active) {
  const { status } = pick;
  const shown = pick.team ? pick : pick.suggestion;
  const state = pick.team ? (status.locked ? "locked" : "picked") : "empty";
  const moot = board.eliminated && pick.week > board.eliminatedWeek;
  const pending = !shown && board.recommendationPending && pick.week >= board.currentWeek;

  const eyebrow = pick.team
    ? status.locked
      ? "Locked in"
      : "Your pick"
    : pick.suggestion
      ? "Coach suggests"
      : moot
        ? "Not played"
        : "Open slot";

  const blank = moot
    ? { team: "Season over", text: `The run ended in week ${board.eliminatedWeek}.` }
    : board.eliminated
      ? { team: "No pick", text: "Nothing was picked here." }
      : {
          team: pending ? WORKING : "No pick yet",
          text: pending ? "The coach is planning the season." : "Pick a team from the sideline.",
        };

  // The coach's badge stays on a locked pick: the board clears isRecommended
  // once a lock is a constraint the coach plans around, but it keeps the call
  // the coach made before the lock (coachCall), which is what the badge means.
  const coached =
    pick.team && (pick.isRecommended || (status.locked && pick.coachCall?.team === pick.team));
  const marks = shown
    ? `<span class="chip chip--${shown.tier}">${TIER_LABEL[shown.tier]}</span>` +
      (coached ? '<span class="chip chip--rec" title="This was the coach’s call">Coach</span>' : "")
    : "";

  // What the slot is showing, for the settle that plays when it changes under
  // no tap of yours (playDataUpdates in app.js). Which pick is on the card is
  // deliberately not in it: paging is a tap, and the card answering a tap is
  // not the board changing its mind.
  const signature = [
    state,
    shown?.team ?? "",
    shown?.tier ?? "",
    shown?.spread ?? "",
    shown?.source ?? "",
    status.result ?? "",
    coached ? "coach" : "",
  ].join("|");

  return `
    <div class="call__slot call__slot--${state}"
         data-week="${pick.week}" data-slot="${pick.slot}" data-key="${pick.week}-${pick.slot}"${shown ? ` data-tier="${shown.tier}"` : ""}
         data-motion-key="slot-${pick.week}-${pick.slot}"
         data-motion-signature="${escapeHtml(signature)}">
      <div class="call__slot-head">
        <div class="call__eyebrow${pick.suggestion && !pick.team ? " call__eyebrow--coach" : ""}">${eyebrow}</div>
        ${pagerMarkup(count, active)}
      </div>
      <div class="call__marks">${resultStamp(status)}${marks}</div>
      ${
        shown
          ? `<div class="call__team">${escapeHtml(shown.team)}</div>
             <div class="call__matchup">${escapeHtml(formatMatchup(shown.site, shown.opponent))} · ${escapeHtml(shown.conference)}${kickoffMarkup(shown)}${sourceMarkup(shown)}</div>`
          : `<div class="call__team call__team--blank">${escapeHtml(blank.team)}</div>
             <div class="call__matchup">${escapeHtml(blank.text)}</div>`
      }
      ${tiles(shown, board)}
    </div>`;
}

/**
 * The pager, at the end of the slot's head row.
 *
 * A count and a step either side, which is the stepper this app already uses
 * for a number you nudge (the pool's own rules, ui/settings.js). It says where
 * you are as well as offering the way out of it: "1 of 2" is the whole of what
 * a person needs to know about a week with two picks in it, and it reads the
 * same for a week with four.
 *
 * The ends hold rather than wrap, as the season's own ends do under a drag
 * (ui/swipe.js). A pool with two picks could have been a toggle either arrow
 * would work, and it would be a different control from the one a three-pick
 * pool gets - a stepper that counts to two is still a stepper.
 *
 * Nothing at all when the week takes one pick: a card that says "1 of 1" is a
 * control with nowhere to go, and the NFL card would be carrying the college
 * pool's furniture. The row it rides is there in both, so both cards are the
 * same height either way.
 */
function pagerMarkup(count, active) {
  if (count < 2) return "";
  const step = (to, icon, words) => {
    const off = to < 0 || to >= count;
    return `<button type="button" class="call__page"${off ? " disabled" : ` data-activate="${to}"`}
        aria-label="${escapeHtml(words)}" title="${escapeHtml(words)}">${icon}</button>`;
  };
  return `<div class="call__pager">
      ${step(active - 1, PREV, "The pick before this one")}
      <span class="call__count" aria-live="polite">${active + 1} of ${count}</span>
      ${step(active + 1, NEXT, "The next pick this week")}
    </div>`;
}

/**
 * The result, at the far end of the marks row.
 *
 * Every other mark on a slot is chalk: an outlined tag for how safe the coach
 * rates the pick, another for whether the pick was the coach's. Those are
 * opinions, and the result was drawn as a third one - a won pick wore SAFE and
 * WON side by side in the same mint outline at the same size, a forecast and a
 * fact with only the word between them. So the result is the one mark on a
 * slot that is paint rather than chalk: filled in its own colour with the word
 * cut out of it, carrying the check or the cross a scoreboard would give it,
 * and notched down its leading edge so the shape alone says what it is.
 *
 * It is written first and drawn last. First in the markup because it is the
 * one thing about a played week worth hearing first; last on the row because
 * the stylesheet takes it out of the flow and hangs it on the right-hand rule,
 * where a fact does not queue behind opinions and costs the card no height.
 */
function resultStamp(status) {
  if (status.result !== "W" && status.result !== "L") return "";
  const won = status.result === "W";
  return `<span class="call__result call__result--${won ? "won" : "lost"}" title="Final score"
      >${won ? WON : LOST}<span class="call__result-word">${won ? "Won" : "Lost"}</span></span>`;
}

/**
 * The two numbers: the spread, and the chance the pick carries the week. With
 * nothing to price they still stand, blank, so the card keeps its height. In a
 * losers pool the second is the chance the team loses (see core/objective.js),
 * and its name says so.
 *
 * Where the line came from used to be a third tile here, and a pool that takes
 * two picks a week - which is every college pool - could not fit it: half a
 * card is a hundred and thirty pixels, and three keys in the display face do
 * not go into it at any size worth reading. So it stands on the game line
 * instead (sourceMarkup), which is the line it qualifies and has the width for
 * it, and the numbers get the row to themselves in both layouts.
 *
 * The same width answers the second key twice over. Two tiles on half a card
 * leave it about forty-five pixels on a narrow phone, and WIN PROB is sixty
 * three of them at the size the rest of the board's keys are set in - it was
 * painting over its own rule. The stylesheet buys back what the padding and
 * the tracking are worth (.call__slots--two .tile); the word gives up the rest
 * of it. WIN over 98.9% says what WIN PROB says, because the figure under it
 * is already a probability and there is nothing else it could be.
 *
 * Both words are written and the stylesheet picks one, rather than the short
 * one being chosen here: which of them fits is a question about how wide the
 * screen is, and this module counts slots. A desktop and a phone held sideways
 * have room for the whole word in two slots, and keep it.
 */
function tiles(line, board) {
  const losers = board?.rules?.objective === "lose";
  return `
    <div class="call__tiles">
      ${tile("Spread", line ? formatSpread(line.spread) : "—", line?.tier)}
      ${tile(
        losers ? "Loss prob" : "Win prob",
        line ? formatPercent(line.winProb) : "—",
        line?.tier,
        losers ? "Loss" : "Win",
      )}
    </div>`;
}

/**
 * @param {string} [short] A shorter key for a tile with no room for the long
 *   one. Only one of the two is ever in the layout, so only one is ever read
 *   out (.tile__key-short in components.css).
 */
function tile(key, value, tier, short) {
  const label = short
    ? `<span class="tile__key-long">${escapeHtml(key)}</span><span class="tile__key-short">${escapeHtml(short)}</span>`
    : escapeHtml(key);
  return `<div class="tile">
    <span class="tile__key">${label}</span>
    <span class="tile__value${tier ? ` confidence--${tier}` : ""}">${escapeHtml(value)}</span>
  </div>`;
}

/**
 * The actions: the flip and the one action, for the slot the sideline is
 * filling, as marks whose words are the tooltip and the accessible name.
 * Locking commits a pick; on an empty slot the action takes the coach's call,
 * which then becomes a pick to lock. Disabled when there is nothing to do, and
 * once a result is in, when the lock is history rather than a choice.
 */
function actionsMarkup(pick, board, canWrite) {
  const { status } = pick;
  const shown = pick.team ? pick : pick.suggestion;
  const moot = board.eliminated && pick.week > board.eliminatedWeek;
  const later = pick.week > board.currentWeek ? ` · wk ${pick.week}` : "";

  let lock;
  if (moot) {
    lock = button({ label: "Not played", icon: LOCK_OPEN, disabled: true });
  } else if (board.eliminated) {
    lock = button({
      label: status.locked ? "Locked in · season over" : "Season over",
      icon: status.locked ? LOCK_SHUT : LOCK_OPEN,
      on: status.locked,
      disabled: true,
    });
  } else if (status.result) {
    lock = button({
      label: `Final · ${status.result === "W" ? "won" : "lost"}`,
      icon: LOCK_SHUT,
      on: true,
      disabled: true,
    });
  } else if (status.locked) {
    const moved = lineMove(pick);
    lock = button({
      label: "Locked in · " + moved.words + " · tap to unlock",
      icon: LOCK_SHUT,
      on: true,
      shift: moved.shift,
      action: "lock",
      pick,
      disabled: !canWrite,
      title: "Locked in. " + moved.sentence + " Tap to unlock",
    });
  } else if (pick.team) {
    lock = button({
      label: `Lock in the ${pick.team}`,
      icon: LOCK_OPEN,
      go: true,
      action: "lock",
      pick,
      disabled: !canWrite,
    });
  } else if (pick.suggestion) {
    lock = button({
      label: `Take the ${pick.suggestion.team}${later}`,
      icon: TAKE,
      take: true,
      action: "pick",
      pick,
      team: pick.suggestion.team,
      disabled: !canWrite,
      title: "Put the coach's call in this slot",
    });
  } else {
    const pending = board.recommendationPending && pick.week >= board.currentWeek;
    lock = button({
      label: pending ? WORKING : "Pick a team from the sideline",
      icon: LOCK_OPEN,
      disabled: true,
    });
  }

  // The reverse side is a shortcut only when it is a legal option right now.
  const reverse =
    canWrite && shown && !status.locked && !status.result && !board.eliminated
      ? pick.options.find(
          (option) =>
            option.team === shown.opponent && option.opponent === shown.team && !option.disabled,
        )
      : null;
  const flip = `<button type="button" class="call__flip"
      ${reverse ? `data-action="pick" data-week="${pick.week}" data-slot="${pick.slot}" data-team="${escapeHtml(reverse.team)}"` : "disabled"}
      aria-label="${reverse ? `Flip to ${escapeHtml(reverse.team)}` : "No other side to flip to"}"
      title="${reverse ? `Pick the other side: ${escapeHtml(reverse.team)}` : "Pick the other side of this game"}">${FLIP}</button>`;

  return `<div class="call__actions">${flip}${lock}</div>`;
}

function button({
  label,
  icon = "",
  on = false,
  go = false,
  take = false,
  shift = null,
  action = null,
  pick = null,
  team = null,
  disabled = false,
  title = "",
}) {
  const classes = [
    "call__lock",
    on ? "call__lock--on" : "",
    go ? "call__lock--go" : "",
    take ? "call__lock--take" : "",
    shift ? `call__lock--${shift}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const data = action
    ? ` data-action="${action}" data-week="${pick.week}" data-slot="${pick.slot}"${team ? ` data-team="${escapeHtml(team)}"` : ""}`
    : "";
  return `<button type="button" class="${classes}"${data}${disabled ? " disabled" : ""}
      ${action === "lock" ? ` aria-pressed="${on}"` : ""} aria-label="${escapeHtml(label)}"
      title="${escapeHtml(title || label)}">${icon}</button>`;
}

/**
 * Which way the line has gone since the lock, for the ring on the lock and
 * its words. The board signs the move so a positive number is the pick's way
 * in either pool (core/plan.js, sinceLock); a lock that saved no line, or a
 * line that has not moved, is flat.
 */
function lineMove(pick) {
  const points = pick.sinceLock;
  if (!Number.isFinite(points) || points === 0) {
    return { shift: "flat", words: "line unchanged", sentence: "The line has not moved." };
  }
  const size = Math.abs(points) + (Math.abs(points) === 1 ? " pt" : " pts");
  return points > 0
    ? {
        shift: "up",
        words: "line " + size + " your way",
        sentence: "The line has moved " + size + " your way.",
      }
    : {
        shift: "down",
        words: "line " + size + " against you",
        sentence: "The line has moved " + size + " against you.",
      };
}

/** When the game kicks off, after the matchup, when the feed has timed it. */
/**
 * When the game kicks off, after the game itself.
 *
 * The separator is an element rather than a character because it is not always
 * wanted. In a two-pick week the slot is half a card wide and the game and its
 * kickoff never fit one line; the kickoff wraps whole, since it must never
 * break inside itself, and the dot was left hanging at the end of the line
 * above. There the CSS drops the dot and gives the kickoff its own line, so the
 * break is the separator. In a one-pick week the pair fits and the dot stays.
 */
function kickoffMarkup(line) {
  const when = formatKickoff(line.kickoff);
  if (!when) return "";
  return `<span class="call__sep"> · </span><span class="call__kickoff">${escapeHtml(when)}</span>`;
}

/**
 * Where the number under the game came from: a line the books are making, or
 * the model's own projection of one. Only the week on the clock is ever priced
 * by the market, and in college not even all of that week is - about half the
 * slate carries no line - so a card that does not say which it is showing is
 * asking to be read as a market number that is not one.
 *
 * It rides the game line rather than the tiles because it is not a number: it
 * is what the numbers are, and it says so in the quieter chalk. It wraps to
 * its own line in a two-pick week exactly as the kickoff does, and for the
 * same reason - see kickoffMarkup above.
 */
function sourceMarkup(line) {
  const words = line.source === "market" ? "Market line" : "Projected line";
  return `<span class="call__sep"> · </span><span class="call__source">${words}</span>`;
}
