/**
 * The door: the app's access code, once per device.
 *
 * The first screen a new device sees, ahead of the name (ui/name.js) and of
 * everything else, so a league link sent to someone without the code opens
 * nothing. It wears the same field and the same card as the name screen - the
 * `.gate__*` block in components.css - because the job is the same: hold the
 * app behind one card, on the field, while the board loads behind it.
 *
 * This is the app's code, not a league's. A league's twelve-character code
 * gets a person into that league (ui/home.js, the Join sheet); this one gets a
 * device into the app at all, and the two never meet.
 *
 * Rendering and the form only. app.js says how a code is checked - the digest
 * and the salt are its to know - and what to do once one is right.
 */

import { stadiumMarkup } from "./stadium.js";

/**
 * Render the door into `root` and resolve once a code has passed the check.
 *
 * @param {HTMLElement} root
 * @param {{check:(typed:string) => Promise<boolean>}} handlers `check` says
 *   whether a code is the code. It is async because the check is a derivation
 *   that takes a phone a fraction of a second; the button waits on it.
 * @returns {Promise<void>}
 */
export function requirePasscode(root, { check }) {
  return new Promise((resolve) => {
    root.innerHTML = doorMarkup();
    root.hidden = false;

    const form = root.querySelector("form");
    const input = root.querySelector("input");
    const button = root.querySelector("button");
    const error = root.querySelector(".gate__error");

    // Focus, but not on a phone: the keyboard over the stadium before anyone
    // has looked at it is a worse first frame than an empty field, and the
    // field is the only thing on screen to tap.
    if (!matchMedia("(hover: none)").matches) input.focus();

    let checking = false;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (checking) return;
      const typed = input.value;
      if (!typed.trim()) {
        error.textContent = "The code is what lets this device in.";
        input.focus();
        return;
      }

      // The derivation takes a beat, and a button that did nothing for it
      // would be tapped again. `:disabled` wears the progress cursor.
      checking = true;
      button.disabled = true;
      error.textContent = "";
      let passed = false;
      try {
        passed = await check(typed);
      } catch {
        passed = false;
      }
      checking = false;
      button.disabled = false;

      if (!passed) {
        error.textContent = "That is not the code. Check it and try again.";
        input.select();
        input.focus();
        return;
      }
      root.hidden = true;
      resolve();
    });
  });
}

function doorMarkup() {
  return `
    ${stadiumMarkup()}

    <form class="gate__card" novalidate>
      <p class="gate__brand">Survivor Board</p>
      <h1 class="gate__label" id="gate-label">What's the code?</h1>
      <p class="gate__hint">
        This board is private. Enter the access code you were given; this device
        will remember it.
      </p>
      <div class="gate__field">
        <input
          class="gate__input gate__input--code"
          type="text"
          name="code"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          aria-labelledby="gate-label"
        />
      </div>
      <p class="gate__error" role="alert"></p>
      <button type="submit" class="gate__btn">Enter</button>
    </form>`;
}
