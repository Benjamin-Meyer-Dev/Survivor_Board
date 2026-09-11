/**
 * The start screen: what to call you.
 *
 * Shown once per device, before anything else, and it is the whole of the
 * identity this app has. There are no accounts and nothing is verified: the
 * name rides along on the picks and locks so a league can say who did what,
 * and it is stored on the phone that typed it.
 *
 * This is the screen the old passcode gate used to be, and it wears the field
 * (ui/stadium.js, shared with the home page) and its card (the `.gate__*`
 * block in components.css) because the job is the same: hold the app back
 * behind one field, on the field, while the board loads behind it.
 *
 * Rendering and the form only: app.js decides whether a name is needed and
 * what to do with it.
 */

import { APP_NAME } from "../config.js";
import { stadiumMarkup } from "./stadium.js";
import { showGate, hideGate } from "./gate.js";

/**
 * Render the start screen into `root` and resolve with a trimmed name.
 *
 * @param {HTMLElement} root
 * @param {{name?:string, heading?:string, label?:string, action?:string}} [options]
 *   `name` prefills the field, for a change of name rather than a first run.
 * @returns {Promise<string>}
 */
export function requireName(root, { name = "", heading, label, action } = {}) {
  return new Promise((resolve) => {
    root.innerHTML = startMarkup({ name, heading, label, action });
    showGate(root);

    const form = root.querySelector("form");
    const input = root.querySelector("input");
    const error = root.querySelector(".gate__error");

    // Focus, but not on a phone: bringing the keyboard up over the stadium
    // before anyone has looked at it is a worse first frame than an empty
    // field, and the field is the only thing on screen to tap.
    if (!matchMedia("(hover: none)").matches) input.focus();

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = input.value.trim().slice(0, 40);
      if (!value) {
        error.textContent = "A name is how the others know which picks are yours.";
        input.focus();
        return;
      }
      // The card leaves before the screen behind it changes: the door, the
      // name and the board are one sequence (ui/gate.js).
      await hideGate(root);
      resolve(value);
    });
  });
}

function startMarkup({ name, heading, label, action }) {
  return `
    ${stadiumMarkup()}

    <form class="gate__card" novalidate>
      <p class="gate__brand">${APP_NAME}</p>
      <h1 class="gate__label" id="gate-label">${heading ?? "Who's picking?"}</h1>
      <p class="gate__hint">
        ${label ?? "Your name goes on the picks you make, so everyone in a league knows whose they are. It stays on this device."}
      </p>
      <div class="gate__field">
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
      <p class="gate__error" role="alert"></p>
      <button type="submit" class="gate__btn">${action ?? "Start"}</button>
    </form>`;
}

/** Values reach here from localStorage, so the quote is the one that matters. */
function escapeAttribute(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
}
