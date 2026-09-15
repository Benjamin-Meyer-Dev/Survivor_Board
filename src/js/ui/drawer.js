/**
 * Raising the drawer over the field: the grab that does it, and the swipe that
 * does it without looking.
 *
 * A phone shows the readout and the drawer at once, which is right while you
 * are reading the week and wrong while you are working down a list of a
 * hundred teams. Stacked, the field, the drive line and the week's call take
 * six tenths of the screen, and in a college pool - two slots, two of
 * everything - rather more than that; what is left for the list is four rows.
 * So the drawer can be raised: the field folds away, the call keeps its head
 * and puts each slot on a single line, and the list gets the screen. Pulling
 * it back down brings the field with it.
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
 * live again on the way down.
 *
 * And the handle is not the only way to ask. Lowered, the list is three rows
 * of a hundred, and the thing a person does to a list three rows tall is drag
 * it up - so that is what raising it is: a drag up anywhere in the drawer, and
 * a drag down from the top of the list to put it back (watchRaise). The grab
 * stays, because a gesture nobody can see is not a control; it is the sign
 * over the door rather than the only way through it.
 */

/** Latest handler, so the listener bound on the first render stays current. */
let onGrab = () => {};
let bound = false;

/**
 * @param {HTMLElement} grab The button.
 * @param {HTMLElement} folded The part of the readout the raise folds away.
 * @param {boolean} raised
 * @param {() => void} onToggle
 */
export function renderGrab(grab, folded, raised, onToggle) {
  if (!grab) return;
  onGrab = onToggle;

  if (!bound) {
    bound = true;
    grab.addEventListener("click", () => onGrab());
  }

  grab.setAttribute("aria-pressed", String(raised));
  const label = grab.querySelector(".drawer__grab-label");
  if (label) {
    label.textContent = raised
      ? "Lower the drawer and show the field"
      : "Raise the drawer over the field";
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
 * Watch the drawer's panels for the drag that raises it, and the one that puts
 * it back.
 *
 * Touch only, and deliberately: this is the gesture a thumb makes at a list
 * that has no room, and every other pointer has the grab, the keyboard and a
 * screen where the raise is not needed in the first place.
 *
 * Lowered, the panels are told to pan nothing (layout.css), so the drag is
 * ours from the first pixel and there is no race with a scroll that has
 * already started - which is the whole reason the rule is there. Raised, they
 * scroll as they always did and only one drag is taken from them: down, from
 * the very top of the list, where there was nothing to scroll to anyway.
 *
 * One answer per touch. A drag that has been read is done being read, so a
 * long one cannot raise the drawer and then lower it again on the way back.
 *
 * @param {object} handlers
 * @param {() => boolean} handlers.raisable Whether this screen has a raise at
 *   all - a desktop and a phone held sideways do not, and on those the drag is
 *   the browser's scroll and nothing else.
 * @param {() => boolean} handlers.raised Whether it is up now.
 * @param {() => void} handlers.toggle
 * @param {{surfaces?: HTMLElement[]}} [options] The scrollers to watch. Bound
 *   once and read per touch, so the markup inside them is a render's business.
 */
export function watchRaise({ raisable, raised, toggle }, { surfaces = [] } = {}) {
  for (const surface of surfaces.filter(Boolean)) {
    /** The touch in hand: where it began, and whether the list was at its top. */
    let start = null;

    surface.addEventListener(
      "touchstart",
      (event) => {
        start = null;
        if (event.touches.length !== 1 || !raisable()) return;
        const touch = event.touches[0];
        // Where the list stood when the finger landed, not where it stands by
        // the time the drag is read: a drag down that began part way through
        // the list is that list being scrolled back, however far it has got.
        start = { x: touch.clientX, y: touch.clientY, atTop: surface.scrollTop <= 0 };
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
        // Sideways is the week's drag. Decided once, so a gesture that wandered
        // is not read as this one at the end of it.
        if (Math.abs(down) < Math.abs(across) * DOMINANCE) {
          start = null;
          return;
        }

        const { atTop } = start;
        const up = down < 0;
        start = null;

        if (up === raised()) return;
        // Down, only from the top. Anywhere else it is the list being scrolled
        // back, and taking that for a gesture would shut the drawer every time
        // somebody returned to the first row.
        if (!up && !atTop) return;
        // Nothing else happens to this touch: no scroll, no bounce, no tap on
        // whatever row it began on.
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
