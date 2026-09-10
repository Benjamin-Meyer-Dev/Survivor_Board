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
 * Every slot has the same rows in the same order - eyebrow, team, matchup,
 * tiles - so a pick or lock changes what the rows say without moving anything
 * under the thumb that just tapped it.
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

  root.innerHTML = `
    <div class="call">
      <div class="call__box">
        <div class="call__head">
          <span class="call__when${isNow(week, board) ? " call__when--now" : ""}">${escapeHtml(whenLine(week, board))}</span>
          <span class="call__tags">${weekTags(week, board)}</span>
          ${actionsMarkup(week.picks[active], board, handlers.canWrite)}
        </div>
        <div class="call__slots${two ? " call__slots--two" : ""}">
          ${week.picks.map((pick, index) => slotMarkup(pick, board, two, index === active)).join("")}
        </div>
      </div>
    </div>`;
}

function isNow(week, board) {
  return week.week === board.currentWeek && !board.eliminated;
}

/** "Wk 01 · Sep 13, 2026 · on the clock", or how far off the week is. */
function whenLine(week, board) {
  const stamp = `Wk ${String(week.week).padStart(2, "0")} · ${week.labelFull}`;
  if (board.eliminated) {
    if (week.week === board.eliminatedWeek) return `${stamp} · eliminated`;
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
    status.result ?? "",
    coached ? "coach" : "",
  ].join("|");

  return `
    <div class="call__slot call__slot--${state}${two && active ? " call__slot--active" : ""}"
         data-week="${pick.week}" data-slot="${pick.slot}"${shown ? ` data-tier="${shown.tier}"` : ""}
         data-motion-key="slot-${pick.week}-${pick.slot}"
         data-motion-signature="${escapeHtml(signature)}"${attrs}>
      <div class="call__eyebrow${pick.suggestion && !pick.team ? " call__eyebrow--coach" : ""}">
        <span>${eyebrow}</span>
        <span class="call__tags">${marks}</span>
      </div>
      ${
        shown
          ? `<div class="call__team">${escapeHtml(shown.team)}</div>
             <div class="call__matchup">${escapeHtml(formatMatchup(shown.site, shown.opponent))} · ${escapeHtml(shown.conference)}${kickoffMarkup(shown)}</div>`
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
 * Spread, the chance the pick carries the week, and where the line came from.
 * With nothing to price the tiles still stand, blank, so the card keeps its
 * height. In a losers pool the middle number is the chance the team loses (see
 * core/objective.js), and its name says so.
 */
function tiles(line, board) {
  const probKey = board?.rules?.objective === "lose" ? "Loss prob" : "Win prob";
  return `
    <div class="call__tiles">
      ${tile("Spread", line ? formatSpread(line.spread) : "—", line?.tier)}
      ${tile(probKey, line ? formatPercent(line.winProb) : "—", line?.tier)}
      <div class="tile tile--line">
        <span class="tile__key">Line</span>
        <span class="tile__value tile__value--text">${line ? (line.source === "market" ? "Market" : "Projected") : "—"}</span>
      </div>
    </div>`;
}

function tile(key, value, tier) {
  return `<div class="tile">
    <span class="tile__key">${escapeHtml(key)}</span>
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
