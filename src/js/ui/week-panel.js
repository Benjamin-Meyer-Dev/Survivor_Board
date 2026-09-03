/**
 * The week deck: every week laid out horizontally, one per screen, moved
 * between by swiping, or by tapping a pip in the row beneath.
 *
 * Built on CSS scroll-snap rather than touch handlers, so it gets native
 * momentum, rubber-banding and trackpad support for free and cannot fight the
 * browser's own scrolling. JS reads the scroll position to keep the pips and
 * the app's current week in sync, and only moves the track itself for a pip
 * tap or an arrow key.
 *
 * A slot is one of three things: empty, with the coach's suggestion drawn in
 * as a ghost; picked, a team the users chose but have not committed to; or
 * locked. The coach never fills a slot. Its call shows as a badge on the team
 * in the list and as the ghost, and the pick is always a tap by a user.
 *
 * The deck is rebuilt from markup on every render, and a pick is a render. So
 * that a tap on the list does not move the list, three things hold steady
 * across the rebuild: every slot head has the same rows whatever it holds, the
 * option order does not depend on what is picked (see core/plan.js), and each
 * list's scroll position, filter text and focus are read off the old markup
 * and put back on the new.
 *
 * Handlers are injected; this module knows nothing about the store.
 */

import { formatSpread, formatPercent, formatMatchup, escapeHtml } from "../core/format.js";
import { TIER_LABEL } from "../core/probability.js";

/**
 * Where a move of our own is heading, so the scroll events it fires are not
 * read as a swipe. Null while the track is at rest or in the user's hands.
 */
let destination = null;

/** Fallback that clears the destination for a move that never lands. */
let release = null;

/** What an open slot says while the optimiser has not reported yet. */
const WORKING = "Working out the path…";

/**
 * @param {HTMLElement} root
 * @param {object} board Result of buildBoard().
 * @param {number} viewWeek Week to centre (1-based).
 * @param {{onAction:Function, onWeekChange:Function, canWrite:boolean}} handlers
 */
export function renderWeekDeck(root, board, viewWeek, handlers) {
  const carried = captureListState(root);

  root.innerHTML = `
    <div class="weeks" id="weeks-track" tabindex="0"
         role="group" aria-label="Weeks, swipe sideways to change">
      ${board.weeks.map((week) => weekMarkup(week, board, handlers.canWrite)).join("")}
    </div>
    <div class="week-pips" role="group" aria-label="Jump to a week">
      ${board.weeks
        .map(
          (week) =>
            `<button type="button"
                     class="week-pip${week.week === board.currentWeek ? " week-pip--now" : ""}"
                     data-pip="${week.week}" tabindex="-1"
                     aria-label="Week ${week.week}, ${escapeHtml(week.labelFull)}"></button>`,
        )
        .join("")}
    </div>`;

  const track = root.querySelector("#weeks-track");
  const slides = [...track.children];

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  centreOn(track, slides, viewWeek - 1, "auto");
  markActive(root, viewWeek);

  let settle = null;
  track.addEventListener("scroll", () => {
    if (destination !== null) {
      // One of our own moves. Ignore it until it lands, then stand down: the
      // pips and the app were told where it was going when it set off.
      if (Math.abs(track.scrollLeft - destination) <= 2) destination = null;
      return;
    }
    clearTimeout(settle);
    settle = setTimeout(() => {
      const week = nearestIndex(track, slides) + 1;
      markActive(root, week);
      handlers.onWeekChange(week);
    }, 90);
  });

  // A finger or a wheel during one of our moves cuts it short, and from then
  // on the scroll is the user's to report.
  const takeOver = () => {
    destination = null;
  };
  for (const type of ["touchstart", "pointerdown", "wheel"]) {
    track.addEventListener(type, takeOver, { passive: true });
  }

  // Moving the track ourselves, for a pip tap or an arrow key. The scroll
  // events it fires are ignored above, so the pips and the app are told here.
  const jumpTo = (index) => {
    const next = Math.min(Math.max(index, 0), slides.length - 1);
    markActive(root, next + 1);
    handlers.onWeekChange(next + 1);
    centreOn(track, slides, next, reducedMotion.matches ? "auto" : "smooth");
  };

  // Keyboard equivalent of the swipe, for anyone not on a touchscreen.
  track.addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    jumpTo(nearestIndex(track, slides) + step);
  });

  // A tap on a pip goes straight to that week. The pips are out of the tab
  // order because the track's arrow keys already cover the keyboard.
  root.querySelector(".week-pips").addEventListener("click", (event) => {
    const pip = event.target.closest("[data-pip]");
    if (pip) jumpTo(Number(pip.dataset.pip) - 1);
  });

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

  restoreListState(root, carried);
}

/**
 * What the user had going in each team list, read off the markup about to be
 * replaced: how far each list was scrolled, what was typed in its filter, and
 * which control had focus. Without this every pick threw the list back to the
 * top, emptied the filter and dropped focus on the body.
 */
function captureListState(root) {
  const lists = {};
  for (const list of root.querySelectorAll("[data-list]")) {
    lists[list.dataset.list] = { scrollTop: list.scrollTop, filter: "" };
  }
  for (const input of root.querySelectorAll("[data-filter]")) {
    const saved = lists[input.dataset.filter];
    if (saved) saved.filter = input.value;
  }

  const active = document.activeElement;
  const dataset = active?.dataset;
  let focus = null;
  if (dataset && root.contains(active)) {
    if (dataset.filter) {
      focus = { filter: dataset.filter };
    } else if (dataset.action) {
      const { action, week, slot, team = "" } = dataset;
      focus = { action, week, slot, team };
    }
  }

  return { lists, focus };
}

/** Put back what captureListState took, onto the freshly rendered markup. */
function restoreListState(root, { lists, focus }) {
  for (const [id, saved] of Object.entries(lists)) {
    const input = root.querySelector(`[data-filter="${id}"]`);
    if (input && saved.filter) {
      input.value = saved.filter;
      applyFilter(root, input);
    }
    // After the filter, so hidden rows are not counted in the scroll height.
    const list = root.querySelector(`[data-list="${id}"]`);
    if (list) list.scrollTop = saved.scrollTop;
  }

  if (!focus) return;
  const target = focus.filter
    ? root.querySelector(`[data-filter="${focus.filter}"]`)
    : [...root.querySelectorAll("[data-action]")].find(
        (button) =>
          button.dataset.action === focus.action &&
          button.dataset.week === focus.week &&
          button.dataset.slot === focus.slot &&
          (button.dataset.team ?? "") === focus.team,
      );
  // preventScroll: bringing the control into view is exactly the jump this
  // is here to avoid.
  target?.focus({ preventScroll: true });
}

/** Hide every option in the input's list that does not match what was typed. */
function applyFilter(root, input) {
  const needle = input.value.trim().toLowerCase();
  const list = root.querySelector(`[data-list="${input.dataset.filter}"]`);
  if (!list) return;
  list.querySelectorAll("[data-search]").forEach((option) => {
    option.hidden = needle !== "" && !option.dataset.search.includes(needle);
  });
}

/** Which slide is closest to the track's current scroll position. */
function nearestIndex(track, slides) {
  let best = 0;
  let bestDistance = Infinity;
  for (const [index, slide] of slides.entries()) {
    const distance = Math.abs(slide.offsetLeft - track.scrollLeft);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

/**
 * Move the track to a slide. The scroll handler stands down when the track
 * gets there; the timer is for a move that never does, which the handler
 * could not tell from one still under way.
 */
function centreOn(track, slides, index, behavior) {
  const slide = slides[index];
  if (!slide) return;
  clearTimeout(release);
  // Already there: nothing will scroll, so there is nothing to wait for.
  if (Math.abs(track.scrollLeft - slide.offsetLeft) <= 2) {
    destination = null;
    return;
  }
  destination = slide.offsetLeft;
  track.scrollTo({ left: destination, behavior });
  release = setTimeout(
    () => {
      destination = null;
    },
    behavior === "smooth" ? 1200 : 60,
  );
}

function markActive(root, week) {
  root.querySelectorAll("[data-pip]").forEach((pip) => {
    pip.classList.toggle("week-pip--active", Number(pip.dataset.pip) === week);
  });
}

function weekMarkup(week, board, canWrite) {
  const isCurrent = week.week === board.currentWeek;
  // A buy back only means something while one is still unspent.
  const covered = week.isBuyBack && (board.buyBack?.left ?? 0) > 0;

  return `
    <article class="panel week-slide${covered ? " week-slide--covered" : ""}"
             aria-label="Week ${week.week}">
      <div class="panel__head">
        <h2 class="scoreboard">
          <span class="scoreboard__label">Week</span>
          <span class="scoreboard__num">${String(week.week).padStart(2, "0")}</span>
        </h2>
        <span class="u-eyebrow">${escapeHtml(week.labelFull)}</span>
        ${
          covered
            ? `<span class="chip chip--buyback"
                     title="A loss this week costs the buy back, not the season. The team is still burned.">Buy Back</span>`
            : ""
        }
        ${isCurrent ? '<span class="chip chip--lock">On the Clock</span>' : ""}
      </div>
      <div class="panel__slots">
        ${week.picks.map((pick) => renderSlot(pick, board, canWrite)).join("")}
      </div>
    </article>`;
}

/**
 * One slot. A picked slot is drawn solid; a locked one takes the lock tint and
 * keeps its list for reading, with nothing in it tappable until the slot is
 * unlocked. Empty slots are handled apart.
 *
 * Every slot has the same rows in the same order - eyebrow, team, matchup,
 * numbers, actions, stamp, list - so a pick or lock changes what
 * the rows say without moving the list beneath them.
 */
function renderSlot(pick, board, canWrite) {
  if (!pick.team) return renderEmptySlot(pick, board, canWrite);

  const { status } = pick;

  return `
    <div class="slot ${status.locked ? "slot--locked" : "slot--picked"}">
      <div class="slot__head">
        <div class="slot__identity">
          <div class="u-eyebrow slot__eyebrow">${status.locked ? "Locked In" : "Your Pick"}</div>
          <div class="slot__team">${escapeHtml(pick.team)}</div>
          ${matchupLine(pick, pick, canWrite)}
        </div>
        <span class="chip chip--${pick.tier}">${TIER_LABEL[pick.tier]}</span>
        ${pick.isRecommended ? '<span class="chip chip--rec" title="This is the coach’s call">Coach</span>' : ""}
        ${status.locked ? '<span class="chip chip--locked">Locked</span>' : '<span class="chip chip--picked">Picked</span>'}
        ${status.resultSource === "final" ? '<span class="chip chip--final">Final</span>' : ""}
      </div>

      ${numbers(pick)}

      <div class="actions">
        ${button("lock", pick, status.locked ? "Locked" : "Lock in", status.locked ? "btn--active" : "", canWrite && !status.result)}
        ${button("won", pick, "Won", status.result === "W" ? "btn--won" : "", canWrite && status.locked)}
        ${button("lost", pick, "Lost", status.result === "L" ? "btn--lost" : "", canWrite && status.locked)}
      </div>

      ${stamp(status)}

      ${renderTeamList(pick, canWrite)}
    </div>`;
}

/**
 * Nothing picked. The coach's suggestion stands in, drawn as a ghost: muted,
 * outlined, every action disabled, so it cannot be read as a pick. The team
 * list beneath is where the pick is actually made.
 */
function renderEmptySlot(pick, board, canWrite) {
  const suggestion = pick.suggestion;
  const pending = !suggestion && board.recommendationPending && pick.week >= board.currentWeek;

  const head = suggestion
    ? `<div class="slot__identity">
          <div class="u-eyebrow slot__eyebrow slot__eyebrow--coach">Coach Suggests</div>
          <div class="slot__team">${escapeHtml(suggestion.team)}</div>
          ${matchupLine(pick, suggestion, canWrite)}
        </div>
        <span class="chip chip--${suggestion.tier}">${TIER_LABEL[suggestion.tier]}</span>
        <span class="chip chip--coach">Suggestion</span>`
    : `<div class="slot__identity">
          <div class="u-eyebrow slot__eyebrow">Open Slot</div>
          <div class="slot__team slot__team--blank">${pending ? WORKING : "No pick yet"}</div>
          <div class="slot__matchup">
            ${pending ? "The coach is planning the season." : "Pick a team from the list below."}
          </div>
        </div>`;

  return `
    <div class="slot slot--empty">
      <div class="slot__head">${head}</div>

      ${numbers(suggestion)}

      <div class="actions">
        ${button("lock", pick, "Lock in", "", false)}
        ${button("won", pick, "Won", "", false)}
        ${button("lost", pick, "Lost", "", false)}
      </div>

      ${stamp(pick.status)}

      ${renderTeamList(pick, canWrite)}
    </div>`;
}

/**
 * The reverse side is a shortcut only when it is a legal option right now.
 * `disabled` already accounts for teams locked in another week or held by the
 * other NCAA slot, while absence from the options means the opponent is not an
 * eligible team for this pool.
 */
function matchupLine(pick, shown, canWrite) {
  const reverse =
    canWrite && !pick.status.locked
      ? pick.options.find(
          (option) =>
            option.team === shown.opponent && option.opponent === shown.team && !option.disabled,
        )
      : null;

  return `<div class="slot__matchup">
    <span>${escapeHtml(formatMatchup(shown.site, shown.opponent))} &middot; ${escapeHtml(shown.conference)}</span>
    ${
      reverse
        ? `<button type="button" class="slot__flip"
             data-action="pick" data-week="${pick.week}" data-slot="${pick.slot}"
             data-team="${escapeHtml(reverse.team)}"
             aria-label="Flip this pick to ${escapeHtml(reverse.team)}"
             title="Pick the other side of this matchup">&#8646; Flip to ${escapeHtml(reverse.team)}</button>`
        : ""
    }
  </div>`;
}

/**
 * Every team the slot could hold this week. The coach's call carries a badge,
 * and that badge is the whole of how the coach steers a pick.
 *
 * A locked slot keeps the list, so the week's other lines stay in view, but
 * its rows cannot be tapped: a lock is a lock until it is undone.
 */
function renderTeamList(pick, canWrite) {
  const id = `${pick.week}-${pick.slot}`;
  const locked = Boolean(pick.status.locked);
  const available = pick.options.filter((option) => !option.disabled).length;
  const label = locked
    ? "Unlock to Change the Team"
    : `${pick.team ? "Change the Team" : "Pick a Team"}: ${available} Available`;

  return `
      <div class="swap${locked ? " swap--locked" : ""}">
        <label class="u-eyebrow swap__label" for="filter-${id}">${label}</label>
        <input class="swap__filter" type="search" id="filter-${id}"
               placeholder="Filter Teams" autocomplete="off"
               data-filter="${id}" ${canWrite ? "" : "disabled"}>
        <div class="swap__list" data-list="${id}">
          ${pick.options.map((option) => renderOption(pick, option, canWrite && !locked)).join("")}
        </div>
      </div>`;
}

function renderOption(pick, option, canPick) {
  const classes = [
    "swap__option",
    option.isCurrent ? "swap__option--current" : "",
    option.disabled && !option.isCurrent ? "swap__option--disabled" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `
    <button type="button" class="${classes}"
            data-action="pick" data-week="${pick.week}" data-slot="${pick.slot}"
            data-team="${escapeHtml(option.team)}"
            data-search="${escapeHtml((option.team + " " + option.opponent).toLowerCase())}"
            ${canPick && (!option.disabled || option.isCurrent) ? "" : "disabled"}
            ${option.isCurrent ? 'aria-current="true" title="Tap again to clear this pick"' : ""}>
      <span class="swap__team">
        <span class="swap__name">${escapeHtml(option.team)}</span>${option.isCoach ? '<span class="swap__tag">Coach</span>' : ""}
      </span>
      <span class="swap__matchup">${escapeHtml(formatMatchup(option.site, option.opponent))}</span>
      <span class="swap__spread swap__spread--${option.tier}">
        ${option.reason ? escapeHtml(option.reason) : formatSpread(option.spread)}
      </span>
    </button>`;
}

/**
 * Spread, win probability and where the line came from, for a pick or a
 * suggestion. With nothing to price, the row still stands, blank, so the slot
 * keeps its height while the coach is working or has nothing to suggest.
 */
function numbers(line) {
  return `
      <div class="slot__numbers">
        ${metric("Spread", line ? formatSpread(line.spread) : "—", false, line?.tier)}
        ${metric("Win Probability", line ? formatPercent(line.winProb) : "—", false, line?.tier)}
        ${metric("Line", line ? (line.source === "market" ? "Market" : "Projected") : "—", true)}
      </div>`;
}

/** Who committed the slot and when. Unlocked picks need no extra status row. */
function stamp(status) {
  if (!status.by) return "";
  const text = `${escapeHtml(status.by)} &middot; ${escapeHtml(formatStamp(status.at))}`;
  return `<div class="slot__stamp">${text}</div>`;
}

/** Absolute, unambiguous, and always carrying the year. */
function formatStamp(at) {
  return new Date(at).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function metric(key, value, isText = false, tier = null) {
  return `<div>
    <div class="metric__key">${escapeHtml(key)}</div>
    <div class="metric__value${isText ? " metric__value--text" : ""}${tier ? ` confidence--${tier}` : ""}">${escapeHtml(value)}</div>
  </div>`;
}

function button(action, pick, label, modifier, enabled) {
  return `<button type="button" class="btn${modifier ? ` ${modifier}` : ""}"
    data-action="${action}" data-week="${pick.week}" data-slot="${pick.slot}"
    ${enabled ? "" : "disabled"}>${escapeHtml(label)}</button>`;
}
