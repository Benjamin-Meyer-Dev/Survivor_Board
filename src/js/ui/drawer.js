/**
 * The drawer's grab: the handle that raises it over the field.
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
