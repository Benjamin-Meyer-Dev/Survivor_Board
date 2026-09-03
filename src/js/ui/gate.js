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
    const visibility = root.querySelector(".gate__visibility");

    visibility.addEventListener("click", () => {
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      visibility.setAttribute("aria-pressed", String(!showing));
      visibility.setAttribute("aria-label", showing ? "Show passcode" : "Hide passcode");
      input.focus();
    });

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
      <div class="gate__field">
        <input class="gate__input" id="gate-input" type="password"
               autocapitalize="off" autocorrect="off" spellcheck="false" required />
        <button class="gate__visibility" type="button" aria-label="Show passcode"
                aria-pressed="false">
          <svg class="gate__eye gate__eye--show" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
            <circle cx="12" cy="12" r="2.75" />
          </svg>
          <svg class="gate__eye gate__eye--hide" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 3l18 18M10.6 6.1A10.8 10.8 0 0 1 12 6c6 0 9.5 6 9.5 6a15 15 0 0 1-2.3 2.9M6.4 6.5C3.9 8.3 2.5 12 2.5 12s3.5 6 9.5 6c1.2 0 2.3-.2 3.3-.6M9.9 9.9a3 3 0 0 0 4.2 4.2" />
          </svg>
        </button>
      </div>
      <button type="submit" class="gate__btn">Enter</button>
      <p class="gate__error" role="alert"></p>
    </form>`;
}
