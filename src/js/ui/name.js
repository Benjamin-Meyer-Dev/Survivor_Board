/**
 * The start screen: what to call you.
 *
 * Shown once per device, before anything else, and it is the whole of the
 * identity this app has. There are no accounts and nothing is verified: the
 * name rides along on the picks and locks so a league can say who did what,
 * and it is stored on the phone that typed it.
 *
 * This is the screen the old passcode gate used to be, and it wears its stadium
 * and its card (the `.gate__*` block in components.css) because the job is the
 * same: hold the app back behind one field, on the field, while the board
 * loads behind it.
 *
 * Rendering and the form only: app.js decides whether a name is needed and
 * what to do with it.
 */

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
    root.hidden = false;

    const form = root.querySelector("form");
    const input = root.querySelector("input");
    const error = root.querySelector(".gate__error");

    // Focus, but not on a phone: bringing the keyboard up over the stadium
    // before anyone has looked at it is a worse first frame than an empty
    // field, and the field is the only thing on screen to tap.
    if (!matchMedia("(hover: none)").matches) input.focus();

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = input.value.trim().slice(0, 40);
      if (!value) {
        error.textContent = "A name is how the others know which picks are yours.";
        input.focus();
        return;
      }
      root.hidden = true;
      resolve(value);
    });
  });
}

function startMarkup({ name, heading, label, action }) {
  return `
    <div class="gate__stadium" aria-hidden="true">
      <span class="gate__endzone gate__endzone--top"></span>
      <span class="gate__endzone gate__endzone--bottom"></span>
      <span class="gate__hashes gate__hashes--left"><i></i><i></i><i></i><i></i><i></i></span>
      <span class="gate__hashes gate__hashes--right"><i></i><i></i><i></i><i></i><i></i></span>
      <span class="gate__yard-number gate__yard-number--20"><i>2</i><i>0</i></span>
      <span class="gate__yard-number gate__yard-number--40"><i>4</i><i>0</i></span>
      <span class="gate__yard-number gate__yard-number--opposing-40"><i>4</i><i>0</i></span>
      <span class="gate__yard-number gate__yard-number--opposing-20"><i>2</i><i>0</i></span>
      <svg class="gate__midfield-ball" viewBox="0 0 34 21" aria-hidden="true">
        <ellipse cx="17" cy="10.5" rx="15.6" ry="9.2" fill="none" stroke="currentColor"
                 stroke-width="2.1" />
        <path d="M11.6 10.5h10.8M14 7.6v5.8M17 7.1v6.8M20 7.6v5.8" stroke="currentColor"
              stroke-width="1.7" stroke-linecap="round" />
      </svg>
    </div>

    <form class="gate__card" novalidate>
      <p class="gate__brand">Survivor Board</p>
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
