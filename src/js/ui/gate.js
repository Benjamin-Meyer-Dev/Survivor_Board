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
 * `check` may be async: deriving the passcode digest takes a moment on purpose,
 * so the button is held disabled until it answers and a double tap cannot start
 * a second derivation. If `check` throws, its message is shown in place of the
 * wrong-answer line and the typed value is kept.
 *
 * @param {HTMLElement} root
 * @param {(value: string) => boolean | Promise<boolean>} check
 * @returns {Promise<void>}
 */
export function requireGate(root, check) {
  return new Promise((resolve) => {
    root.innerHTML = markup();
    root.hidden = false;

    const form = root.querySelector("form");
    const input = root.querySelector("input");
    const submit = root.querySelector(".gate__btn");
    const error = root.querySelector(".gate__error");
    const visibility = root.querySelector(".gate__visibility");
    let checking = false;

    visibility.addEventListener("click", () => {
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      visibility.setAttribute("aria-pressed", String(!showing));
      visibility.setAttribute("aria-label", showing ? "Show passcode" : "Hide passcode");
      input.focus();
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (checking) return;

      checking = true;
      submit.disabled = true;
      form.setAttribute("aria-busy", "true");
      error.textContent = "";

      let accepted = false;
      let failure = null;
      try {
        accepted = await check(input.value);
      } catch (cause) {
        failure = cause;
      }

      checking = false;
      submit.disabled = false;
      form.removeAttribute("aria-busy");

      if (accepted) {
        root.hidden = true;
        root.innerHTML = "";
        resolve();
        return;
      }

      if (failure) {
        error.textContent = failure.message;
        input.focus();
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
  const hashSections = "<i></i>".repeat(10);
  return `
    <div class="gate__stadium" aria-hidden="true">
      <span class="gate__endzone gate__endzone--top">Survivor</span>
      <span class="gate__hashes gate__hashes--left">${hashSections}</span>
      <span class="gate__hashes gate__hashes--right">${hashSections}</span>
      <span class="gate__yard-number gate__yard-number--20"><i>20</i><i>20</i></span>
      <span class="gate__yard-number gate__yard-number--40"><i>40</i><i>40</i></span>
      <svg class="gate__midfield-ball" viewBox="0 0 54 34">
        <path d="M3 17C9 4 20 1 27 1s18 3 24 16c-6 13-17 16-24 16S9 30 3 17Z" />
        <path d="M19 17h16M23 12v10M27 11v12M31 12v10" />
      </svg>
      <span class="gate__yard-number gate__yard-number--opposing-40"><i>40</i><i>40</i></span>
      <span class="gate__yard-number gate__yard-number--opposing-20"><i>20</i><i>20</i></span>
      <span class="gate__endzone gate__endzone--bottom">Board</span>
    </div>
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
