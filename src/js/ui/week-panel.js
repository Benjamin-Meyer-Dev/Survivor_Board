/**
 * The week deck: all 13 weeks laid out horizontally, one per screen, moved
 * between by swiping.
 *
 * Built on CSS scroll-snap rather than touch handlers, so it gets native
 * momentum, rubber-banding and trackpad support for free and cannot fight the
 * browser's own scrolling. JS only reads the scroll position to keep the pips
 * and the app's current week in sync.
 *
 * Handlers are injected; this module knows nothing about the store.
 */

import { formatSpread, formatPercent, formatMatchup, escapeHtml } from "../core/format.js";
import { TIER_LABEL } from "../core/probability.js";

/** Set while we move the track ourselves, so it does not echo back as input. */
let isRestoring = false;

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
      ${renderRecommendation(week, board, canWrite)}
      <div class="panel__slots">
        ${week.picks.map((pick) => renderSlot(pick, canWrite)).join("")}
      </div>
    </article>`;
}

/**
 * What the optimiser would pick this week, shown next to - not instead of -
 * what you have chosen. Collapses to a single confirming line when they agree.
 *
 * The band holds its place while the search runs. It is a few hundred
 * milliseconds on the college board, and letting it appear afterwards would
 * push the whole panel down just as you started reading the pick.
 */
function renderRecommendation(week, board, canWrite) {
  if (board.recommendationPending) {
    return `<div class="recommend recommend--waiting">
      <span class="u-eyebrow recommend__label">Coach\u2019s call</span>
      <span class="recommend__note">Working out the path\u2026</span>
    </div>`;
  }

  const recommended = week.recommended ?? [];
  if (recommended.length === 0) return "";

  if (week.matchesRecommendation) {
    return `<div class="recommend recommend--match">
      <span class="u-eyebrow recommend__label">Coach\u2019s call</span>
      <span class="recommend__note">You are running the coach\u2019s call.</span>
    </div>`;
  }

  return `<div class="recommend">
    <span class="u-eyebrow recommend__label">Coach\u2019s call</span>
    <div class="recommend__teams">
      ${recommended
        .map(
          (option) => `<span class="recommend__team">
            ${escapeHtml(option.team)}
            <span class="recommend__spread">${option.spread === undefined ? "" : formatSpread(option.spread)}</span>
          </span>`,
        )
        .join("")}
    </div>
    <button type="button" class="btn btn--apply" data-action="apply" data-week="${week.week}"
            ${canWrite ? "" : "disabled"}>Run it</button>
  </div>`;
}

function renderSlot(pick, canWrite) {
  const { status } = pick;

  return `
    <div class="slot${status.locked ? " slot--locked" : ""}">
      <div class="slot__head">
        <div class="slot__identity">
          <div class="slot__team">${escapeHtml(pick.team)}</div>
          <div class="slot__matchup">
            ${escapeHtml(formatMatchup(pick.site, pick.opponent))} &middot; ${escapeHtml(pick.conference)}
          </div>
        </div>
        <span class="chip chip--${pick.tier}">${TIER_LABEL[pick.tier]}</span>
        ${pick.isRecommended ? '<span class="chip chip--rec">Rec</span>' : ""}
        ${status.locked ? '<span class="chip chip--lock">Locked</span>' : ""}
        ${status.resultSource === "final" ? '<span class="chip chip--final">Final</span>' : ""}
      </div>

      <div class="slot__numbers">
        ${metric("Spread", formatSpread(pick.spread))}
        ${metric("Win prob", formatPercent(pick.winProb))}
        ${metric("Line", pick.source === "market" ? "Market" : "Projected", true)}
      </div>

      <div class="actions">
        ${button("lock", pick, status.locked ? "Locked in" : "Lock it in", status.locked ? "btn--active" : "", canWrite)}
        ${button("won", pick, "Won", status.result === "W" ? "btn--won" : "", canWrite)}
        ${button("lost", pick, "Lost", status.result === "L" ? "btn--lost" : "", canWrite)}
        ${button("clear", pick, "Clear", "", canWrite)}
      </div>

      ${
        status.by
          ? `<div class="slot__stamp">${escapeHtml(status.by)} &middot; ${escapeHtml(formatStamp(status.at))}</div>`
          : ""
      }

      <div class="swap">
        <label class="u-eyebrow swap__label" for="filter-${pick.week}-${pick.slot}">
          Swap this slot: ${pick.options.filter((o) => !o.disabled).length} teams available
        </label>
        <input class="swap__filter" type="search" id="filter-${pick.week}-${pick.slot}"
               placeholder="Filter teams" autocomplete="off"
               data-filter="${pick.week}-${pick.slot}" ${canWrite ? "" : "disabled"}>
        <div class="swap__list" data-list="${pick.week}-${pick.slot}">
          ${pick.options.map((option) => renderSwapOption(pick, option, canWrite)).join("")}
        </div>
      </div>
    </div>`;
}

function renderSwapOption(pick, option, canWrite) {
  const classes = [
    "swap__option",
    option.isCurrent ? "swap__option--current" : "",
    option.disabled ? "swap__option--disabled" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `
    <button type="button" class="${classes}"
            data-action="swap" data-week="${pick.week}" data-slot="${pick.slot}"
            data-team="${escapeHtml(option.team)}"
            data-search="${escapeHtml((option.team + " " + option.opponent).toLowerCase())}"
            ${canWrite && !option.disabled ? "" : "disabled"}
            ${option.isCurrent ? 'aria-current="true"' : ""}>
      <span class="swap__team">
        <span class="swap__name">${escapeHtml(option.team)}</span>${option.isPlan ? '<span class="swap__tag">plan</span>' : ""}
      </span>
      <span class="swap__matchup">${escapeHtml(formatMatchup(option.site, option.opponent))}</span>
      <span class="swap__spread swap__spread--${option.tier}">
        ${option.reason ? escapeHtml(option.reason) : formatSpread(option.spread)}
      </span>
    </button>`;
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

function button(action, pick, label, modifier, canWrite) {
  return `<button type="button" class="btn${modifier ? ` ${modifier}` : ""}"
    data-action="${action}" data-week="${pick.week}" data-slot="${pick.slot}"
    ${canWrite ? "" : "disabled"}>${escapeHtml(label)}</button>`;
}
