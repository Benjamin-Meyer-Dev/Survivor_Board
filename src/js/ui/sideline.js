/**
 * The sideline: every team the slot could hold this week.
 *
 * The drawer's first panel, for the week being looked at and the slot the
 * call has active. Every team the coach ranks for the week carries a tag
 * numbered with where it sits - the calls first, the fallbacks behind them -
 * and those tags are the whole of how the coach steers a pick, here and
 * nowhere else on the board. A locked slot keeps its list
 * to read - the week's other lines are still worth a look - but nothing in it
 * can be tapped until the slot is unlocked. Under everything sit the teams
 * already burned, newest week first and week 1 at the floor, each wearing the
 * padlock and the week that took it.
 *
 * The list is rebuilt on every render, and a pick is a render. So that a tap
 * on the list does not move the list, the option order does not depend on
 * what is picked (see core/plan.js), and the panel's scroll position, the
 * filter text and the focus are read off the old markup and put back on the
 * new. Handlers are injected; this module knows nothing about the store.
 */

import { formatSpread, formatPercent, formatMatchup, escapeHtml } from "../core/format.js";
import { delegate } from "./events.js";
import { frame, reconcile } from "./patch.js";

/**
 * The board's padlock: worn by a locked row, by a row the other slot has
 * locked, and by every row in the burned band, which says its week with it.
 * The label is what a screen reader hears in place of the drawing.
 */
function lockIcon(label = "Locked in") {
  return `<span class="sideline__lock" role="img" aria-label="${label}">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  </span>`;
}

const LOCK_ICON = lockIcon();

/**
 * The coach's mark on a row, carrying where the coach ranks the team this week
 * (core/plan.js, option.coachRank): the calls the week would take, then the
 * fallbacks behind them. The number is the whole of the ranking - every mark
 * is the same flag-coloured tag, so the list reads as one ordered board rather
 * than as two kinds of advice - and a screen reader is told the rank in words.
 */
function coachMark(option) {
  if (!option.coachRank) return "";
  return `<span class="sideline__coach" aria-hidden="true">Coach #${option.coachRank}</span>
    <span class="u-visually-hidden">${option.isCoach ? "The coach's call" : `The coach's number ${option.coachRank} choice`}</span>`;
}

/**
 * @param {HTMLElement} root
 * @param {object} board Result of buildBoard().
 * @param {number} viewWeek
 * @param {number} activeSlot
 * @param {{onAction:Function, canWrite:boolean}} handlers
 */
export function renderSideline(root, board, viewWeek, activeSlot, handlers) {
  const week = board.weeks.find((entry) => entry.week === viewWeek) ?? board.weeks[0];
  const pick = week.picks[Math.min(activeSlot, week.picks.length - 1)];
  const carried = captureState(root);

  // Bound to the panel's root rather than to each of a hundred-odd rows, which
  // this rebuilds on every render (see ui/events.js).
  delegate(root, "input", "[data-filter]", (input) => applyFilter(root, input));

  delegate(root, "click", "[data-action]", (button) => {
    handlers.onAction({
      action: button.dataset.action,
      week: Number(button.dataset.week),
      slot: Number(button.dataset.slot),
      team: button.dataset.team,
    });
  });

  const id = `${pick.week}-${pick.slot}`;
  const locked = Boolean(pick.status.locked);
  const canPick = handlers.canWrite && !locked;
  const available = pick.options.filter((option) => !option.disabled).length;
  const label = board.eliminated
    ? locked
      ? "Locked in"
      : "In review: nothing more to pick"
    : locked
      ? "Unlock to change the team"
      : `${pick.team ? "Change the team" : "Pick a team"} · ${available} available`;

  // Patched rather than rebuilt (ui/patch.js): the label, the filter and the
  // list are kept while the slot is the same slot, and inside the list each
  // row is kept until its own markup changes. A pick touches two rows - the
  // one taken and the one let go - and the other hundred stay where they
  // were, scroll, focus and typed filter with them.
  const panel = frame(root, `<div class="sideline"></div>`);
  panel.classList.toggle("sideline--locked", locked);
  reconcile(
    panel,
    `<label class="u-eyebrow sideline__label" for="filter-${id}" data-key="label">${escapeHtml(label)}</label>
    <input class="sideline__filter" type="search" id="filter-${id}" placeholder="Find a team"
           autocomplete="off" data-filter="${id}" data-key="filter" ${handlers.canWrite ? "" : "disabled"}>
    <div class="sideline__list" data-list="${id}" data-key="list"></div>`,
  );
  reconcile(
    panel.querySelector(".sideline__list"),
    pick.options.map((option) => rowMarkup(pick, option, canPick)).join(""),
  );

  restoreState(root, carried);
}

/**
 * What the user had going in the list, read off the markup about to be
 * replaced: how far the panel was scrolled, what was typed in the filter, and
 * which control had focus. Keyed by the slot's id, so a different week starts
 * fresh and the same slot picks up where it was.
 */
function captureState(root) {
  const input = root.querySelector("[data-filter]");
  const panel = root.closest(".drawer__panel");
  const state = {
    id: input?.dataset.filter ?? null,
    filter: input?.value ?? "",
    scrollTop: panel?.scrollTop ?? 0,
    focus: null,
  };
  const active = document.activeElement;
  const dataset = active?.dataset;
  if (dataset && root.contains(active)) {
    if (dataset.filter) state.focus = { filter: dataset.filter };
    else if (dataset.action) {
      const { action, week, slot, team = "" } = dataset;
      state.focus = { action, week, slot, team };
    }
  }
  return state;
}

function restoreState(root, state) {
  const input = root.querySelector("[data-filter]");
  if (!input || input.dataset.filter !== state.id) return;
  if (state.filter) {
    input.value = state.filter;
    applyFilter(root, input);
  }
  const panel = root.closest(".drawer__panel");
  if (panel) panel.scrollTop = state.scrollTop;

  if (!state.focus) return;
  const target = state.focus.filter
    ? input
    : [...root.querySelectorAll("[data-action]")].find(
        (button) =>
          button.dataset.action === state.focus.action &&
          button.dataset.week === state.focus.week &&
          button.dataset.slot === state.focus.slot &&
          (button.dataset.team ?? "") === state.focus.team,
      );
  // preventScroll: bringing the control into view is exactly the jump this
  // is here to avoid.
  target?.focus({ preventScroll: true });
}

function applyFilter(root, input) {
  const needle = input.value.trim().toLowerCase();
  const list = root.querySelector(`[data-list="${input.dataset.filter}"]`);
  if (!list) return;
  list.querySelectorAll("[data-search]").forEach((option) => {
    option.hidden = needle !== "" && !option.dataset.search.includes(needle);
  });
}

/**
 * One row. The slot's own team is marked current; when the slot is locked
 * that row also wears the lock. A team the other slot has locked wears the
 * lock too, so the two lists of a two-pick week agree with each other. A row
 * whose game has been played is kept as a record of the week, not a choice.
 */
function rowMarkup(pick, option, canPick) {
  const locked = option.isCurrent && Boolean(pick.status.locked);
  const held = Boolean(option.siblingLocked) && !option.isCurrent;
  // Burned in another week: the foot of the list (see core/plan.js), where the
  // row is the season's record rather than one of this week's choices.
  const spent = Boolean(option.spentWeek) && !option.isCurrent;
  const classes = [
    "sideline__row",
    option.isCurrent ? "sideline__row--current" : "",
    locked ? "sideline__row--locked" : "",
    option.disabled && !option.isCurrent ? "sideline__row--disabled" : "",
    held ? "sideline__row--held" : "",
    spent ? "sideline__row--spent" : "",
    option.result ? "sideline__row--settled" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const current = locked
    ? 'aria-current="true" title="Locked in. Unlock the slot to change it"'
    : option.isCurrent
      ? 'aria-current="true" title="Tap again to clear this pick"'
      : held
        ? 'title="Locked in the other slot this week"'
        : spent
          ? `title="Locked in week ${option.spentWeek}. A team is only spent once"`
          : "";

  // What the row is, for the settle that plays when it changes under no tap of
  // yours (playDataUpdates in app.js): which of the six states it is in, and
  // nothing of its numbers. The lines move on every pull and a settle on each
  // of a hundred rows is the drawer flickering, where the six states are the
  // things a row changes into. The key carries the week and the slot as well
  // as the team, so handing the sideline to the other slot - or turning the
  // week - is a new list rather than every row in the old one changing at once.
  const signature = [
    option.isCurrent ? "current" : "",
    locked ? "locked" : "",
    held ? "held" : "",
    spent ? `spent-${option.spentWeek}` : "",
    option.disabled ? "disabled" : "",
    option.result ?? "",
  ]
    .filter(Boolean)
    .join("|");

  return `
    <button type="button" class="${classes}"
            data-action="pick" data-week="${pick.week}" data-slot="${pick.slot}"
            data-team="${escapeHtml(option.team)}" data-key="${escapeHtml(option.team)}"
            data-motion-key="sideline-${pick.week}-${pick.slot}-${escapeHtml(option.team)}"
            data-motion-signature="${escapeHtml(signature)}"
            data-search="${escapeHtml((option.team + " " + option.opponent).toLowerCase())}"
            ${canPick && (!option.disabled || option.isCurrent) ? "" : "disabled"}
            ${current}>
      <span class="sideline__team">
        <span class="sideline__name">${locked || held ? LOCK_ICON : ""}<span class="sideline__team-name">${escapeHtml(option.team)}</span>${coachMark(option)}</span>
        <span class="sideline__matchup">${escapeHtml(formatMatchup(option.site, option.opponent))}</span>
      </span>
      ${line(option, spent)}
    </button>`;
}

/**
 * The spread and the chance side by side in the tier's chalk, or why not.
 *
 * A burned team says which week took it, and says it with the padlock rather
 * than in a sentence: the same lock the call card and the field's flag wear,
 * so the foot of the list reads as the weeks already played rather than as a
 * column of small print. It wears that mark even where the week's own game has
 * since been played - the lock is why the row is down there at all.
 */
function line(option, spent) {
  if (spent) {
    return `<span class="sideline__line sideline__line--spent">
        ${lockIcon(`Locked in week ${option.spentWeek}`)}
        <span class="sideline__spent">Week ${option.spentWeek}</span>
      </span>`;
  }
  if (option.result) {
    return `<span class="sideline__line sideline__line--${option.result === "W" ? "won" : "lost"}">
        <span class="sideline__spread">${option.result === "W" ? "Won" : "Lost"}</span>
      </span>`;
  }
  const contents = option.reason
    ? `<span class="sideline__spread">${escapeHtml(option.reason)}</span>`
    : `<span class="sideline__spread">${escapeHtml(formatSpread(option.spread))}</span>
        <span class="sideline__prob">${escapeHtml(formatPercent(option.winProb, 0))}</span>`;
  return `<span class="sideline__line sideline__line--${option.tier}">${contents}</span>`;
}
