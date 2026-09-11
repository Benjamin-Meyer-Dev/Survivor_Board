/**
 * Showing and hiding the first-run cards.
 *
 * The door (ui/passcode.js) and the name (ui/name.js) are the same screen with
 * different words in it: the stadium behind, one card on top, and a `hidden`
 * on the root that says whether it is the one being asked. Both used to change
 * over on that attribute alone, which is a cut - and they sit at the front of
 * the one sequence in the app that is nothing but first impressions, the door
 * to the name to the board.
 *
 * So the card rises in and lifts away, and the root's `hidden` waits for it.
 * The stadium is left alone on the way out: it is the same field the home page
 * draws, so what should read as changing is the card over it, not the ground
 * under it.
 */

import { afterMotion, prefersReducedMotion } from "./motion.js";

/** Put a gate up, with its card rising into place. */
export function showGate(root) {
  root.hidden = false;
  if (prefersReducedMotion()) return;
  const card = root.querySelector(".gate__card");
  if (!card) return;
  card.classList.add("is-entering");
  afterMotion(card, { subtree: false }).then(() => card.classList.remove("is-entering"));
}

/**
 * And take one down: the card lifts away first, and the root is hidden behind
 * it. Resolves once the gate is out of the layout, so the caller can carry on
 * with whatever it was holding back.
 *
 * @param {HTMLElement} root
 * @returns {Promise<void>}
 */
export async function hideGate(root) {
  const card = root.querySelector(".gate__card");
  if (card && !prefersReducedMotion()) {
    card.classList.add("is-leaving");
    await afterMotion(card, { subtree: false });
    card.classList.remove("is-leaving");
  }
  root.hidden = true;
}
