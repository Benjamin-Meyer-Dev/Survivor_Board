/**
 * Sideways drags, for turning the board from one week to the next.
 *
 * The week follows the finger. It used to wait for it: the gesture was
 * recognised on touchend and only then did a fixed exit and entrance play, so
 * even at a solid sixty frames the board answered a beat after the hand had
 * finished asking. Nothing was dropped, and it still felt slow, because the
 * part of a swipe a person reads is the part their finger is still in.
 *
 * So the card, the team list and the drive move with the drag, and the release
 * either finishes the turn from wherever it got to or springs it back. A drag
 * that is too short, or too much up-and-down to be a swipe, is a spring back
 * and turns nothing.
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
 * @param {() => Array<{clip:HTMLElement, moves:HTMLElement}>} handlers.parts The
 *   regions to move, as element pairs, freshly looked up per gesture: a box
 *   that clips the travel and the thing inside it that moves across. Only those
 *   on screen, so a panel behind another tab is not dragged.
 * @param {(direction:1|-1) => boolean} handlers.canTurn Whether there is a week
 *   that way. A drag towards nothing rubber-bands and springs back.
 * @param {(direction:1|-1) => void} handlers.turn Turn the week: called once
 *   the regions have travelled off their own edge, with 1 for a drag to the
 *   left - the way you push a page aside to bring the next one on - and -1 for
 *   a drag to the right. The caller renders the new week and plays it in.
 * @param {object} [options]
 * @param {HTMLElement[]} [options.surfaces] The elements to watch. Listeners
 *   are bound once and read the event's target, so the markup under them can be
 *   rebuilt as often as a render likes.
 * @param {string[]} [options.ignore] Selectors the gesture must not start
 *   inside: anything modal over the top, and anything a drag already means
 *   something in.
 */
export function watchDrags({ parts, canTurn, turn }, { surfaces = [], ignore = [] } = {}) {
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
    current.width = current.parts[0]?.clip.getBoundingClientRect().width ?? 0;
    for (const { clip, moves } of current.parts) {
      clip.classList.add("is-dragging");
      moves.classList.remove("is-slide-in");
    }
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
    // A week that is not there pulls against you rather than moving.
    const offset = canTurn(direction) ? drag.across : drag.across * RUBBER;
    for (const { moves } of drag.parts) moves.style.transform = `translateX(${offset}px)`;
  }

  async function finish(current, cancelled) {
    const direction = current.across < 0 ? 1 : -1;
    const turning =
      !cancelled && Math.abs(current.across ?? 0) >= DISTANCE_PX && canTurn(direction);

    settling = true;
    dragged = true;
    try {
      for (const { moves } of current.parts) {
        moves.classList.add("is-drag-settling");
        // From wherever the finger left it: the rest of the way off its own
        // edge, or back where it came from.
        moves.style.transform = turning ? `translateX(${direction * -100}%)` : "";
        if (turning) moves.style.opacity = "0";
      }
      // Reduced motion has no settle to wait for, and no travel either.
      if (!prefersReducedMotion() && current.parts.length) {
        await afterMotion(current.parts[0].moves, { subtree: false });
      }

      for (const { clip, moves } of current.parts) {
        moves.classList.remove("is-drag-settling");
        moves.style.removeProperty("transform");
        moves.style.removeProperty("opacity");
        if (!turning) clip.classList.remove("is-dragging");
      }

      // The clip stays on for the arriving week, which travels the same way.
      if (turning) turn(direction);
    } finally {
      settling = false;
      // Long enough for the click the release would have produced to have been
      // dispatched and swallowed, and no longer.
      setTimeout(() => {
        dragged = false;
      }, 0);
    }
  }
}
