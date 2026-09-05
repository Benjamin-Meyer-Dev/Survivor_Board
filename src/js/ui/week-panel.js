/**
 * The week deck: every week laid out horizontally, one per screen, moved
 * between by swiping, by tapping the row of pips beneath, or by pressing and
 * holding that row and sliding along it, which runs the deck under the finger.
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

/** Hold the pip row this long and it becomes a scrubber under the finger. */
const HOLD_MS = 200;

/** Or slide this far sideways from where the press landed, whichever is first. */
const SLIDE_PX = 6;

/** How long the week cue stays up after the last thing that showed it. */
const CUE_MS = 1100;

/** The cue stops this far short of the rail's ends rather than overhanging. */
const CUE_INSET = 6;

/** A padlock, drawn like the flip arrows: strokes in the current colour. */
const LOCK_ICON = `<span class="swap__lock" role="img" aria-label="Locked in">
  <svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
    <rect x="4.5" y="9" width="11" height="8" rx="1.8" />
    <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
  </svg>
</span>`;

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
    <div class="week-rail">
      <div class="week-pips" role="group" aria-label="Jump to a week, or hold and slide">
        ${board.weeks
          .map(
            (week) =>
              `<button type="button"
                       class="week-pip${week.week === board.currentWeek ? " week-pip--now" : ""}"
                       data-pip="${week.week}" data-label="${escapeHtml(week.label)}" tabindex="-1"
                       aria-label="Week ${week.week}, ${escapeHtml(week.labelFull)}"></button>`,
          )
          .join("")}
      </div>
      <div class="week-cue" aria-hidden="true">
        <span class="week-cue__label">Wk</span>
        <span class="week-cue__num"></span>
        <span class="week-cue__date"></span>
      </div>
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

  // Moving the track ourselves, for a pip tap, a scrub or an arrow key. The
  // scroll events it fires are ignored above, so the pips and the app are told
  // here. A scrub asks for `instant`: it is already moving the deck at the
  // speed of the finger, and a smooth move per week would trail behind it.
  const cue = weekCue(root.querySelector(".week-rail"));
  const jumpTo = (index, instant = false) => {
    const next = Math.min(Math.max(index, 0), slides.length - 1);
    markActive(root, next + 1);
    cue.show(next);
    handlers.onWeekChange(next + 1);
    centreOn(track, slides, next, instant || reducedMotion.matches ? "auto" : "smooth");
  };

  // Keyboard equivalent of the swipe, for anyone not on a touchscreen.
  track.addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    jumpTo(nearestIndex(track, slides) + step);
  });

  // Tap the row to jump, hold it and slide to run through the weeks. The pips
  // are out of the tab order because the track's arrow keys already cover the
  // keyboard.
  attachScrubber(root.querySelector(".week-pips"), jumpTo, cue);

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

/**
 * The pip row, as one control. What it reads is where along the row you are,
 * not which mark you hit: a tap goes to the nearest week, and a press held for
 * a beat - or slid sideways, whichever comes first - hands the deck to the
 * finger, which then runs through the weeks as it moves. Letting go leaves the
 * deck wherever it stopped.
 *
 * Position rather than hit testing is what makes the gesture worth having: the
 * marks are a few pixels wide, the slices between them are twenty, and the row
 * is spread as wide as the deck allows (see .week-pips) so those slices are as
 * big as they can be.
 *
 * @param {HTMLElement} pips
 * @param {(index:number, instant?:boolean) => void} jumpTo
 * @param {ReturnType<typeof weekCue>} cue
 */
function attachScrubber(pips, jumpTo, cue) {
  /** The press under way, or null. Its centres are measured once, at the down. */
  let press = null;

  /** Set by a scrub, so the click its release fires does not jump again. */
  let swallowClick = false;

  const goTo = (x) => {
    const index = nearestCentre(press.centres, x);
    if (index === press.index) return;
    press.index = index;
    jumpTo(index, true);
  };

  const engage = (x) => {
    if (!press || press.live) return;
    press.live = true;
    swallowClick = true;
    pips.classList.add("week-pips--scrubbing");
    // The cue stays up for as long as the finger is down, since the finger is
    // covering the marks it would otherwise be read from.
    cue.hold("press", true);
    cue.show(press.index);
    // Keeps the moves coming once the finger leaves the row, which on a phone
    // it will: the row is barely a thumb deep. A render can replace the row
    // mid-press, and capturing on a node no longer in the page throws.
    if (pips.isConnected) pips.setPointerCapture(press.id);
    goTo(x);
  };

  const end = () => {
    if (!press) return;
    clearTimeout(press.hold);
    if (press.live) {
      pips.classList.remove("week-pips--scrubbing");
      if (pips.hasPointerCapture(press.id)) pips.releasePointerCapture(press.id);
      cue.hold("press", false);
    }
    press = null;
  };

  pips.addEventListener("pointerdown", (event) => {
    // Anything but the primary button is somebody else's gesture.
    if (event.button > 0) return;
    end();
    swallowClick = false;
    press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      centres: pipCentres(pips),
      // Where the deck already is, so a scrub that never leaves the week it
      // started on moves nothing.
      index: [...pips.querySelectorAll("[data-pip]")].findIndex((pip) =>
        pip.classList.contains("week-pip--active"),
      ),
      live: false,
      hold: setTimeout(() => engage(event.clientX), HOLD_MS),
    };
  });

  // A mouse over the row previews the week under it without moving the deck,
  // and the cue stays while the mouse does. Touch has no hover, so there a tap
  // or a scrub is what brings it up.
  pips.addEventListener("pointerenter", (event) => {
    if (event.pointerType === "mouse") cue.hold("hover", true);
  });
  pips.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse") cue.hold("hover", false);
  });

  pips.addEventListener("pointermove", (event) => {
    if (!press && event.pointerType === "mouse") {
      cue.show(nearestCentre(pipCentres(pips), event.clientX));
      return;
    }
    if (!press || event.pointerId !== press.id) return;
    if (press.live) {
      // Ours now: on a mouse this is also what stops the drag selecting text.
      event.preventDefault();
      goTo(event.clientX);
      return;
    }
    const dx = Math.abs(event.clientX - press.x);
    const dy = Math.abs(event.clientY - press.y);
    // Sideways is a scrub before the hold is up. Downwards is the page being
    // scrolled - touch-action lets the browser have it - and the press was
    // only ever on the way past.
    if (dx > SLIDE_PX && dx > dy) engage(event.clientX);
    else if (dy > SLIDE_PX) end();
  });

  for (const type of ["pointerup", "pointercancel"]) {
    pips.addEventListener(type, (event) => {
      if (press && event.pointerId === press.id) end();
    });
  }

  pips.addEventListener("click", (event) => {
    // The release of a scrub. The deck is already where the finger left it.
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    // A click with no pointer behind it - a screen reader activating a mark -
    // has no position to read, so that mark's own week is the answer.
    const pip = event.detail === 0 ? event.target.closest("[data-pip]") : null;
    jumpTo(pip ? Number(pip.dataset.pip) - 1 : nearestCentre(pipCentres(pips), event.clientX));
  });
}

/** Where each pip sits along the row, measured once at the start of a press. */
function pipCentres(pips) {
  return [...pips.querySelectorAll("[data-pip]")].map((pip) => {
    const box = pip.getBoundingClientRect();
    return box.left + box.width / 2;
  });
}

/**
 * The week whose mark is nearest a point on the row. Past either end this
 * settles on the end itself, so a finger that runs off the row parks on week
 * one or the last week rather than falling off the gesture.
 */
function nearestCentre(centres, x) {
  let best = 0;
  for (const [index, centre] of centres.entries()) {
    if (Math.abs(centre - x) < Math.abs(centres[best] - x)) best = index;
  }
  return best;
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
  const pips = root.querySelectorAll("[data-pip]");
  pips.forEach((pip) => {
    pip.classList.toggle("week-pip--active", Number(pip.dataset.pip) === week);
  });
  // How far along the rail the active mark sits, for the filled part of the
  // line (see .week-pips::after). The marks are spread evenly, so this is a
  // fraction rather than a measurement and survives a resize.
  const rail = root.querySelector(".week-pips");
  if (rail)
    rail.style.setProperty("--rail-pos", pips.length > 1 ? (week - 1) / (pips.length - 1) : 0);
}

/**
 * The cue over the rail: which week a tap, a scrub or an arrow key is landing
 * on, held over the mark it belongs to and gone again after a beat. It is what
 * makes the row readable while a finger is on it, when the marks under the
 * finger cannot be. Holds keep it up - the finger is down, or a mouse is over
 * the row - and it fades once the last hold lifts.
 *
 * @param {HTMLElement} rail The .week-rail wrapping the pips and the cue.
 */
function weekCue(rail) {
  const cue = rail.querySelector(".week-cue");
  const pips = rail.querySelector(".week-pips");
  const num = cue.querySelector(".week-cue__num");
  const date = cue.querySelector(".week-cue__date");
  const holds = new Set();
  let timer = null;

  const schedule = () => {
    clearTimeout(timer);
    if (holds.size) return;
    timer = setTimeout(() => cue.classList.remove("is-on"), CUE_MS);
  };

  return {
    /** Put the cue over a mark, by index, and start (or restart) its clock. */
    show(index) {
      const pip = pips.querySelectorAll("[data-pip]")[index];
      if (!pip) return;
      num.textContent = String(index + 1).padStart(2, "0");
      date.textContent = pip.dataset.label ?? "";
      // Centred on the mark, but kept inside the rail at either end; the tip
      // then slides along the cue so it still points at the mark.
      const railBox = rail.getBoundingClientRect();
      const pipBox = pip.getBoundingClientRect();
      const centre = pipBox.left + pipBox.width / 2 - railBox.left;
      const half = cue.offsetWidth / 2;
      const x = Math.min(Math.max(centre, half + CUE_INSET), railBox.width - half - CUE_INSET);
      cue.style.setProperty("--cue-x", `${x}px`);
      cue.style.setProperty("--cue-tip", `${centre - x}px`);
      cue.classList.add("is-on");
      schedule();
    },
    /** Something is keeping the cue up: the row is pressed, or hovered. */
    hold(key, on) {
      if (on) holds.add(key);
      else holds.delete(key);
      schedule();
    },
  };
}

function weekMarkup(week, board, canWrite) {
  const isCurrent = week.week === board.currentWeek;
  // A buy back only means something while one is still unspent.
  const covered = week.isBuyBack && (board.buyBack?.left ?? 0) > 0;
  // In review: the week the run ended, and the weeks after it that were never
  // played. The clock chip goes, since nothing is on the clock any more.
  const ended = board.eliminated && week.week === board.eliminatedWeek;
  const moot = board.eliminated && week.week > board.eliminatedWeek;

  return `
    <article class="panel week-slide${covered ? " week-slide--covered" : ""}${moot ? " week-slide--moot" : ""}"
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
        ${ended ? '<span class="chip chip--danger">Eliminated</span>' : ""}
        ${moot ? '<span class="chip chip--moot">Not played</span>' : ""}
        ${isCurrent && !board.eliminated ? '<span class="chip chip--clock">On the clock</span>' : ""}
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
 * numbers, list - so a pick or lock changes what the rows say without moving
 * the list beneath them. The lock toggle sits with the badges in the head.
 */
function renderSlot(pick, board, canWrite) {
  if (!pick.team) return renderEmptySlot(pick, board, canWrite);

  const { status } = pick;

  return `
    <div class="slot ${status.locked ? "slot--locked" : "slot--picked"}"
         data-motion-key="slot-${pick.week}-${pick.slot}">
      <div class="slot__head">
        <div class="slot__identity">
          <div class="u-eyebrow slot__eyebrow">${status.locked ? "Locked in" : "Your pick"}</div>
          <div class="slot__team">${escapeHtml(pick.team)}</div>
        </div>
        <span class="chip chip--${pick.tier}">${TIER_LABEL[pick.tier]}</span>
        ${pick.isRecommended ? '<span class="chip chip--rec" title="This is the coach’s call">Coach</span>' : ""}
        ${resultChip(status)}
        ${lockToggle(pick, canWrite && !status.result, board)}
        ${matchupLine(pick, pick, canWrite)}
      </div>

      ${numbers(pick)}

      ${renderTeamList(pick, board, canWrite)}
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
  // In review nothing is open any more: a slot past the end was never played,
  // and one before it simply went unpicked.
  const moot = board.eliminated && pick.week > board.eliminatedWeek;
  const blank = moot
    ? {
        eyebrow: "Not played",
        team: "Season over",
        text: `The run ended in week ${board.eliminatedWeek}.`,
      }
    : board.eliminated
      ? { eyebrow: "Open slot", team: "No pick", text: "Nothing was picked here." }
      : {
          eyebrow: "Open slot",
          team: pending ? WORKING : "No pick yet",
          text: pending ? "The coach is planning the season." : "Pick a team from the list below.",
        };

  // The matchup line comes last so it takes the head's second row, the same
  // place it has in a picked slot (see .slot__matchup in components.css).
  const head = suggestion
    ? `<div class="slot__identity">
          <div class="u-eyebrow slot__eyebrow slot__eyebrow--coach">Coach suggests</div>
          <div class="slot__team">${escapeHtml(suggestion.team)}</div>
        </div>
        <span class="chip chip--${suggestion.tier}">${TIER_LABEL[suggestion.tier]}</span>
        <span class="chip chip--coach">Suggestion</span>
        ${lockToggle(pick, false, board)}
        ${matchupLine(pick, suggestion, canWrite)}`
    : `<div class="slot__identity">
          <div class="u-eyebrow slot__eyebrow">${blank.eyebrow}</div>
          <div class="slot__team slot__team--blank">${blank.team}</div>
        </div>
        ${lockToggle(pick, false, board)}
        <div class="slot__matchup">
          <span>${blank.text}</span>
        </div>`;

  return `
    <div class="slot slot--empty" data-motion-key="slot-${pick.week}-${pick.slot}">
      <div class="slot__head">${head}</div>

      ${numbers(suggestion)}

      ${renderTeamList(pick, board, canWrite)}
    </div>`;
}

/**
 * The lock, as a toggle, and the slot's one control. An open padlock means the
 * pick is still yours to change: tap to commit it. Closed and filled means it
 * is locked: tap to undo that. It also marks the slot's state, in place of a
 * Picked or Locked chip, so the head says each thing once. Disabled when there
 * is nothing to lock (an empty slot, a read-only board) and once a result is
 * in, when the lock is history rather than a choice.
 */
function lockToggle(pick, enabled, board) {
  const locked = Boolean(pick.status.locked);
  const label = pick.status.result
    ? "Locked in and final"
    : board.eliminated
      ? locked
        ? "Locked in. The season is over"
        : "Season over"
      : locked
        ? "Locked in. Tap to unlock"
        : pick.team
          ? "Lock in this pick"
          : "Nothing to lock yet";
  // The shackle: down both sides when closed, lifted clear on the right when open.
  const shackle = locked ? "M7 9V6.5a3 3 0 0 1 6 0V9" : "M7 9V6.5a3.1 3.1 0 0 1 6-.6";

  return `<button type="button" class="lock-toggle${locked ? " lock-toggle--on" : ""}"
    data-action="lock" data-week="${pick.week}" data-slot="${pick.slot}"
    aria-pressed="${locked}" aria-label="${label}" title="${label}"
    ${enabled ? "" : "disabled"}>
    <svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
      <rect x="4.5" y="9" width="11" height="8" rx="1.8" />
      <path d="${shackle}" />
    </svg>
  </button>`;
}

/**
 * Won or lost, once the game is final. Results arrive with the daily refresh
 * (scripts/refresh-odds.mjs writes them into odds.json), so there is nothing to
 * tap: a resolved slot says how it went, and its lock can no longer be undone.
 */
function resultChip(status) {
  if (status.result === "W") return '<span class="chip chip--safe" title="Final score">Won</span>';
  if (status.result === "L") {
    return '<span class="chip chip--danger" title="Final score">Lost</span>';
  }
  return "";
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
             title="Pick the other side of this matchup">
             <span class="slot__flip-icon" aria-hidden="true">
               <svg viewBox="0 0 20 20" focusable="false">
                 <path d="M3 6h11m-3-3 3 3-3 3M17 14H6m3 3-3-3 3-3" />
               </svg>
             </span>
             <span>Flip to <strong>${escapeHtml(reverse.team)}</strong></span>
           </button>`
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
function renderTeamList(pick, board, canWrite) {
  const id = `${pick.week}-${pick.slot}`;
  const locked = Boolean(pick.status.locked);
  const available = pick.options.filter((option) => !option.disabled).length;
  // In review the list is a record of what the week offered, not a menu.
  const label = board.eliminated
    ? locked
      ? "Locked in"
      : "In review: nothing more to pick"
    : locked
      ? "Unlock to change the team"
      : `${pick.team ? "Change the team" : "Pick a team"}: ${available} available`;

  // data-motion-ignore: the settle in app.js animates the slot's head, numbers
  // and actions, not this list, so a change here alone (the sibling slot
  // picking a team, say) must not count as the slot changing.
  return `
      <div class="swap${locked ? " swap--locked" : ""}" data-motion-ignore>
        <label class="u-eyebrow swap__label" for="filter-${id}">${label}</label>
        <input class="swap__filter" type="search" id="filter-${id}"
               placeholder="Filter teams" autocomplete="off"
               data-filter="${id}" ${canWrite ? "" : "disabled"}>
        <div class="swap__list" data-list="${id}">
          ${pick.options.map((option) => renderOption(pick, option, canWrite && !locked)).join("")}
        </div>
      </div>`;
}

/**
 * One row of the list. The slot's own team is marked current; when the slot is
 * locked that row also wears the lock, so the list agrees with the slot head
 * about what is committed and the row reads as "not yours to tap" rather than
 * merely selected. A team the other slot has locked wears the lock too, so
 * the two lists of a two-pick week agree with each other about what is
 * committed. A row whose game has been played is marked settled: it is kept
 * in view as a record of the week, but it is not a row anyone can take.
 */
function renderOption(pick, option, canPick) {
  const locked = option.isCurrent && Boolean(pick.status.locked);
  const held = Boolean(option.siblingLocked) && !option.isCurrent;
  const classes = [
    "swap__option",
    option.isCurrent ? "swap__option--current" : "",
    locked ? "swap__option--locked" : "",
    option.disabled && !option.isCurrent ? "swap__option--disabled" : "",
    held ? "swap__option--held" : "",
    option.result ? "swap__option--settled" : "",
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
      <span class="swap__team">
        ${locked || held ? LOCK_ICON : ""}<span class="swap__name">${escapeHtml(option.team)}</span>${option.isCoach ? '<span class="swap__tag">Coach</span>' : ""}
      </span>
      <span class="swap__matchup">${escapeHtml(formatMatchup(option.site, option.opponent))}</span>
      ${line(option)}
    </button>`;
}

/**
 * The right-hand end of a row: the spread and the win probability it implies,
 * side by side in the tier's colour. A row that cannot be taken says why
 * instead - or how it went, when the reason is that it has been played - since
 * its numbers are not in play. Whole percentages here: the
 * list runs to forty rows on a phone, and the decimal is on the slot above.
 */
function line(option) {
  // Its game is over: the spread is history and the row is not a choice, so it
  // reads as the outcome, in the outcome's colour rather than the tier's.
  if (option.result) {
    return `<span class="swap__line swap__line--${option.result === "W" ? "won" : "lost"}">
        <span class="swap__spread">${option.result === "W" ? "Won" : "Lost"}</span>
      </span>`;
  }

  const contents = option.reason
    ? `<span class="swap__spread">${escapeHtml(option.reason)}</span>`
    : `<span class="swap__spread">${escapeHtml(formatSpread(option.spread))}</span>
        <span class="swap__prob">${escapeHtml(formatPercent(option.winProb, 0))}</span>`;
  return `<span class="swap__line swap__line--${option.tier}">
        ${contents}
      </span>`;
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
        ${metric("Win prob", line ? formatPercent(line.winProb) : "—", false, line?.tier)}
        ${metric("Line", line ? (line.source === "market" ? "Market" : "Projected") : "—", true)}
      </div>`;
}

function metric(key, value, isText = false, tier = null) {
  return `<div>
    <div class="metric__key">${escapeHtml(key)}</div>
    <div class="metric__value${isText ? " metric__value--text" : ""}${tier ? ` confidence--${tier}` : ""}">${escapeHtml(value)}</div>
  </div>`;
}
