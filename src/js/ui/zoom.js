/**
 * Hold the browser's zoom, so a pinch on the board does nothing.
 *
 * The board is laid out for one hand and a phone-width screen, and every
 * target on it is sized for a thumb already. Nothing on it rewards a zoom, and
 * a zoom costs something: the page is a fixed shell with a drawer pinned to the
 * bottom of the viewport, so a pinch leaves the field off centre with the
 * drawer half off screen and no obvious way back except reloading and losing
 * the week you were on. A double tap is worse - it lands on a team as a pick.
 *
 * Most of that is settled without any JavaScript. `user-scalable=no` in the
 * viewport tag stops Android and an iOS app opened from the home screen, and
 * `touch-action: pan-x pan-y` on the document stops the pinch and the double
 * tap everywhere touch-action is honoured, while leaving both pans alone - the
 * page scrolls, the field still pans its yard lines, and ui/swipe.js still gets
 * its surfaces.
 *
 * What is left is Safari in a tab, which has ignored `user-scalable=no` since
 * iOS 10 and zooms the visual viewport over the top of touch-action. It does
 * send the old WebKit gesture events, one per pinch, and a pinch that is
 * refused at `gesturestart` never starts. So this listens for those three and
 * refuses them, which on every other browser costs one listener that never
 * fires.
 *
 * Not passive, obviously: the whole point is preventDefault. And on the
 * document rather than a region, because the gesture is the viewport's and does
 * not belong to whatever happens to be under the fingers.
 */

/** The WebKit pinch events. `gesturestart` is the one that decides. */
const GESTURES = ["gesturestart", "gesturechange", "gestureend"];

/** So a second call - a reload of the module, a test - binds nothing twice. */
let held = false;

/**
 * Refuse the browser's own zoom gestures for the life of the page.
 *
 * Called once at startup, before anything is on screen, since a pinch during
 * the startup layer would zoom the same way a pinch on the board does.
 */
export function holdTheZoom() {
  if (held) return;
  held = true;

  for (const type of GESTURES) {
    document.addEventListener(type, preventZoom, { passive: false });
  }
}

/**
 * @param {Event} event A pinch the browser is offering to zoom with.
 */
function preventZoom(event) {
  event.preventDefault();
}
