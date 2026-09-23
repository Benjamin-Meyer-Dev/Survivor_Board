/**
 * Opening the drawer over the field: the grab that does it, and the swipe that
 * does it without looking.
 *
 * A phone cannot show the readout and the drawer at once. Stacked, the field,
 * the drive line and the week's call take six tenths of the screen, and in a
 * college pool - two slots, two of everything - rather more than that; what
 * was left for a hundred-team list was four rows, which is enough to see that
 * there is a list and not enough to work one. So the drawer shuts instead: it
 * comes down to its grab and its tab bar, resting on the bottom edge, and the
 * readout has the screen. Asked for, it opens - the field folds away, the call
 * keeps its head and puts each slot on a single line, and the list gets
 * everything they leave. Shutting it brings the field back.
 *
 * Three ways to ask, and the tab bar is the first of them: shut, the bar is
 * the whole of the drawer on the screen, and a tab is the name of a list, so a
 * tap on one is asking for that list (selectTab in app.js). The grab is the
 * second, and the only one that shuts it again by tapping - a bar that opened
 * and shut on the same tap would close under the thumb of somebody reaching
 * for the list they had just opened.
 *
 * The third is the drag, for the thumb that does not look: up on the grab to
 * open it (watchRaise). Only to open it - a drag down on the open drawer is
 * the list being scrolled, never a shut. The grab stays a button as well, because a gesture nobody can see is not a
 * control; it is the sign over the door rather than the only way through it.
 * The bar is left out of it - a drag that lands on a tab means the tab.
 *
 * A control rather than something that happens on scroll. A header that
 * collapses under the thumb has to pay for the height it gives up out of the
 * scroll that collapsed it, or the row somebody was reading jumps up the
 * screen by the height of the header; a tap has no row under it to disturb,
 * and it is reversible in the same place it was made.
 *
 * Which state it is in is the app's, not this module's - the board re-renders
 * on every pick, lock and landed search, and the drawer must not forget what
 * it was doing - so this draws the handle and reports the taps.
 *
 * The field keeps its focusable yard lines while it is folded away, which is
 * how a fold is different from a hide, so it is made inert on the way up and
 * live again on the way down. The panels shut away under the bar are the same
 * problem answered the other way round, and answered in the stylesheet: they
 * are hidden by visibility on a screen that has a shut state at all, which is
 * a question about the shape of the screen that layout.css is already asking.
 */

import { prefersReducedMotion } from "./motion.js";

/** Latest handler, so the listener bound on the first render stays current. */
let onGrab = () => {};
let bound = false;

/**
 * @param {HTMLElement} grab The button.
 * @param {HTMLElement} folded The part of the readout the open folds away.
 * @param {boolean} raised
 * @param {() => void} onToggle
 * @param {{hidden?:boolean}} [options] `hidden` takes the handle off the
 *   board: a run that is over has emptied the drawer, and an open that folds
 *   the field away to make room for nothing is a control with nothing behind
 *   it. The caller shuts the drawer before it asks for this.
 */
export function renderGrab(grab, folded, raised, onToggle, { hidden = false } = {}) {
  if (!grab) return;
  onGrab = onToggle;

  if (!bound) {
    bound = true;
    grab.addEventListener("click", () => onGrab());
  }

  grab.hidden = hidden;

  grab.setAttribute("aria-pressed", String(raised));
  const label = grab.querySelector(".drawer__grab-label");
  if (label) {
    label.textContent = raised
      ? "Close the drawer and show the field"
      : "Open the drawer over the field";
  }
  if (folded) folded.inert = raised;
}

/** How far a drag travels before it is a gesture rather than a touch. */
const SLOP_PX = 12;

/**
 * And how much more up-and-down than sideways. Below this the drag is the
 * week's (ui/swipe.js), which reads the same surfaces and claims the cone this
 * one leaves alone.
 */
const DOMINANCE = 1.4;

/**
 * Watch the shut drawer for the drag that opens it.
 *
 * Touch only, and deliberately: this is the gesture a thumb makes at a list
 * that has no room, and every other pointer has the grab, the keyboard and a
 * screen where the open is not needed in the first place.
 *
 * Shut, the drawer is told to pan nothing (layout.css), so the drag is ours
 * from the first pixel and there is no race with a scroll that has already
 * started - which is the whole reason the rule is there. Open, the drawer is
 * left alone entirely: a drag down on an open list is somebody scrolling it,
 * and shutting the drawer under them for it took the list away mid-read. The
 * grab is the way back.
 *
 * The tab bar sits on the same head and is deliberately not watched: a tab is
 * a name to tap, and a drag that lands on one means the tab.
 *
 * @param {object} handlers
 * @param {() => boolean} handlers.raisable Whether this screen shuts its
 *   drawer at all - a desktop and a phone held sideways do not, and on those
 *   the drag is the browser's scroll and nothing else.
 * @param {() => boolean} handlers.raised Whether it is open now.
 * @param {() => void} handlers.toggle
 * @param {{surfaces?: HTMLElement[]}} [options] The parts to watch. Bound once
 *   and read per touch, so the markup inside them is a render's business.
 */
export function watchRaise({ raisable, raised, toggle }, { surfaces = [] } = {}) {
  for (const surface of surfaces.filter(Boolean)) {
    /** Where the touch in hand began, while it could still be an open. */
    let start = null;

    surface.addEventListener(
      "touchstart",
      (event) => {
        start = null;
        if (event.touches.length !== 1 || !raisable() || raised()) return;
        const touch = event.touches[0];
        start = { x: touch.clientX, y: touch.clientY };
      },
      { passive: true },
    );

    surface.addEventListener(
      "touchmove",
      (event) => {
        if (!start) return;
        if (event.touches.length !== 1) {
          start = null;
          return;
        }
        const touch = event.touches[0];
        const down = touch.clientY - start.y;
        const across = touch.clientX - start.x;
        if (Math.abs(down) < SLOP_PX) return;
        // Sideways is the week's drag, and down on a shut drawer is nothing.
        // Decided once, so a gesture that wandered is not read at the end of it.
        const up = down < 0 && Math.abs(down) >= Math.abs(across) * DOMINANCE;
        start = null;
        if (!up || raised()) return;
        // Nothing else happens to this touch: no bounce, no tap on the grab.
        event.preventDefault();
        toggle();
      },
      { passive: false },
    );

    const drop = () => {
      start = null;
    };
    surface.addEventListener("touchend", drop, { passive: true });
    surface.addEventListener("touchcancel", drop, { passive: true });
  }
}

/* --- the lift ---------------------------------------------------------------
   The open used to be a squeeze: the field's row ran down to nothing, the
   coach's case faded, and the drawer's track grew into what they gave up, all
   of it the browser laying the board out again on every frame. It read as the
   board rearranging itself, not as anything being opened.

   So the open is a sheet now. The call and the drawer are one surface, and
   they slide up over the field and the case - which stand still where they
   were, to be covered - and down again to show them. The layout still switches
   between the two states it always had, but in one frame: every transition on
   the board is held for the switch, the new places are read, and the call and
   the drawer are put back where they were and let go on an animation made by
   script, which the coach's size container cannot cancel (ownMotion in
   ui/motion.js) and which runs on the compositor.

   What stands still is held in place by the stylesheet (.is-lifting in
   layout.css): on the way up the field and the case are lifted out of the flow
   at the pixels they stood on, since the open layout has no room for them; on
   the way down the drawer keeps its open height, so the chalkboard reaches the
   bottom edge all the way down and its list is still on it. */

/** The lift in flight, so a tap in the middle of it can take it over. */
let lifting = null;

/**
 * Open or shut the drawer as a sheet over the readout.
 *
 * @param {HTMLElement|null} board
 * @param {boolean} raised Where it is going.
 * @param {() => void} apply Puts the board in that state (the class, the grab).
 */
export function liftDrawer(board, raised, apply) {
  const readout = board?.querySelector(":scope > .readout");
  const call = readout?.querySelector(":scope > #call");
  const drawer = board?.querySelector(":scope > .drawer");
  const held = [
    readout?.querySelector(":scope > #pitch"),
    readout?.querySelector(":scope > #coach"),
  ].filter(Boolean);

  // Read before anything is settled: a lift turned round half way starts from
  // where it has got to, not from where it was going.
  const before = call && drawer ? { call: box(call), drawer: box(drawer) } : null;
  const stood = held.map((node) => ({ node, at: box(node) }));
  lifting?.();

  const duration = board
    ? durationOf(getComputedStyle(board).getPropertyValue("--drawer-lift"))
    : 0;
  if (!before || !readout || prefersReducedMotion() || !(duration > 0)) {
    apply();
    return;
  }

  board.classList.add("is-lift-snap", "is-lifting");
  apply();

  const origin = box(readout);
  if (raised) {
    // The field and the case where they stood, for the sheet to come up over.
    for (const { node, at } of stood) {
      if (!(at.height > 0)) continue;
      node.classList.add("is-held");
      Object.assign(node.style, {
        top: `${at.top - origin.top}px`,
        left: `${at.left - origin.left}px`,
        width: `${at.width}px`,
        height: `${at.height}px`,
      });
    }
  } else {
    // The chalkboard at its open height, reaching the bottom edge on the way
    // down; the track under it is the shut one already.
    drawer.style.height = `${before.drawer.height}px`;
  }

  const after = { call: box(call), drawer: box(drawer) };
  board.classList.remove("is-lift-snap");
  // The open folds the card as it starts, so it sets off shorter than the
  // space it stood in and the drawer has further to come: the turf the card
  // is drawn on reaches down to the chalkboard until the two have met.
  const reach = before.drawer.top - before.call.top - (after.drawer.top - after.call.top);
  if (reach > 0) call.style.setProperty("--lift-reach", `${reach}px`);

  const timing = {
    duration,
    easing: getComputedStyle(board).getPropertyValue("--ease-out").trim() || "ease-out",
    fill: "backwards",
  };
  const moves = [
    [call, before.call.top - after.call.top],
    [drawer, before.drawer.top - after.drawer.top],
  ].map(([node, dy]) =>
    node.animate([{ translate: `0px ${dy}px` }, { translate: "0px 0px" }], timing),
  );

  const finish = () => {
    if (lifting !== finish) return;
    lifting = null;
    for (const move of moves) move.cancel();
    // Put down in one frame as well: the field going back into the flow is a
    // change the fold's own transitions would otherwise play out now, under a
    // sheet that has already arrived.
    board.classList.add("is-lift-snap");
    board.classList.remove("is-lifting");
    drawer.style.removeProperty("height");
    call.style.removeProperty("--lift-reach");
    for (const { node } of stood) {
      node.classList.remove("is-held");
      for (const side of ["top", "left", "width", "height"]) node.style.removeProperty(side);
    }
    void board.offsetWidth;
    board.classList.remove("is-lift-snap");
  };
  lifting = finish;
  Promise.allSettled(moves.map((move) => move.finished)).then(finish);
}

function box(node) {
  return node.getBoundingClientRect();
}

/** A CSS time as milliseconds. */
function durationOf(value) {
  const text = value.trim();
  const amount = parseFloat(text);
  if (!Number.isFinite(amount)) return 0;
  return text.endsWith("ms") ? amount : amount * 1000;
}
