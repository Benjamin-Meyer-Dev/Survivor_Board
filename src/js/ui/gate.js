/**
 * The passcode screen.
 *
 * Shown once per device, before the board loads. Rendering and the form only:
 * app.js decides whether a gate is needed, what counts as correct, and what to
 * remember afterwards.
 */

/**
 * Render the gate into `root` and resolve once `check` accepts an answer.
 *
 * @param {HTMLElement} root
 * @param {(value: string) => boolean} check
 * @returns {Promise<void>}
 */
export function requireGate(root, check) {
  return new Promise((resolve) => {
    root.innerHTML = markup();
    root.hidden = false;

    const form = root.querySelector("form");
    const input = root.querySelector("input");
    const error = root.querySelector(".gate__error");

    form.addEventListener("submit", (event) => {
      event.preventDefault();

      if (check(input.value)) {
        root.hidden = true;
        root.innerHTML = "";
        resolve();
        return;
      }

      error.textContent = "That is not it. Try again.";
      input.value = "";
      input.focus();
      // Drop the finished animation before re-adding it, so a second wrong
      // answer shakes too rather than doing nothing.
      form.classList.remove("is-wrong");
      void form.offsetWidth;
      form.classList.add("is-wrong");
    });

    input.focus();
  });
}

function markup() {
  return `
    <form class="gate__card" autocomplete="off">
      <p class="gate__brand">Survivor Board</p>
      <label class="gate__label" for="gate-input">Passcode</label>
      <input class="gate__input" id="gate-input" type="password"
             autocapitalize="off" autocorrect="off" spellcheck="false" required />
      <button type="submit" class="gate__btn">Enter</button>
      <p class="gate__error" role="alert"></p>
    </form>`;
}
