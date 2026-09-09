/**
 * The pitch: the season drawn as a football field, sideways.
 *
 * Kickoff on the left, the end zone on the right, one yard line per week. The
 * ball stands on the week on the clock; a chalk bracket marks the week being
 * looked at, which need not be the same one. Each week carries a mark for what
 * it holds - solid chalk for a lock, the flag for a pick, dashed flag for the
 * coach's plan, the outcome's chalk once the game is played - and names the
 * pick under it, so the whole season reads off one strip. Under it, the drive
 * line: where the ball is, what the pool forgives, what a pick being weighed
 * would do, and how far the season is from the end zone on today's numbers.
 *
 * On a phone the field is wider than the screen and scrolls sideways under
 * end zones held at either edge, so a week gets a column wide enough to read;
 * on a desktop every week fits. The field is the week navigator: tap a yard
 * line to look at that week, or walk them with the arrow keys.
 *
 * Rendered once per board; a week change moves the bracket in place
 * (markViewing) and brings the week into view rather than rebuilding the
 * strip. Handlers are injected; this module knows nothing about the store.
 */

import { formatPercent, timeAgo, escapeHtml } from "../core/format.js";
import { formatDuration } from "../core/refresh.js";

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

/**
 * The ball, in the flag's colour with its laces in the flag's ink (tokens.css):
 * one seam most of the way along it and the short laces crossing it. Short on
 * purpose - drawn any longer at 22px they read as a hash, not laces. The gate
 * (ui/name.js), the startup ball (index.html) and the home-screen icons
 * (scripts/build-icons.mjs) draw the same ball.
 */
const BALL = `<svg class="pitch__ball" viewBox="0 0 34 21" aria-hidden="true">
  <ellipse cx="17" cy="10.5" rx="15.6" ry="9.2" style="fill: var(--flag); stroke: var(--on-flag)" stroke-width="1.5" />
  <path d="M9.5 10.5h15M12 8.6v3.8M14.5 8.6v3.8M17 8.6v3.8M19.5 8.6v3.8M22 8.6v3.8" style="stroke: var(--on-flag)" stroke-width="1.6" stroke-linecap="round" />
</svg>`;

/**
 * The arrow before the "if locked" number.
 *
 * Its own element so it can be lifted. The display face draws the arrow around
 * the middle of its x-height, well under the middle of the figures beside it -
 * measured at 0.14em of the two ink centres apart - so left alone it sits
 * below the number rather than level with it. Hidden from a screen reader,
 * which reads the number and the key above it and needs no glyph for "to".
 */
const PREVIEW_ARROW = `<span class="pitch__stat-arrow" aria-hidden="true">→</span>`;

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
      <div class="pitch__field" role="group" tabindex="0"
           aria-label="Weeks. Tap a yard line to look at a week.">
        <div class="pitch__zone pitch__zone--kickoff" aria-hidden="true"><span>Kickoff</span></div>
        <div class="pitch__track" style="--weeks:${board.weeks.length}">
          ${board.weeks.map((week) => yardMarkup(week, board, viewWeek)).join("")}
        </div>
        <div class="pitch__zone pitch__zone--end" aria-hidden="true"><span>Survive</span></div>
      </div>
      <div class="pitch__drive">
        <div class="pitch__stats">${stats(board)}</div>
        <span class="pitch__tag${season.out ? " pitch__tag--out" : ""}" data-cell="survival"
              title="The chance of surviving the whole season on today's numbers, every buy back counted">
          <span class="pitch__tag-key">${season.out ? "Season" : "Season survival"}</span>
          <span class="pitch__tag-value">${escapeHtml(season.value)}</span>
        </span>
      </div>
    </div>`;

  const field = root.querySelector(".pitch__field");
  // By place in the field, not by week number: a pool starting after week one
  // has its first yard line somewhere other than week 1.
  const jumpTo = (index) => {
    const at = Math.min(Math.max(index, 0), board.weeks.length - 1);
    const week = board.weeks[at].week;
    markViewing(root, week);
    handlers.onWeekChange(week);
  };

  field.addEventListener("click", (event) => {
    const yard = event.target.closest("[data-yard]");
    if (yard) jumpTo(Number(yard.dataset.yard) - 1);
  });

  // Keyboard equivalent of the tap, for anyone not on a touchscreen.
  field.addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const current = viewingIndex(root);
    jumpTo(Number.isFinite(step) ? current + step : step < 0 ? 0 : board.weeks.length - 1);
  });

  bringIntoView(root, viewWeek, "auto");
  markChange(root, board.league, before, season.probability);
}

/** Move the chalk bracket to a week without rebuilding the field. */
export function markViewing(root, week) {
  for (const yard of root.querySelectorAll("[data-yard]")) {
    yard.classList.toggle("pitch__yard--viewing", Number(yard.dataset.yard) === week);
  }
  bringIntoView(root, week, "smooth");
}

/**
 * Scroll the field so a week sits in the middle of it, where the field is
 * wider than the screen. Measured against the field itself rather than the
 * page, so the board does not move.
 */
function bringIntoView(root, week, behavior) {
  const field = root.querySelector(".pitch__field");
  const yard = root.querySelector(`[data-yard="${week}"]`);
  if (!field || !yard || field.scrollWidth <= field.clientWidth + 1) return;
  const fieldBox = field.getBoundingClientRect();
  const yardBox = yard.getBoundingClientRect();
  const within = yardBox.left - fieldBox.left + field.scrollLeft;
  const target = within - (field.clientWidth - yardBox.width) / 2;
  field.scrollTo({ left: Math.max(0, target), behavior });
}

function viewingIndex(root) {
  return [...root.querySelectorAll("[data-yard]")].findIndex((yard) =>
    yard.classList.contains("pitch__yard--viewing"),
  );
}

/**
 * One week's yard line. The mark at its top says what the week holds; the
 * label under the ball names the pick, whoever chose it.
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
      <span class="pitch__num">${week.week}</span>
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

/**
 * The drive's readouts: where the ball is, what the pool forgives, and either
 * what a pick being weighed would do to the season or when the lines next
 * refresh. The countdown is ticked in place by app.js rather than re-rendered.
 */
function stats(board) {
  const items = [];
  if (board.eliminated) {
    items.push(stat("Eliminated", `Wk ${board.eliminatedWeek}`));
    items.push(stat("Final record", `${board.record.won}-${board.record.lost}`));
  } else {
    items.push(stat("Week", `${board.currentWeek} of ${board.weeks.at(-1)?.week ?? 0}`));
    if (board.buyBack) {
      const left = board.buyBack.left;
      items.push(
        stat("Buy backs", left === 0 ? "Spent" : `${left} in hand`, left === 0 ? "spent" : ""),
      );
    }
  }

  if (!board.eliminated && board.previewPathProbability !== null) {
    // Judged as shown: a preview that rounds to the same tenth of a percent as
    // the season number reads as even, however the unrounded pair fall.
    const change =
      formatPercent(board.previewPathProbability) === formatPercent(board.pathProbability)
        ? "even"
        : board.previewPathProbability > board.pathProbability
          ? "better"
          : "worse";
    items.push(
      stat(
        "If locked",
        `${PREVIEW_ARROW}${escapeHtml(formatPercent(board.previewPathProbability))}`,
        `preview-${change}`,
        true,
      ),
    );
  } else {
    items.push(
      stat(
        "Lines",
        `<span id="countdown">${escapeHtml(formatDuration(board.nextRefreshAt - Date.now()))}</span> · ${escapeHtml(timeAgo(board.updatedAt))}`,
        "",
        true,
      ),
    );
  }
  return items.join("");
}

function stat(key, value, modifier = "", raw = false) {
  return `<span class="pitch__stat${modifier ? ` pitch__stat--${modifier}` : ""}">
      <span class="pitch__stat-key">${escapeHtml(key)}</span>
      <span class="pitch__stat-value">${raw ? value : escapeHtml(value)}</span>
    </span>`;
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

  // A move the readout cannot show is no move: the pulse waits for the shown
  // figure to change, not the number behind it.
  if (typeof from === "number" && formatPercent(from) !== formatPercent(to)) {
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
