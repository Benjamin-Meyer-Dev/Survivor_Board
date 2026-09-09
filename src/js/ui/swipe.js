/**
 * Sideways swipes, for turning the board from one week to the next.
 *
 * The deck this app used to have was a scroll-snap track of full-screen week
 * slides, so swiping between weeks was the browser's own scrolling. The board
 * is one screen now - the field across the top, the week's card under it, the
 * drawer beneath - and none of it scrolls sideways, so the gesture has to be
 * recognised rather than inherited.
 *
 * Touch events rather than pointer events, which is not the house idiom and is
 * deliberate. The board scrolls vertically, so the moment a finger moves on it
 * Chrome hands the gesture to that scroller and sends `pointercancel` - even
 * for a dead-horizontal drag, because `touch-action: auto` lets it pan either
 * way. A pointer-based swipe therefore never sees its second move. Constraining
 * `touch-action` would fix that and break the field, whose yard lines pan
 * sideways inside the same board and cannot pan if an ancestor forbids it.
 * Touch events keep arriving through a scroll, so the gesture is always whole.
 *
 * Nothing here calls preventDefault: every listener is passive, so a swipe can
 * never take a scroll away from the browser. What separates the two is the
 * shape of the gesture - a swipe is far enough sideways, and enough more
 * sideways than up, that a flick down the team list can never read as one.
 *
 * Distance and dominance, not speed. A slow deliberate drag across the card
 * means the same as a fast flick, and a phone dropping frames must not change
 * what a gesture does.
 */

/** How far sideways a gesture travels before it is a swipe rather than a tap. */
const DISTANCE_PX = 48;

/**
 * And how much more sideways than up-and-down. A drag inside this cone is
 * somebody scrolling with a wobble, so it turns nothing.
 */
const DOMINANCE = 1.4;

/**
 * Watch an element for sideways swipes.
 *
 * @param {HTMLElement|null} root The element to watch. Listeners are bound
 *   once and read the event's target, so the markup under it can be rebuilt as
 *   often as a render likes.
 * @param {(direction:1|-1) => void} onSwipe Called with 1 for a swipe to the
 *   left - the way you push a page aside to bring the next one on - and -1 for
 *   a swipe to the right.
 * @param {object} [options]
 * @param {string[]} [options.ignore] Selectors the gesture must not start
 *   inside: anything that pans sideways itself, anything modal over the top,
 *   and anything a drag already means something in.
 */
export function watchSwipes(root, onSwipe, { ignore = [] } = {}) {
  if (!root) return;

  /** The finger in hand: where it started, and which one it is. */
  let from = null;

  root.addEventListener(
    "touchstart",
    (event) => {
      from = null;
      // A second finger is a pinch or a stray palm, not a swipe.
      if (event.touches.length !== 1) return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      if (ignore.some((selector) => event.target.closest?.(selector))) return;
      from = { x: touch.clientX, y: touch.clientY, id: touch.identifier };
    },
    { passive: true },
  );

  // A finger joining mid-gesture ends it: whatever this is, it is not the
  // one-finger swipe that started.
  root.addEventListener(
    "touchmove",
    (event) => {
      if (from && event.touches.length > 1) from = null;
    },
    { passive: true },
  );

  root.addEventListener(
    "touchend",
    (event) => {
      const touch = [...event.changedTouches].find((each) => each.identifier === from?.id);
      if (!from || !touch) return;
      const across = touch.clientX - from.x;
      const down = touch.clientY - from.y;
      from = null;
      if (Math.abs(across) < DISTANCE_PX) return;
      if (Math.abs(across) < Math.abs(down) * DOMINANCE) return;
      onSwipe(across < 0 ? 1 : -1);
    },
    { passive: true },
  );

  // The system has taken the touch - a call, the app going to the background,
  // the finger leaving the edge of the screen. It was never a swipe.
  root.addEventListener(
    "touchcancel",
    () => {
      from = null;
    },
    { passive: true },
  );
}
