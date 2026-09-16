/**
 * The start screen: what to call you - or, on a phone that is not your first,
 * which of the people the app already knows you are.
 *
 * Shown once per device, before anything else, and it is the whole of the
 * identity this app has. There are no accounts and nothing is verified: the
 * name rides along on the picks and locks so a league can say who did what,
 * and it is stored on the phone that typed it. The second way in is the id
 * the first phone was given (core/code.js): typed here, it makes this phone
 * that person - leagues, picks and member row (claimId in store/directory.js)
 * - so nobody joins their own league a second time for having a new phone.
 *
 * This is the screen the old passcode gate used to be, and it wears the field
 * (ui/stadium.js, shared with the home page) and its card (the `.gate__*`
 * block in components.css) because the job is the same: hold the app back
 * behind one field, on the field, while the board loads behind it.
 *
 * Rendering and the form only: app.js decides whether a name is needed and
 * what to do with either answer.
 */

import { APP_NAME } from "../config.js";
import { isPersonId, normalisePersonId } from "../core/code.js";
import { stadiumMarkup } from "./stadium.js";
import { showGate, hideGate } from "./gate.js";

const NAME_HINT =
  "Your name goes on the picks you make, so everyone in a league knows whose they are. It stays on this device.";
const CLAIM_HINT =
  "It is under Who's picking? on your other phone. This phone becomes you there: same leagues, same picks, no second member.";

/**
 * Render the start screen into `root` and resolve with a trimmed name.
 *
 * @param {HTMLElement} root
 * @param {{name?:string, heading?:string, label?:string, action?:string,
 *   onClaim?:(id:string) => Promise<string>}} [options]
 *   `name` prefills the field, for a change of name rather than a first run.
 *   `onClaim` takes the id off another phone and makes this device that
 *   person; it resolves with their name, or "" when their member rows carry
 *   none, and rejects with a message to show. Without it the screen asks for
 *   a name and nothing else.
 * @returns {Promise<string>}
 */
export function requireName(root, { name = "", heading, label, action, onClaim = null } = {}) {
  return new Promise((resolve) => {
    root.innerHTML = startMarkup({ name, heading, label, action, claimable: Boolean(onClaim) });
    showGate(root);

    const form = root.querySelector("form");
    const title = root.querySelector(".gate__label");
    const hint = root.querySelector(".gate__hint");
    const error = root.querySelector(".gate__error");
    const button = root.querySelector(".gate__btn");
    const fields = {
      name: root.querySelector('[data-mode="name"]'),
      claim: root.querySelector('[data-mode="claim"]'),
    };
    const inputOf = (mode) => fields[mode].querySelector("input");
    let mode = "name";

    // Focus, but not on a phone: bringing the keyboard up over the stadium
    // before anyone has looked at it is a worse first frame than an empty
    // field, and the field is the only thing on screen to tap.
    const focus = (input) => {
      if (!matchMedia("(hover: none)").matches) input.focus();
    };

    /** One card, two questions: swap the field, the words and the button. */
    const show = (next, { title: said } = {}) => {
      mode = next;
      for (const [key, field] of Object.entries(fields)) {
        if (field) field.hidden = key !== next;
      }
      for (const alt of root.querySelectorAll(".gate__alt")) {
        alt.hidden = alt.dataset.show === next;
      }
      title.textContent =
        said ?? (next === "claim" ? "Which one are you?" : (heading ?? "Who's picking?"));
      hint.textContent = next === "claim" ? CLAIM_HINT : (label ?? NAME_HINT);
      button.textContent = next === "claim" ? "Continue" : (action ?? "Start");
      error.textContent = "";
      focus(inputOf(next));
    };

    for (const alt of root.querySelectorAll(".gate__alt")) {
      alt.addEventListener("click", () => show(alt.dataset.show));
    }
    focus(inputOf("name"));

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (mode === "claim") {
        await claim();
        return;
      }
      const value = inputOf("name").value.trim().slice(0, 40);
      if (!value) {
        error.textContent = "A name is how the others know which picks are yours.";
        inputOf("name").focus();
        return;
      }
      // The card leaves before the screen behind it changes: the door, the
      // name and the board are one sequence (ui/gate.js).
      await hideGate(root);
      resolve(value);
    });

    /**
     * The other phone's id. Found, this phone is that person and the card
     * goes; found but nameless, the card turns back into the name question;
     * refused, the reason stands under the field and the id stays put to be
     * corrected.
     */
    async function claim() {
      const typed = inputOf("claim").value;
      if (!isPersonId(typed)) {
        error.textContent = "An ID is eight characters, like K7QM-3WXP.";
        inputOf("claim").focus();
        return;
      }
      button.disabled = true;
      try {
        const claimed = await onClaim(normalisePersonId(typed));
        if (claimed) {
          await hideGate(root);
          resolve(claimed);
          return;
        }
        show("name", { title: "And your name?" });
      } catch (failure) {
        error.textContent = failure?.message || "That did not go through. Try again.";
      } finally {
        button.disabled = false;
      }
    }
  });
}

function startMarkup({ name, heading, label, action, claimable }) {
  return `
    ${stadiumMarkup()}

    <form class="gate__card" novalidate>
      <p class="gate__brand">${APP_NAME}</p>
      <h1 class="gate__label" id="gate-label">${heading ?? "Who's picking?"}</h1>
      <p class="gate__hint">${label ?? NAME_HINT}</p>
      <div class="gate__field" data-mode="name">
        <input
          class="gate__input"
          type="text"
          name="name"
          value="${escapeAttribute(name)}"
          maxlength="40"
          autocomplete="name"
          autocapitalize="words"
          spellcheck="false"
          aria-labelledby="gate-label"
          placeholder="Ben"
        />
      </div>
      ${
        claimable
          ? `<div class="gate__field" data-mode="claim" hidden>
        <input
          class="gate__input gate__input--code"
          type="text"
          name="id"
          maxlength="18"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          aria-labelledby="gate-label"
          placeholder="K7QM-3WXP"
        />
      </div>`
          : ""
      }
      <p class="gate__error" role="alert"></p>
      <button type="submit" class="gate__btn">${action ?? "Start"}</button>
      ${
        claimable
          ? `<button type="button" class="gate__alt" data-show="claim">Already picking on another phone? Enter your ID</button>
      <button type="button" class="gate__alt" data-show="name" hidden>New here? Enter your name instead</button>`
          : ""
      }
    </form>`;
}

/** Values reach here from localStorage, so the quote is the one that matters. */
function escapeAttribute(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
}
