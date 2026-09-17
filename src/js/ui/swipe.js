/**
 * Sideways drags, for turning the board from one week to the next.
 *
 * The week follows the finger. It used to wait for it: the gesture was
 * recognised on touchend and only then did a fixed exit and entrance play, so
 * even at a solid sixty frames the board answered a beat after the hand had
 * finished asking. Nothing was dropped, and it still felt slow, because the
 * part of a swipe a person reads is the part their finger is still in.
 *
 * So the card, the model read and the team list move with the drag,
 * with the adjacent week's already-rendered copy following behind a narrow
 * strip of turf. The release either finishes that one continuous turn from
 * wherever it got to or springs both copies back. A drag that is too short,
 * or too much up-and-down to be a swipe, is a spring back and turns nothing.
 *
 * Pointer events, which this file argued against for years and can now use.
 * The objection was real: the board scrolls vertically, so the moment a finger
 * moved on it Chrome handed the gesture to that scroller and sent
 * `pointercancel` - even for a dead-horizontal drag, because `touch-action:
 * auto` lets it pan either way. Constraining touch-action on the board would
 * have fixed that and broken the field, whose yard lines pan sideways inside
 * the same board and cannot pan if an ancestor forbids it. The fix is to stop
 * treating the whole board as the gesture: the surfaces that turn are the
 * week's card and the drawer's two week panels, each of which wants `pan-y` and
 * nothing else, and the field is not inside any of them.
 *
 * Distance and dominance, not speed. A slow deliberate drag across the card
 * means the same as a fast flick, and a phone dropping frames must not change
 * what a gesture does.
 */

import { afterMotion, prefersReducedMotion } from "./motion.js";

/** How far sideways a gesture travels before it is a drag rather than a tap. */
const SLOP_PX = 10;

/** And how far before releasing it turns the week rather than springing back. */
const DISTANCE_PX = 48;

/**
 * How much more sideways than up-and-down. A drag inside this cone is somebody
 * scrolling with a wobble, so it turns nothing.
 */
const DOMINANCE = 1.4;

/**
 * How far a drag towards a week that is not there is allowed to pull. The ends
 * of the run hold rather than wrap - week 18 is the end of the season - and a
 * quarter of the travel is enough to say so while making clear the board heard
 * the drag.
 */
const RUBBER = 0.25;

/**
 * Watch the regions that turn with the week.
 *
 * @param {object} handlers
 * @param {() => Array<{key:string, clip:HTMLElement, moves:HTMLElement}>} handlers.parts
 *   The regions to move, freshly looked up per gesture: a box that clips the
 *   travel and the thing inside it that moves across. Only those on screen, so
 *   a panel behind another tab is not dragged.
 * @param {(direction:1|-1) => boolean} handlers.canTurn Whether there is a week
 *   that way. A drag towards nothing rubber-bands and springs back.
 * @param {(direction:1|-1, options:{alreadyVisible:boolean}) => void} handlers.turn
 *   Turn the week once the regions reach their final position, with 1 for a
 *   drag to the left and -1 for a drag to the right. `alreadyVisible` says the
 *   staged week is covering the frame while the caller adopts it.
 * @param {(direction:1|-1, parts:Array<object>) => Array<HTMLElement|null>} [handlers.stage]
 *   Render the adjacent week for each moving region. The returned nodes are
 *   laid beside their current counterparts and do not become interactive; the
 *   real render is adopted under them at the end of the move.
 * @param {(progress:number, phase:"drag"|"settle"|"done") => void} [handlers.track]
 *   Follow the turn somewhere that is not itself a page. Progress is -1 for
 *   the previous week, +1 for the next and fractional while under the finger.
 * @param {object} [options]
 * @param {HTMLElement[]} [options.surfaces] The elements to watch. Listeners
 *   are bound once and read the event's target, so the markup under them can be
 *   rebuilt as often as a render likes.
 * @param {string[]} [options.ignore] Selectors the gesture must not start
 *   inside: anything modal over the top, and anything a drag already means
 *   something in.
 */
export function watchDrags(
  { parts, canTurn, turn, stage, track },
  { surfaces = [], ignore = [] } = {},
) {
  /** The drag in hand: where it started, which pointer, and what it is moving. */
  let drag = null;
  /** Set for the length of the release, so a second finger cannot cut in. */
  let settling = false;
  /** A drag has just ended, so the click it would otherwise produce is not one. */
  let dragged = false;
  let frame = 0;

  for (const surface of surfaces.filter(Boolean)) {
    surface.addEventListener("pointerdown", (event) => {
      drag = null;
      if (settling || !event.isPrimary) return;
      if (ignore.some((selector) => event.target?.closest?.(selector))) return;
      drag = { x: event.clientX, y: event.clientY, id: event.pointerId, surface, moving: false };
    });

    surface.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const across = event.clientX - drag.x;
      const down = event.clientY - drag.y;

      if (!drag.moving) {
        // Up-and-down first: this is a scroll, and the browser is welcome to
        // it. Deciding once, rather than per move, is what stops a drag that
        // wandered from being read as a swipe at the end of it.
        if (Math.abs(down) > SLOP_PX && Math.abs(down) >= Math.abs(across)) {
          drag = null;
          return;
        }
        if (Math.abs(across) < SLOP_PX) return;
        if (Math.abs(across) < Math.abs(down) * DOMINANCE) return;
        drag.across = across;
        begin(drag);
      }

      drag.across = across;
      // One write per frame, however many moves the platform delivers.
      if (!frame) frame = requestAnimationFrame(paint);
    });

    const release = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const finished = drag;
      drag = null;
      if (!finished.moving) return;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      finish(finished, event.type === "pointercancel");
    };

    surface.addEventListener("pointerup", release);
    surface.addEventListener("pointercancel", release);

    // A drag across the team list must not also pick the team it started on.
    // The click cannot be prevented before it exists, so it is swallowed on the
    // way down instead.
    surface.addEventListener(
      "click",
      (event) => {
        if (!dragged) return;
        event.preventDefault();
        event.stopPropagation();
      },
      { capture: true },
    );
  }

  function begin(current) {
    current.moving = true;
    current.parts = parts();
    current.gap = swipeGap(current.surface);
    current.travel = Math.max(1, current.surface.getBoundingClientRect().width + current.gap);
    for (const { clip, moves } of current.parts) {
      clip.classList.add("is-dragging");
      moves.classList.remove("is-slide-in");
      moves.classList.add("is-swipe-current");
    }
    stageDirection(current, current.across < 0 ? 1 : -1);
    // Keeps the moves coming once the finger leaves the region it started in.
    try {
      current.surface.setPointerCapture(current.id);
    } catch {
      /* a pointer the platform has already let go of: the drag still works */
    }
  }

  function paint() {
    frame = 0;
    if (!drag?.moving) return;
    const direction = drag.across < 0 ? 1 : -1;
    stageDirection(drag, direction);
    // A week that is not there pulls against you rather than moving.
    const turnable = canTurn(direction);
    const offset = turnable ? drag.across : drag.across * RUBBER;
    for (const part of drag.parts) {
      part.moves.style.transform = `translateX(${offset}px)`;
      if (part.incoming) {
        part.incoming.style.transform = beside(direction, drag.gap, offset);
      }
    }
    const progress = turnable ? Math.max(-1, Math.min(1, -offset / drag.travel)) : 0;
    track?.(progress, "drag");
  }

  /** Put the week on the approached side of the frame, changing sides on a reversal. */
  function stageDirection(current, direction) {
    const shouldStage = Boolean(stage && canTurn(direction));
    const intact =
      current.parts.length > 0 &&
      current.parts.every(({ clip, incoming }) => incoming?.parentElement === clip);
    if (current.direction === direction && (!shouldStage || intact)) return;

    current.direction = direction;
    clearIncoming(current.parts);
    if (!shouldStage) return;

    // A full render deliberately clears an in-progress turn. If one lands
    // between pointer moves, the long-lived frames are still the same nodes;
    // restore their clip/current markers as the adjacent page is restaged.
    for (const { clip, moves } of current.parts) {
      clip.classList.add("is-dragging");
      moves.classList.add("is-swipe-current");
    }

    const incoming = stage(direction, current.parts) ?? [];
    current.parts.forEach((part, index) => {
      const node = incoming[index];
      if (!node) return;

      // Match the current region exactly. This matters most for the model read,
      // whose height is allotted by the surrounding layout rather than by its
      // graph, and for drawer panels whose content begins inside their padding.
      node.classList.add("is-swipe-preview");
      node.setAttribute("aria-hidden", "true");
      node.inert = true;
      node.style.left = `${part.moves.offsetLeft}px`;
      node.style.top = `${part.moves.offsetTop}px`;
      node.style.width = `${part.moves.offsetWidth}px`;
      node.style.height = `${part.moves.offsetHeight}px`;
      node.style.transform = beside(direction, current.gap);
      part.clip.append(node);
      part.incoming = node;
    });
  }

  async function finish(current, cancelled) {
    const direction = current.across < 0 ? 1 : -1;
    const turning =
      !cancelled && Math.abs(current.across ?? 0) >= DISTANCE_PX && canTurn(direction);

    stageDirection(current, direction);
    const alreadyVisible =
      turning &&
      current.parts.length > 0 &&
      current.parts.every(({ clip, incoming }) => incoming?.parentElement === clip);

    // A render landing in the middle of the gesture may have cleared a staged
    // copy. In that rare case use the old exit/entrance fallback as a complete
    // pair rather than showing some regions twice and some once.
    if (turning && !alreadyVisible) clearIncoming(current.parts);

    settling = true;
    dragged = true;
    try {
      track?.(turning ? direction : 0, "settle");
      for (const { moves, incoming } of current.parts) {
        moves.classList.add("is-drag-settling");
        // From wherever the finger left it: the rest of the way off its own
        // edge, or back where it came from.
        moves.style.transform = turning ? beside(-direction, current.gap) : "";
        if (turning && !alreadyVisible) moves.style.opacity = "0";
        if (incoming) {
          incoming.classList.add("is-drag-settling");
          incoming.style.transform = turning ? "" : beside(direction, current.gap);
        }
      }
      // Reduced motion has no settle to wait for, and no travel either.
      if (!prefersReducedMotion() && current.parts.length) {
        await afterMotion(current.parts[0].moves, { subtree: false });
      }

      // While the staged week covers the frame, render that same week into the
      // real, interactive nodes waiting just off screen. Removing the cover and
      // putting those nodes in place in this task is visually atomic, so the
      // graph never empties and redraws between the two halves of a turn.
      if (turning && alreadyVisible) turn(direction, { alreadyVisible: true });

      for (const { clip, moves, incoming } of current.parts) {
        incoming?.remove();
        moves.classList.remove("is-drag-settling", "is-swipe-current");
        moves.style.removeProperty("transform");
        moves.style.removeProperty("opacity");
        // The fallback entrance still needs its clip until its own keyframe is
        // over; turnWeek owns that half exactly as it did before staging.
        if (!turning || alreadyVisible) clip.classList.remove("is-dragging");
      }

      if (turning && !alreadyVisible) turn(direction, { alreadyVisible: false });
    } finally {
      // A committed turn has moved the tracker's real base to this visual
      // endpoint. Dropping its temporary progress in the same task leaves it
      // exactly where it arrived; a spring-back is already at zero.
      track?.(0, "done");
      settling = false;
      // Long enough for the click the release would have produced to have been
      // dispatched and swallowed, and no longer.
      setTimeout(() => {
        dragged = false;
      }, 0);
    }
  }

  /** The small piece of turf kept between two week pages. */
  function swipeGap(node) {
    const value = getComputedStyle(node).getPropertyValue("--week-swipe-gap");
    return Math.max(0, Number.parseFloat(value) || 0);
  }

  /** One page just beyond an edge, plus the gap and any distance under the finger. */
  function beside(direction, gap, offset = 0) {
    return `translateX(calc(${direction * 100}% + ${direction * gap + offset}px))`;
  }

  function clearIncoming(partsToClear) {
    for (const part of partsToClear) {
      part.incoming?.remove();
      part.incoming = null;
    }
  }
}
