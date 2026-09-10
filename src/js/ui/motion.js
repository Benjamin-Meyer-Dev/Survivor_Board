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
