/**
 * Hold the platform's back gesture while a board is open.
 *
 * This is a web page, and on Android a swipe in from the edge of the screen is
 * the system's own back gesture. The board's own sideways drag turns the week
 * (ui/swipe.js), so the two gestures are the same movement: a drag rightwards
 * that starts near the left edge asks for the previous week and gets a
 * navigation instead - away from the board, and out of the app entirely where
 * it was opened from an invite link.
 *
 * Half of that was already dealt with in the stylesheet. Chrome will also
 * navigate on a horizontal *overscroll*, and `overscroll-behavior-x: contain`
 * on the document and on the field turns that off (base.css, components.css).
 * The system gesture is not overscroll and no stylesheet reaches it.
 *
 * What does reach it is a close watcher. A close request - Escape, the Android
 * back gesture, the back button in a standalone window - is offered to the most
 * recently created watcher before it becomes a navigation, so a watcher that
 * does nothing with it is a gesture that does nothing: the board stays put. The
 * way off a board is the way back in the league bar, which is where it has
 * always been.
 *
 * One watcher, held only while a board is up, because the home page has nothing
 * to protect and back there should leave as it always did. A close request
 * spends the watcher it was offered to, so a fresh one is armed on the way out
 * of the handler and the next gesture is held too.
 *
 * A modal sheet keeps its own close: the browser gives every open `<dialog>` a
 * watcher of its own, created after this one and so offered the request first,
 * which is exactly the behaviour anyone would expect from back with a sheet
 * open. Nothing here interferes with that.
 *
 * Where there is no CloseWatcher the gesture cannot be reached at all and this
 * does nothing, quietly - the board behaves as it did before. Every current
 * Android browser has one; iOS Safari's own edge swipe is a system gesture no
 * page can hold.
 */

/** The watcher in hand, or null when a board is not what is showing. */
let watcher = null;

/**
 * Start swallowing back while a board is open. Safe to call again: the second
 * call keeps the watcher the first one armed.
 *
 * @returns {boolean} Whether the gesture is being held. False means the
 *   platform has no close watcher to hold it with.
 */
export function holdBack() {
  if (watcher) return true;
  if (typeof CloseWatcher !== "function") return false;

  try {
    watcher = new CloseWatcher();
  } catch {
    // Watchers are rationed per interaction, and one that cannot be had is not
    // worth reporting: back keeps its old behaviour for this gesture.
    watcher = null;
    return false;
  }

  watcher.addEventListener("close", () => {
    // Spent. Swallowing the request is the whole of the handling - there is
    // nothing on a board that back should close - and the next one needs a
    // watcher of its own.
    watcher = null;
    holdBack();
  });

  return true;
}

/** Let back mean what it usually means again: the home page's behaviour. */
export function releaseBack() {
  watcher?.destroy();
  watcher = null;
}
