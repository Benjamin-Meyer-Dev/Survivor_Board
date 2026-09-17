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
 * coach never fills a slot. In a two-pick week the slot the sideline is filling
 * wears the bracket, and tapping the other hands it the sideline.
 *
 * The fallbacks behind the calls are not repeated here. They are marked where
 * they can be tapped - on the team list's own rows, each carrying the rank the
 * coach gives it (ui/sideline.js) - and a readout with no rows to spare must
 * not spend one saying the same thing twice.
 *
 * Every slot has the same rows in the same order - eyebrow, marks, team,
 * matchup, tiles - so a pick or lock changes what the rows say without moving
 * anything under the thumb that just tapped it. The marks (how safe the coach
 * rates the pick, whether it was the coach's call, the result) take their own
 * line under the eyebrow rather than sharing it: in a two-pick week the slot
 * is half a card wide and the row could not hold both. The game and its
 * numbers hold the foot of the slot, so two slots side by side line up there
 * whatever the rows above them come to.
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

/**
 * @param {HTMLElement} root
 * @param {object} board Result of buildBoard().
 * @param {number} viewWeek The week being looked at (1-based).
 * @param {number} activeSlot Which of the week's slots the sideline is filling.
 * @param {{onAction:Function, onSlot:(slot:number)=>void, canWrite:boolean}} handlers
 */
export function renderCall(root, board, viewWeek, activeSlot, handlers) {
  const week = board.weeks.find((entry) => entry.week === viewWeek) ?? board.weeks[0];
  const active = Math.min(activeSlot, week.picks.length - 1);
  const two = week.picks.length > 1;

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

  delegate(root, "click", "[data-activate]", (slot) => {
    handlers.onSlot(Number(slot.dataset.activate));
  });

  delegate(root, "keydown", "[data-activate]", (slot, event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handlers.onSlot(Number(slot.dataset.activate));
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
    <div class="call__slots${two ? " call__slots--two" : ""}" data-key="slots"></div>`,
  );
  const slots = box.querySelector(".call__slots");
  reconcile(slots, slotsMarkup(week, board, active));
  if (two) slots.style.setProperty("--active", String(active));
  holdEveryWeek(root, slots, board);
}

/**
 * The week's slots, and the bracket that travels between them.
 *
 * The bracket is one element that moves rather than a border lit on one slot
 * and put out on the other: a slot's markup changes on every pick and lock, so
 * a border carried in it is rebuilt - and a rebuilt border has nothing to move
 * from. Which slot it stands on is written on the row below, not in the
 * markup, for the same reason.
 */
function slotsMarkup(week, board, active) {
  const two = week.picks.length > 1;
  return (
    week.picks.map((pick, index) => slotMarkup(pick, board, two, index === active)).join("") +
    (two ? `<span class="call__marker" data-key="marker" aria-hidden="true"></span>` : "")
  );
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
    .map((week) => `<div class="${slots.className}">${slotsMarkup(week, board, 0)}</div>`)
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
 * the team, its game, its numbers. In a two-pick week the slot is a button
 * that hands the sideline to itself.
 */
function slotMarkup(pick, board, two, active) {
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
      (coached
        ? '<span class="chip chip--rec" title="This was the coach’s call">Coach</span>'
        : "") +
      resultChip(status)
    : "";

  const attrs = two
    ? ` role="button" tabindex="0" data-activate="${pick.slot}" aria-pressed="${active}"
        aria-label="Slot ${pick.slot + 1}${shown ? `, ${escapeHtml(shown.team)}` : ""}"`
    : "";

  // What the slot is showing, for the settle that plays when it changes under
  // no tap of yours (playDataUpdates in app.js). Which slot the sideline is
  // filling is deliberately not in it: the bracket moving between two slots is
  // not either of them changing.
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
    <div class="call__slot call__slot--${state}${two && active ? " call__slot--active" : ""}"
         data-week="${pick.week}" data-slot="${pick.slot}" data-key="${pick.week}-${pick.slot}"${shown ? ` data-tier="${shown.tier}"` : ""}
         data-motion-key="slot-${pick.week}-${pick.slot}"
         data-motion-signature="${escapeHtml(signature)}"${attrs}>
      <div class="call__eyebrow${pick.suggestion && !pick.team ? " call__eyebrow--coach" : ""}">${eyebrow}</div>
      <div class="call__marks">${marks}</div>
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

function resultChip(status) {
  if (status.result === "W") return '<span class="chip chip--safe" title="Final score">Won</span>';
  if (status.result === "L") {
    return '<span class="chip chip--danger" title="Final score">Lost</span>';
  }
  return "";
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
