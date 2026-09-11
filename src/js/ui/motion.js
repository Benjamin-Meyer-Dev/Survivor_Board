/**
 * Waiting for motion to finish, in one place.
 *
 * Every timing in the app used to be written twice: once as a duration in a
 * stylesheet and once as a millisecond count in the module that had to know
 * when the move was over. The two drifted - a keyframe shortened in motion.css
 * left a class hanging on for an extra beat, a keyframe lengthened had its
 * class stripped mid-flight - and nothing in the repo could catch it.
 *
 * So the timings live in the stylesheets alone and this module asks the
 * browser. `getAnimations` reports CSS transitions as well as keyframes, so one
 * helper covers both, and it forces a style flush, which is what lets a caller
 * add a class and wait for it on the next line.
 *
 * The timeout is a guard, not a schedule: an animation that never ends, or one
 * the browser never started because the element was not rendered, must not
 * strand the caller that is waiting to swap a page.
 */

/**
 * How long to wait for motion that should already have finished. Every move in
 * the app is a fraction of a second; anything still running after this is not a
 * transition, it is a bug, and the caller should carry on regardless.
 */
const GUARD_MS = 1200;

export function prefersReducedMotion() {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Resolve once every animation and transition on `node` and its children has
 * finished.
 *
 * An effect's keyframes sit on a slot's children and its ::after, staggered, so
 * they end at different times. Listening for animationend on the slot heard the
 * FIRST of them bubble up and dropped the class while the rest were still
 * running: a ring or a wash was cut short, and on a pick the numbers and actions
 * fell through to the settle keyframe mid-flight and played again from the
 * start. An animation cancelled by a re-render counts as finished, and with
 * motion reduced there is nothing to wait for.
 *
 * @param {Element|null} node
 * @param {{subtree?:boolean, guard?:number}} [options] `subtree` off waits only
 *   for the node's own motion, which is what a page leaving wants: its
 *   children's entrance keyframes are not part of its exit.
 * @returns {Promise<void>}
 */
export function afterMotion(node, { subtree = true, guard = GUARD_MS } = {}) {
  if (!node || prefersReducedMotion()) return Promise.resolve();

  const animations = node.getAnimations?.({ subtree }) ?? [];
  if (animations.length === 0) return Promise.resolve();

  const finished = Promise.allSettled(animations.map((animation) => animation.finished));
  return Promise.race([finished, wait(guard)]).then(() => undefined);
}

/**
 * Add classes, let them play, and take them off again.
 *
 * The pattern every one-shot in the app follows. Removing the classes and
 * reading offsetWidth before adding them is what makes a second play actually
 * play: a finished animation left in place does nothing when its class is
 * re-added, because as far as the browser is concerned nothing changed.
 *
 * @param {Element|null} node
 * @param {string[]} classes
 * @param {{subtree?:boolean, keep?:string[]}} [options] `keep` names classes
 *   applied here that the caller clears itself.
 * @returns {Promise<void>} Resolves when the classes have come off.
 */
export async function playOnce(node, classes, { subtree = true, keep = [] } = {}) {
  if (!node) return;
  node.classList.remove(...classes);
  if (prefersReducedMotion()) return;
  // Forces the browser to drop the finished animation before it is re-added,
  // so a second play is a play rather than nothing at all.
  void node.offsetWidth;
  node.classList.add(...classes);
  await afterMotion(node, { subtree });
  node.classList.remove(...classes.filter((name) => !keep.includes(name)));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve after the browser has had a chance to paint. One frame schedules the
 * work; the second runs after the frame that included it has gone out.
 */
export function twoFrames() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/* --- higher-level moves -----------------------------------------------------
   Everything below is built out of the two primitives above: add a class, ask
   the browser when it is over, take it off. The durations stay in motion.css;
   what these pass down is only ever a DISTANCE the stylesheet cannot know - a
   measured height, or how far a node has to travel - as a custom property the
   keyframe reads. A helper that took a millisecond count would put a second
   copy of a timing in the repo, which is the thing this module exists to
   stop. */

/** Dialogs part way through their exit, so a re-open can call the close off. */
const closing = new WeakSet();

/**
 * Shut a dialog on its own motion.
 *
 * `close()` is instant and takes the top layer with it, so the exit has to
 * play first and the close follows it. Every way out of a sheet comes through
 * here - the cross, Cancel, the backdrop, Esc, and the button that acts - so
 * there is one exit rather than one per path, and the ones that cut used to be
 * whichever path the CSS's discrete display transition did not cover.
 *
 * @param {HTMLDialogElement|null} dialog
 * @param {{now?:boolean}} [options] `now` skips the exit, for a dialog being
 *   shut because the thing it is about has gone.
 */
export async function closeDialog(dialog, { now = false } = {}) {
  if (!dialog?.open || closing.has(dialog)) return;
  if (now || prefersReducedMotion()) {
    dialog.close();
    return;
  }
  closing.add(dialog);
  dialog.classList.add("is-closing");
  await afterMotion(dialog, { subtree: false });
  // A re-open while the exit was playing takes the sheet off this list, and
  // then the close it was heading for is not ours to make.
  if (closing.delete(dialog)) dialog.close();
  dialog.classList.remove("is-closing");
}

/** Call off an exit in flight, for a sheet being opened again. */
export function keepOpen(dialog) {
  if (!dialog) return;
  closing.delete(dialog);
  dialog.classList.remove("is-closing");
}

/**
 * A block arriving in place: nothing, to its own height.
 *
 * The height is measured here because only the DOM knows it; how long the
 * growth takes is the stylesheet's (see `grow` in motion.css).
 */
export async function grow(node) {
  if (!node || prefersReducedMotion()) return;
  node.style.setProperty("--motion-to", `${node.offsetHeight}px`);
  await playOnce(node, ["is-growing"], { subtree: false });
  node.style.removeProperty("--motion-to");
}

/**
 * And one leaving: its own height back to nothing, and then it goes. The node
 * is removed here rather than by the caller, because until the shrink is over
 * it still has to be on the page to shrink.
 */
export async function shrink(node) {
  if (!node) return;
  if (prefersReducedMotion()) {
    node.remove();
    return;
  }
  node.style.setProperty("--motion-from", `${node.offsetHeight}px`);
  node.classList.add("is-shrinking");
  await afterMotion(node, { subtree: false });
  node.remove();
}

/**
 * Replace a region's contents with the old going out over the new coming in,
 * and the box travelling between the two heights.
 *
 * The old markup is lifted into a layer of its own and taken out of flow, so
 * the new contents lay out at once and the box has a height to travel to. Both
 * are measured here; both durations are in the stylesheet.
 *
 * @param {HTMLElement|null} box Its own positioning context (`position:
 *   relative`) - the outgoing layer is absolute inside it.
 * @param {string} html
 * @returns {Promise<void>} Resolves when the box is its new size with only the
 *   new contents in it.
 */
export async function swapContents(box, html) {
  if (!box) return;
  if (prefersReducedMotion()) {
    box.innerHTML = html;
    return;
  }

  const from = box.offsetHeight;
  const leaving = document.createElement("div");
  leaving.className = "motion-leaving";
  leaving.setAttribute("aria-hidden", "true");
  leaving.append(...box.childNodes);

  box.innerHTML = html;
  const arriving = [...box.children];
  box.append(leaving);

  const to = box.offsetHeight;
  box.style.setProperty("--motion-from", `${from}px`);
  box.style.setProperty("--motion-to", `${to}px`);
  for (const node of arriving) node.classList.add("is-arriving");

  await playOnce(box, ["is-resizing"], { subtree: false });
  leaving.remove();
  for (const node of arriving) node.classList.remove("is-arriving");
  box.style.removeProperty("--motion-from");
  box.style.removeProperty("--motion-to");
}

/**
 * Where a set of keyed nodes are on screen, to move them from there once a
 * render has put them somewhere else (`settleInto`).
 *
 * @param {Iterable<HTMLElement>} nodes Each carrying a `data-key`.
 * @returns {Map<string,DOMRect>}
 */
export function capturePlaces(nodes) {
  const places = new Map();
  if (prefersReducedMotion()) return places;
  for (const node of nodes) {
    const key = node.dataset?.key;
    if (key !== undefined) places.set(key, node.getBoundingClientRect());
  }
  return places;
}

/**
 * Move nodes from where they were to where they now are.
 *
 * The page has already been laid out by the time this runs, so each node is
 * put back at its old offset and released: the browser animates the gap it was
 * never asked to jump. A node the render did not move is left alone, and one
 * that was not on the page before has nowhere to come from and arrives on its
 * own entrance instead.
 *
 * @param {Iterable<HTMLElement>} nodes
 * @param {Map<string,DOMRect>} places From capturePlaces, before the render.
 */
export function settleInto(nodes, places) {
  if (prefersReducedMotion() || places.size === 0) return;
  for (const node of nodes) {
    const was = places.get(node.dataset?.key);
    if (!was) continue;
    const now = node.getBoundingClientRect();
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    // Under a pixel is not a move anybody made; it is the rounding of a
    // layout that did not change.
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    node.style.setProperty("--motion-dx", `${dx}px`);
    node.style.setProperty("--motion-dy", `${dy}px`);
    playOnce(node, ["is-moving"], { subtree: false }).then(() => {
      node.style.removeProperty("--motion-dx");
      node.style.removeProperty("--motion-dy");
    });
  }
}
