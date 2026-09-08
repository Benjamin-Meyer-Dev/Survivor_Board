/**
 * The pitch: the season drawn as a football field, sideways.
 *
 * Kickoff on the left, the end zone on the right, one yard line per week. The
 * ball stands on the week on the clock; a chalk bracket marks the week being
 * looked at, which need not be the same one. Each week carries a mark for what
 * it holds - solid chalk for a lock, the flag for a pick, dashed flag for the
 * coach's plan, the outcome's chalk once the game is played - so the whole
 * season reads off one strip. Under it, the drive line: where the ball is,
 * what the pool forgives, and how far the season is from the end zone on
 * today's numbers.
 *
 * The field is the week navigator. Tap a yard line to look at that week; press
 * and hold, then slide, and the bracket runs under the finger. What it reads is
 * the position along the field rather than which line was hit, so a week owns
 * its whole column, not just its line.
 *
 * Rendered once per board; a week change moves the bracket in place
 * (markViewing) rather than rebuilding the strip under a finger that is still
 * on it. Handlers are injected; this module knows nothing about the store.
 */

import { formatPercent, timeAgo, escapeHtml } from "../core/format.js";
import { formatDuration } from "../core/refresh.js";

/** Hold the field this long and it becomes a scrubber under the finger. */
const HOLD_MS = 200;

/** Or slide this far sideways from where the press landed, whichever is first. */
const SLIDE_PX = 6;

/** How long the season number wears the colour of its change (see motion.css). */
const PULSE_MS = 1400;

/**
 * The last season number shown for each league. Held while a search is owed
 * and compared against when the new number lands. Keyed by league so a switch
 * never shows one pool's number on the other's board.
 */
const shown = new Map();

/** The change the season number is currently wearing, resumed across renders. */
let pulse = null;

/** The ball, in the flag's colour with its laces in the flag's ink (tokens.css). */
const BALL = `<svg class="pitch__ball" viewBox="0 0 34 21" aria-hidden="true">
  <ellipse cx="17" cy="10.5" rx="15.6" ry="9.2" style="fill: var(--flag); stroke: var(--on-flag)" stroke-width="1.5" />
  <path d="M11.6 10.5h10.8M14 7.6v5.8M17 7.1v6.8M20 7.6v5.8" style="stroke: var(--on-flag)" stroke-width="1.8" stroke-linecap="round" />
</svg>`;

/**
 * @param {HTMLElement} root
 * @param {object} board Result of buildBoard().
 * @param {number} viewWeek The week being looked at (1-based).
 * @param {{onWeekChange:(week:number)=>void}} handlers
 */
export function renderPitch(root, board, viewWeek, handlers) {
  const before = shown.get(board.league)?.probability;
  const season = seasonSurvival(board);

  root.innerHTML = `
    <div class="pitch">
      <div class="pitch__field" style="--weeks:${board.weeks.length}" role="group" tabindex="0"
           aria-label="Weeks. Tap a yard line to look at a week, or hold and slide.">
        <div class="pitch__zone pitch__zone--kickoff" aria-hidden="true"><span>Kickoff</span></div>
        ${board.weeks.map((week) => yardMarkup(week, board, viewWeek)).join("")}
        <div class="pitch__zone pitch__zone--end" aria-hidden="true"><span>Survive</span></div>
      </div>
      <div class="pitch__drive">
        <div class="pitch__drive-text">
          <span class="pitch__drive-line">${escapeHtml(driveLine(board))}</span>
          <span class="pitch__drive-note">${driveNote(board)}</span>
        </div>
        <span class="pitch__tag${season.out ? " pitch__tag--out" : ""}" data-cell="survival"
              title="Chance of surviving the whole season on today's numbers">
          <span class="pitch__tag-value">${escapeHtml(season.value)}</span>
          <span>${season.out ? "season over" : "to the end zone"}</span>
        </span>
      </div>
    </div>`;

  const field = root.querySelector(".pitch__field");
  const jumpTo = (index) => {
    const week = Math.min(Math.max(index, 0), board.weeks.length - 1) + 1;
    markViewing(root, week);
    handlers.onWeekChange(week);
  };

  // Keyboard equivalent of the tap, for anyone not on a touchscreen.
  field.addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const current = viewingIndex(root);
    jumpTo(Number.isFinite(step) ? current + step : step < 0 ? 0 : board.weeks.length - 1);
  });

  attachScrubber(field, jumpTo);
  markChange(root, board.league, before, season.probability);
}

/** Move the chalk bracket to a week without rebuilding the field. */
export function markViewing(root, week) {
  for (const yard of root.querySelectorAll("[data-yard]")) {
    yard.classList.toggle("pitch__yard--viewing", Number(yard.dataset.yard) === week);
  }
}

function viewingIndex(root) {
  return [...root.querySelectorAll("[data-yard]")].findIndex((yard) =>
    yard.classList.contains("pitch__yard--viewing"),
  );
}

/**
 * One week's yard line. The mark at its top says what the week holds; the
 * label under it names the pick where the field is wide enough to show one
 * (components.css shows it from 900px).
 */
function yardMarkup(week, board, viewWeek) {
  const now = week.week === board.currentWeek && !board.eliminated;
  const moot = board.eliminated && week.week > board.eliminatedWeek;
  const { mark, team, says } = weekMark(week);
  const classes = [
    "pitch__yard",
    week.week % 5 === 0 ? "pitch__yard--five" : "",
    now ? "pitch__yard--now" : "",
    week.week === viewWeek ? "pitch__yard--viewing" : "",
    moot ? "pitch__yard--moot" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `<button type="button" class="${classes}" data-yard="${week.week}" tabindex="-1"
      aria-label="Week ${week.week}, ${escapeHtml(week.labelFull)}${says ? `, ${escapeHtml(says)}` : ""}">
      ${mark ? `<span class="pitch__mark pitch__mark--${mark}"></span>` : ""}
      ${team ? `<span class="pitch__label">${escapeHtml(team)}</span>` : ""}
      ${week.week % 5 === 0 ? `<span class="pitch__num">${week.week}</span>` : ""}
      ${now ? BALL : ""}
    </button>`;
}

/**
 * What a week holds, as one mark. A loss outranks everything (it is the
 * story of the season), then a win, then a lock, then a pick, then the
 * coach's plan. The label is the first slot's team, whoever chose it.
 */
function weekMark(week) {
  const picks = week.picks;
  const first = picks[0];
  const team = first?.team ?? first?.suggestion?.team ?? "";
  if (picks.some((pick) => pick.status.result === "L")) return { mark: "lost", team, says: "lost" };
  if (picks.some((pick) => pick.status.result === "W")) return { mark: "won", team, says: "won" };
  if (picks.some((pick) => pick.status.locked)) {
    return { mark: "locked", team, says: `${team} locked in` };
  }
  if (picks.some((pick) => pick.team)) return { mark: "picked", team, says: `${team} picked` };
  if (picks.some((pick) => pick.suggestion)) {
    return { mark: "coach", team, says: `coach suggests ${team}` };
  }
  return { mark: null, team: "", says: "" };
}

/** Where the ball is, and what the pool forgives. Short: it shares a row. */
function driveLine(board) {
  if (board.eliminated) {
    return `Eliminated wk ${board.eliminatedWeek} · final ${board.record.won}-${board.record.lost}`;
  }
  const where = `Wk ${board.currentWeek} of ${board.weeks.length}`;
  if (!board.buyBack) return `${where} · no buy backs`;
  if (board.buyBack.left === 0) return `${where} · buy back spent`;
  const count = board.buyBack.left;
  return `${where} · ${count} buy back${count === 1 ? "" : "s"} in hand`;
}

/**
 * The second line: what a pick being weighed would do to the season, while
 * one is; otherwise when the lines next refresh. The countdown is ticked in
 * place by app.js rather than re-rendered.
 */
function driveNote(board) {
  if (!board.eliminated && board.previewPathProbability !== null) {
    const change =
      board.previewPathProbability > board.pathProbability
        ? "better"
        : board.previewPathProbability < board.pathProbability
          ? "worse"
          : "even";
    return `<span class="pitch__preview pitch__preview--${change}">→ ${escapeHtml(formatPercent(board.previewPathProbability))} if locked</span>`;
  }
  return `Lines refresh in <span id="countdown">${escapeHtml(formatDuration(board.nextRefreshAt - Date.now()))}</span> · updated ${escapeHtml(timeAgo(board.updatedAt))}`;
}

function seasonSurvival(board) {
  if (board.eliminated) return { value: "Out", out: true };
  if (board.recommendationPending && !board.recommendationStale) {
    // A search is owed and no plan stands in. The last number holds, so the
    // number moves once, from here, rather than via a flash of dots.
    const last = shown.get(board.league);
    if (last) return last;
    return { value: "…" };
  }
  const probability = board.pathProbability;
  const cell = { probability, value: formatPercent(probability) };
  shown.set(board.league, cell);
  return cell;
}

/**
 * Say which way the season number went rather than that it moved: the number
 * cuts to its new value and wears the direction's colour for a beat (the
 * keyframes in motion.css), then eases back. Nothing dims, nothing shifts.
 */
function markChange(root, league, from, to) {
  const el = root.querySelector('[data-cell="survival"] .pitch__tag-value');
  if (!el || typeof to !== "number") return;

  if (typeof from === "number" && from !== to) {
    pulse = {
      league,
      to,
      direction: to > from ? "is-rising" : "is-falling",
      startedAt: performance.now(),
    };
  }
  if (!pulse || pulse.league !== league || pulse.to !== to) return;
  const elapsed = performance.now() - pulse.startedAt;
  if (elapsed >= PULSE_MS) return;

  el.classList.add(pulse.direction);
  // A negative delay starts the fresh node's keyframe part way through, where
  // the one the render just destroyed had got to.
  if (elapsed > 0) el.style.animationDelay = `-${Math.round(elapsed)}ms`;
}

/**
 * The field as one control. A tap goes to the week under it; a press held for
 * a beat - or slid sideways, whichever comes first - hands the bracket to the
 * finger, which then runs through the weeks as it moves.
 *
 * @param {HTMLElement} field
 * @param {(index:number) => void} jumpTo
 */
function attachScrubber(field, jumpTo) {
  /** The press under way, or null. Its centres are measured once, at the down. */
  let press = null;
  /** Set by a scrub, so the click its release fires does not jump again. */
  let swallowClick = false;

  const goTo = (x) => {
    const index = nearestCentre(press.centres, x);
    if (index === press.index) return;
    press.index = index;
    jumpTo(index);
  };

  const engage = (x) => {
    if (!press || press.live) return;
    press.live = true;
    swallowClick = true;
    field.classList.add("pitch__field--scrubbing");
    // Keeps the moves coming once the finger leaves the field, which on a
    // phone it will. A render can replace the field mid-press, and capturing
    // on a node no longer in the page throws.
    if (field.isConnected) field.setPointerCapture(press.id);
    goTo(x);
  };

  const end = () => {
    if (!press) return;
    clearTimeout(press.hold);
    if (press.live) {
      field.classList.remove("pitch__field--scrubbing");
      if (field.hasPointerCapture(press.id)) field.releasePointerCapture(press.id);
    }
    press = null;
  };

  field.addEventListener("pointerdown", (event) => {
    if (event.button > 0) return;
    end();
    swallowClick = false;
    press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      centres: yardCentres(field),
      index: viewingIndex(field),
      live: false,
      hold: setTimeout(() => engage(event.clientX), HOLD_MS),
    };
  });

  field.addEventListener("pointermove", (event) => {
    if (!press || event.pointerId !== press.id) return;
    if (press.live) {
      event.preventDefault();
      goTo(event.clientX);
      return;
    }
    const dx = Math.abs(event.clientX - press.x);
    const dy = Math.abs(event.clientY - press.y);
    // Sideways is a scrub before the hold is up. Downwards is the page being
    // scrolled, and the press was only ever on the way past.
    if (dx > SLIDE_PX && dx > dy) engage(event.clientX);
    else if (dy > SLIDE_PX) end();
  });

  for (const type of ["pointerup", "pointercancel"]) {
    field.addEventListener(type, (event) => {
      if (press && event.pointerId === press.id) end();
    });
  }

  field.addEventListener("click", (event) => {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    // A click with no pointer behind it - a screen reader activating a yard -
    // has no position to read, so that yard's own week is the answer.
    const yard = event.detail === 0 ? event.target.closest("[data-yard]") : null;
    jumpTo(yard ? Number(yard.dataset.yard) - 1 : nearestCentre(yardCentres(field), event.clientX));
  });
}

function yardCentres(field) {
  return [...field.querySelectorAll("[data-yard]")].map((yard) => {
    const box = yard.getBoundingClientRect();
    return box.left + box.width / 2;
  });
}

/** Past either end this settles on the end itself. */
function nearestCentre(centres, x) {
  let best = 0;
  for (const [index, centre] of centres.entries()) {
    if (Math.abs(centre - x) < Math.abs(centres[best] - x)) best = index;
  }
  return best;
}
