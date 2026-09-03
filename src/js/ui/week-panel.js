/**
 * The week deck: every week laid out horizontally, one per screen, moved
 * between by swiping.
 *
 * Built on CSS scroll-snap rather than touch handlers, so it gets native
 * momentum, rubber-banding and trackpad support for free and cannot fight the
 * browser's own scrolling. JS only reads the scroll position to keep the pips
 * and the app's current week in sync.
 *
 * A slot is one of three things: empty, with the coach's suggestion drawn in
 * as a ghost; picked, a team the users chose but have not committed to; or
 * locked. The coach never fills a slot. Its call shows as a badge on the team
 * in the list and as the ghost, and the pick is always a tap by a user.
 *
 * Handlers are injected; this module knows nothing about the store.
 */

import { formatSpread, formatPercent, formatMatchup, escapeHtml } from "../core/format.js";
import { TIER_LABEL } from "../core/probability.js";

/** Set while we move the track ourselves, so it does not echo back as input. */
let isRestoring = false;

/** What an open slot says while the optimiser has not reported yet. */
const WORKING = "Working out the path…";

/**
 * @param {HTMLElement} root
 * @param {object} board Result of buildBoard().
 * @param {number} viewWeek Week to centre (1-based).
 * @param {{onAction:Function, onWeekChange:Function, canWrite:boolean}} handlers
 */
export function renderWeekDeck(root, board, viewWeek, handlers) {
  root.innerHTML = `
    <div class="weeks" id="weeks-track" tabindex="0"
         role="group" aria-label="Weeks, swipe sideways to change">
      ${board.weeks.map((week) => weekMarkup(week, board, handlers.canWrite)).join("")}
    </div>
    <div class="week-pips" aria-hidden="true">
      ${board.weeks
        .map(
          (
            week,
          ) => `<span class="week-pip${week.week === board.currentWeek ? " week-pip--now" : ""}"
                            data-pip="${week.week}"></span>`,
        )
        .join("")}
    </div>`;

  const track = root.querySelector("#weeks-track");
  const slides = [...track.children];

  centreOn(track, slides, viewWeek - 1, "auto");
  markActive(root, viewWeek);

  let settle = null;
  track.addEventListener("scroll", () => {
    if (isRestoring) return;
    clearTimeout(settle);
    settle = setTimeout(() => {
      const week = nearestIndex(track, slides) + 1;
      markActive(root, week);
      handlers.onWeekChange(week);
    }, 90);
  });

  // Keyboard equivalent of the swipe, for anyone not on a touchscreen.
  track.addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = Math.min(Math.max(nearestIndex(track, slides) + step, 0), slides.length - 1);
    centreOn(track, slides, next, "smooth");
  });

  root.querySelectorAll("[data-filter]").forEach((input) => {
    input.addEventListener("input", () => {
      const needle = input.value.trim().toLowerCase();
      const list = root.querySelector(`[data-list="${input.dataset.filter}"]`);
      list.querySelectorAll("[data-search]").forEach((option) => {
        option.hidden = needle !== "" && !option.dataset.search.includes(needle);
      });
    });
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

function centreOn(track, slides, index, behavior) {
  const slide = slides[index];
  if (!slide) return;
  isRestoring = true;
  track.scrollTo({ left: slide.offsetLeft, behavior });
  // Release after the scroll settles so our own movement is not read as input.
  setTimeout(
    () => {
      isRestoring = false;
    },
    behavior === "smooth" ? 400 : 60,
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
                     title="A loss this week costs the buy back, not the season. The team is still burned.">Buy back</span>`
            : ""
        }
        ${isCurrent ? '<span class="chip chip--lock">On the clock</span>' : ""}
      </div>
      <div class="panel__slots">
        ${week.picks.map((pick) => renderSlot(pick, board, canWrite)).join("")}
      </div>
    </article>`;
}

/**
 * One slot. A picked slot is drawn solid; a locked one takes the lock tint and
 * loses its list, because a lock is a lock. Empty slots are handled apart.
 */
function renderSlot(pick, board, canWrite) {
  if (!pick.team) return renderEmptySlot(pick, board, canWrite);

  const { status } = pick;

  return `
    <div class="slot ${status.locked ? "slot--locked" : "slot--picked"}">
      <div class="slot__head">
        <div class="slot__identity">
          <div class="slot__team">${escapeHtml(pick.team)}</div>
          <div class="slot__matchup">
            ${escapeHtml(formatMatchup(pick.site, pick.opponent))} &middot; ${escapeHtml(pick.conference)}
          </div>
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
        ${button("clear", pick, "Clear", "", canWrite)}
      </div>

      ${
        status.by
          ? `<div class="slot__stamp">${escapeHtml(status.by)} &middot; ${escapeHtml(formatStamp(status.at))}</div>`
          : ""
      }

      ${status.locked ? lockedNote() : renderTeamList(pick, canWrite)}
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
          <div class="u-eyebrow slot__eyebrow">Coach suggests</div>
          <div class="slot__team">${escapeHtml(suggestion.team)}</div>
          <div class="slot__matchup">
            ${escapeHtml(formatMatchup(suggestion.site, suggestion.opponent))} &middot; ${escapeHtml(suggestion.conference)}
          </div>
        </div>
        <span class="chip chip--${suggestion.tier}">${TIER_LABEL[suggestion.tier]}</span>
        <span class="chip chip--coach">Suggestion</span>`
    : `<div class="slot__identity">
          <div class="slot__team slot__team--blank">${pending ? WORKING : "No pick yet"}</div>
          <div class="slot__matchup">
            ${pending ? "The coach is planning the season." : "Pick a team from the list below."}
          </div>
        </div>`;

  return `
    <div class="slot slot--empty">
      <div class="slot__head">${head}</div>

      ${suggestion ? numbers(suggestion) : ""}

      <div class="actions">
        ${button("lock", pick, "Lock in", "", false)}
        ${button("won", pick, "Won", "", false)}
        ${button("lost", pick, "Lost", "", false)}
        ${button("clear", pick, "Clear", "", false)}
      </div>

      ${renderTeamList(pick, canWrite)}
    </div>`;
}

/**
 * Every team the slot could hold this week. The coach's call carries a badge,
 * and that badge is the whole of how the coach steers a pick.
 */
function renderTeamList(pick, canWrite) {
  const id = `${pick.week}-${pick.slot}`;
  const available = pick.options.filter((option) => !option.disabled).length;

  return `
      <div class="swap">
        <label class="u-eyebrow swap__label" for="filter-${id}">
          ${pick.team ? "Change the team" : "Pick a team"}: ${available} available
        </label>
        <input class="swap__filter" type="search" id="filter-${id}"
               placeholder="Filter teams" autocomplete="off"
               data-filter="${id}" ${canWrite ? "" : "disabled"}>
        <div class="swap__list" data-list="${id}">
          ${pick.options.map((option) => renderOption(pick, option, canWrite)).join("")}
        </div>
      </div>`;
}

/** Stands where the list would be on a locked slot. */
function lockedNote() {
  return `
      <div class="swap swap--locked">
        <span class="u-eyebrow swap__label">Locked in. Unlock to change the team.</span>
      </div>`;
}

function renderOption(pick, option, canWrite) {
  const classes = [
    "swap__option",
    option.isCurrent ? "swap__option--current" : "",
    option.disabled ? "swap__option--disabled" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `
    <button type="button" class="${classes}"
            data-action="pick" data-week="${pick.week}" data-slot="${pick.slot}"
            data-team="${escapeHtml(option.team)}"
            data-search="${escapeHtml((option.team + " " + option.opponent).toLowerCase())}"
            ${canWrite && !option.disabled ? "" : "disabled"}
            ${option.isCurrent ? 'aria-current="true"' : ""}>
      <span class="swap__team">
        <span class="swap__name">${escapeHtml(option.team)}</span>${option.isCoach ? '<span class="swap__tag">Coach</span>' : ""}
      </span>
      <span class="swap__matchup">${escapeHtml(formatMatchup(option.site, option.opponent))}</span>
      <span class="swap__spread swap__spread--${option.tier}">
        ${option.reason ? escapeHtml(option.reason) : formatSpread(option.spread)}
      </span>
    </button>`;
}

/** Spread, win probability and where the line came from, for a pick or a suggestion. */
function numbers(line) {
  return `
      <div class="slot__numbers">
        ${metric("Spread", formatSpread(line.spread))}
        ${metric("Win prob", formatPercent(line.winProb))}
        ${metric("Line", line.source === "market" ? "Market" : "Projected", true)}
      </div>`;
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

function metric(key, value, isText = false) {
  return `<div>
    <div class="metric__key">${escapeHtml(key)}</div>
    <div class="metric__value${isText ? " metric__value--text" : ""}">${escapeHtml(value)}</div>
  </div>`;
}

function button(action, pick, label, modifier, enabled) {
  return `<button type="button" class="btn${modifier ? ` ${modifier}` : ""}"
    data-action="${action}" data-week="${pick.week}" data-slot="${pick.slot}"
    ${enabled ? "" : "disabled"}>${escapeHtml(label)}</button>`;
}
