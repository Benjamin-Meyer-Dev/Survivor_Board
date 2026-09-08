/**
 * The sideline: every team the slot could hold this week.
 *
 * The drawer's first panel, for the week being looked at and the slot the
 * call has active. The coach's call carries a tag, and that tag is the whole
 * of how the coach steers a pick. A locked slot keeps its list to read - the
 * week's other lines are still worth a look - but nothing in it can be tapped
 * until the slot is unlocked.
 *
 * The list is rebuilt on every render, and a pick is a render. So that a tap
 * on the list does not move the list, the option order does not depend on
 * what is picked (see core/plan.js), and the panel's scroll position, the
 * filter text and the focus are read off the old markup and put back on the
 * new. Handlers are injected; this module knows nothing about the store.
 */

import { formatSpread, formatPercent, formatMatchup, escapeHtml } from "../core/format.js";

const LOCK_ICON = `<span class="sideline__lock" role="img" aria-label="Locked in">
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
</span>`;

const COACH_MARK = `<span class="sideline__coach" aria-hidden="true">Coach</span><span class="u-visually-hidden">Coach's call</span>`;

/**
 * @param {HTMLElement} root
 * @param {object} board Result of buildBoard().
 * @param {number} viewWeek
 * @param {number} activeSlot
 * @param {{onAction:Function, canWrite:boolean}} handlers
 */
export function renderSideline(root, board, viewWeek, activeSlot, handlers) {
  const week = board.weeks[viewWeek - 1] ?? board.weeks[0];
  const pick = week.picks[Math.min(activeSlot, week.picks.length - 1)];
  const carried = captureState(root);

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

  root.innerHTML = `
    <div class="sideline${locked ? " sideline--locked" : ""}">
      <label class="u-eyebrow sideline__label" for="filter-${id}">${escapeHtml(label)}</label>
      <input class="sideline__filter" type="search" id="filter-${id}" placeholder="Find a team"
             autocomplete="off" data-filter="${id}" ${handlers.canWrite ? "" : "disabled"}>
      <div class="sideline__list" data-list="${id}">
        ${pick.options.map((option) => rowMarkup(pick, option, canPick)).join("")}
      </div>
    </div>`;

  root.querySelectorAll("[data-filter]").forEach((input) => {
    input.addEventListener("input", () => applyFilter(root, input));
  });

  root.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      handlers.onAction({
        action: button.dataset.action,
        week: Number(button.dataset.week),
        slot: Number(button.dataset.slot),
        team: button.dataset.team,
      });
    });
  });

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
  const classes = [
    "sideline__row",
    option.isCurrent ? "sideline__row--current" : "",
    locked ? "sideline__row--locked" : "",
    option.disabled && !option.isCurrent ? "sideline__row--disabled" : "",
    held ? "sideline__row--held" : "",
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
        : "";

  return `
    <button type="button" class="${classes}"
            data-action="pick" data-week="${pick.week}" data-slot="${pick.slot}"
            data-team="${escapeHtml(option.team)}"
            data-search="${escapeHtml((option.team + " " + option.opponent).toLowerCase())}"
            ${canPick && (!option.disabled || option.isCurrent) ? "" : "disabled"}
            ${current}>
      <span class="sideline__team">
        <span class="sideline__name">${locked || held ? LOCK_ICON : ""}<span>${escapeHtml(option.team)}</span>${option.isCoach ? COACH_MARK : ""}</span>
        <span class="sideline__matchup">${escapeHtml(formatMatchup(option.site, option.opponent))}</span>
      </span>
      ${line(option)}
    </button>`;
}

/** The spread and the chance side by side in the tier's chalk, or why not. */
function line(option) {
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
