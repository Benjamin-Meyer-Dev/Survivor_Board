/**
 * The home page: your leagues.
 *
 * Everything a person does that is not picking a team happens here - which
 * leagues this device is in, making another, joining someone else's, and
 * handing out the code that lets them join yours.
 *
 * A league can run more than one pool - an NFL winners pool, an NFL losers
 * pool and a college pool for the same people - so making one is a matter of
 * ticking the pools it runs, and its card opens the first of its boards. One
 * code covers them all. Which pools, and whether each is played for winners or
 * for losers, is fixed here and cannot be changed afterwards.
 *
 * A league's code is shown on its card rather than hidden behind a share
 * sheet, because the code is the whole of how anyone else gets in: it has to
 * be readable off a screenshot and repeatable down a phone line, and the copy
 * icon beside it puts that same code on the clipboard. Leave sits in the card's
 * corner as an icon, apart from Open: it is about the league, not about going
 * into it, and it asks once more, in a sheet, before it acts. Open is the
 * card's one big action; it goes to the league's first pool - NFL winners,
 * when it runs one - and the topline on the board is where its other pools
 * are. The card names the pools it runs and nothing of their rules: those are
 * read inside the board, from the gear.
 *
 * Making and joining live in two sheets, opened from two buttons above the
 * cards, where a long list cannot push them off the screen. The sheets are
 * native dialogs, so the backdrop, the focus trap and Esc are the platform's,
 * and they are built once into a root of their own rather than into the list:
 * the list is redrawn as leagues arrive, and a sheet someone is typing into
 * must not be redrawn with it. The leave question is a third sheet in the same
 * root, filled with the league's name when it is asked.
 *
 * Rendering only: app.js owns creating, joining, leaving and opening. When a
 * create or a join throws, the reason is shown inside the sheet that asked,
 * under its field, rather than as a notice at the top of the page.
 */

import { POOL_KINDS, KIND_IDS, normaliseKinds } from "../sports.js";
import { formatCode, normaliseCode, isCode } from "../core/code.js";
import { escapeHtml } from "../core/format.js";

/** Latest handlers, so the sheets wired on the first render stay current. */
let handlers = {};
/** Where the two sheets were built, so they can be shut from outside. */
let sheetsRoot = null;

/** Shut both sheets, for the next time the home page is shown. */
export function closeHomePanels() {
  for (const dialog of sheetsRoot?.querySelectorAll("dialog[open]") ?? []) dialog.close();
}

/* Stroke icons: two sheets for copy, a door with an arrow out for leave, the
   tick and cross copy swaps to while it reports, an arrow for the way in, a
   plus for a new league, a key for joining with a code (a code is a key, and
   a door here would look like leaving), and a cross to shut a sheet. */
const ICONS = {
  copy: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>`,
  leave: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5M21 12H9" />
  </svg>`,
  done: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20 6-11 11-5-5" /></svg>`,
  failed: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>`,
  go: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>`,
  plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>`,
  key: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="m10.8 12.2 9.7-9.7M15 7l3 3M18 4l2 2" />
  </svg>`,
  close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>`,
};

/** The two sheets, as the menu offers them. */
const SHEETS = [
  { id: "create", label: "New league", icon: ICONS.plus },
  { id: "join", label: "Join with a code", icon: ICONS.key },
];

/** The league a leave is being asked about, while the question is up. */
let leaving = null;

/**
 * @param {HTMLElement} root Where the list and the menu are drawn.
 * @param {object} state
 * @param {string} state.name This person's name.
 * @param {Array<object>} state.leagues From store/directory.js refreshMyLeagues,
 *   each with its `kinds` and its `rules` by kind.
 * @param {boolean} state.shared Whether leagues can be shared from this build.
 * @param {boolean} state.loading Whether the shared copy is still on its way.
 * @param {string} state.message A line to show above the list, or "".
 * @param {object} given onOpen(code), onCreate({name, kinds}), onJoin(code),
 *   onLeave(code), onRenameMe(). onCreate and onJoin may reject; the message is
 *   shown in their sheet.
 * @param {HTMLElement} [sheets] Where the two sheets live. Built once, on the
 *   first render that names it, and left alone after.
 */
export function renderHome(root, state, given, sheets = null) {
  if (!root) return;
  handlers = given;
  if (sheets) {
    sheetsRoot = sheets;
    if (!sheets.firstElementChild) {
      sheets.innerHTML = sheetsMarkup();
      wireSheets(sheets);
    }
  }
  root.innerHTML = homeMarkup(state);
  wire(root);
}

function homeMarkup({ name, leagues, shared, loading, message }) {
  return `
    <section class="home">
      <header class="home__head">
        <div>
          <h1 class="home__brand">
            <svg viewBox="0 0 34 21" aria-hidden="true">
              <ellipse cx="17" cy="10.5" rx="15.6" ry="9.2" fill="none" stroke="currentColor" stroke-width="2.1" />
              <path d="M11.6 10.5h10.8M14 7.6v5.8M17 7.1v6.8M20 7.6v5.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
            </svg>
            Survivor <span>Board</span>
          </h1>
          <p class="u-eyebrow home__eyebrow">Your leagues</p>
          <h2 class="home__title">${escapeHtml(name || "Survivor Board")}</h2>
        </div>
        <button type="button" class="home__name" data-act="rename-me">Not you?</button>
      </header>

      ${message ? `<div class="notice notice--warn home__message">${escapeHtml(message)}</div>` : ""}

      ${
        shared
          ? ""
          : `<div class="notice home__message">
               Sharing is off in this build, so leagues and their codes stay on this
               device. Everything else works.
             </div>`
      }

      <div class="home__menu">
        ${SHEETS.map(
          (sheet) => `
        <button type="button" class="home__menu-btn" data-sheet="${sheet.id}"
                aria-haspopup="dialog" aria-controls="home-${sheet.id}">
          ${sheet.icon}
          ${escapeHtml(sheet.label)}
        </button>`,
        ).join("")}
      </div>

      <div class="home__list">
        ${
          leagues.length
            ? leagues.map(card).join("")
            : `<p class="home__empty">
                 ${loading ? "Looking for your leagues…" : "No leagues yet. Make one, or join one with a code someone sent you."}
               </p>`
        }
      </div>
    </section>`;
}

/** The two sheets: a head with the name and a way out, and the form beneath. */
function sheetsMarkup() {
  return `
    <dialog class="home__sheet" id="home-create" aria-labelledby="home-create-title" tabindex="-1" autofocus>
      <div class="home__sheet-head">
        <h3 class="home__sheet-title" id="home-create-title">New league</h3>
        <button type="button" class="home__icon home__sheet-close" data-close
                aria-label="Close">${ICONS.close}</button>
      </div>
      <form class="home__form" data-act="create">
        <label class="home__label" for="home-name">What is it called?</label>
        <input class="home__input" id="home-name" name="name" type="text" maxlength="60"
               placeholder="The Office Pool" autocomplete="off" />
        <p class="home__form-error" role="alert" hidden></p>
        <fieldset class="home__choices-group">
          <legend class="home__label">Which pools does it run?</legend>
          <div class="home__options">
            ${KIND_IDS.map(
              (id) => `
            <label class="home__option">
              <input type="checkbox" name="kinds" value="${id}" />
              <span class="home__option-name">${escapeHtml(POOL_KINDS[id].label)}</span>
            </label>`,
            ).join("")}
          </div>
        </fieldset>
        <p class="home__hint">
          Tick every pool this league runs: one code brings people into all of them, with
          a board for each. Whether a pick has to win or lose is fixed here; picks a week
          and buy backs are set per pool inside the league, from the gear beside its name.
        </p>
        <button type="submit" class="home__btn home__btn--go" disabled>Create league</button>
      </form>
    </dialog>

    <dialog class="home__sheet" id="home-join" aria-labelledby="home-join-title" tabindex="-1" autofocus>
      <div class="home__sheet-head">
        <h3 class="home__sheet-title" id="home-join-title">Join a league</h3>
        <button type="button" class="home__icon home__sheet-close" data-close
                aria-label="Close">${ICONS.close}</button>
      </div>
      <form class="home__form" data-act="join">
        <label class="home__label" for="home-code">Paste the code you were sent</label>
        <input class="home__input home__input--code" id="home-code" name="code" type="text"
               placeholder="BXQK-7HRT-M4WD" autocomplete="off" autocapitalize="characters"
               spellcheck="false" />
        <p class="home__form-error" role="alert" hidden></p>
        <p class="home__hint">
          Twelve characters, dashes optional. Everyone in a league shares its boards: you
          will see the same picks and locks as the rest of them, and they will see yours.
        </p>
        <button type="submit" class="home__btn home__btn--go">Join</button>
      </form>
    </dialog>

    <dialog class="home__sheet home__sheet--confirm" id="home-leave" aria-labelledby="home-leave-title" tabindex="-1" autofocus>
      <div class="home__sheet-head">
        <h3 class="home__sheet-title" id="home-leave-title">Leave this league?</h3>
        <button type="button" class="home__icon home__sheet-close" data-close
                aria-label="Close">${ICONS.close}</button>
      </div>
      <div class="home__form">
        <p class="home__confirm-ask">
          Leave <strong data-leave-name></strong>? It stays for everyone else, and the code
          gets you back in.
        </p>
        <div class="home__confirm-row">
          <button type="button" class="home__btn home__btn--danger" data-act="leave-yes">Yes, leave</button>
          <button type="button" class="home__btn home__btn--quiet" data-act="leave-no">Stay</button>
        </div>
      </div>
    </dialog>`;
}

function card(league) {
  const kinds = kindsOf(league);

  // The pools are the tags; the rules are read inside the board, from the
  // gear. The head count is the one line worth carrying here, once for the
  // league: its members are the same people whichever board they are on.
  const people = league.members > 1 ? `${league.members} people` : "";

  return `
    <article class="home__card${league.missing ? " home__card--missing" : ""}"
             data-league="${escapeHtml(league.code)}" data-name="${escapeHtml(league.name)}">
      <div class="home__card-head">
        <h3 class="home__card-name">${escapeHtml(league.name)}</h3>
        <div class="home__card-tools">
          <button type="button" class="home__icon home__icon--leave" data-act="leave"
                  aria-label="Leave this league" title="Leave">${ICONS.leave}</button>
        </div>
      </div>

      <div class="home__card-chips">
        ${kinds
          .map(
            (kind) =>
              `<span class="chip chip--kind chip--kind-${kind}">${escapeHtml(POOL_KINDS[kind].short)}</span>`,
          )
          .join("")}
        ${people ? `<span class="home__card-people">${escapeHtml(people)}</span>` : ""}
      </div>

      <div class="home__code">
        <span class="home__code-label">Code</span>
        <code class="home__code-value">${escapeHtml(formatCode(league.code))}</code>
        <button type="button" class="home__icon home__icon--copy home__code-copy" data-act="copy"
                aria-label="Copy the code" title="Copy code">${ICONS.copy}</button>
      </div>

      ${
        league.missing
          ? `<p class="home__card-warn">
               This code did not answer. It may be a league that was deleted, or the
               network. Leaving takes it off this device only.
             </p>`
          : ""
      }

      <div class="home__card-actions">
        <button type="button" class="home__btn home__btn--go home__open" data-act="open">
          Open league ${ICONS.go}
        </button>
      </div>
    </article>`;
}

/**
 * The pools a league runs, for its card. The directory hands every league over
 * with `kinds`; one with none the repo still carries is drawn as a league of
 * the first kind rather than as a card with no board to open.
 */
function kindsOf(league) {
  const kinds = normaliseKinds(league.kinds);
  return kinds.length ? kinds : [KIND_IDS[0]];
}

/** The list and the menu: redrawn on every render. */
function wire(root) {
  root
    .querySelector('[data-act="rename-me"]')
    ?.addEventListener("click", () => handlers.onRenameMe());

  for (const button of root.querySelectorAll("[data-sheet]")) {
    button.addEventListener("click", () => openSheet(button.dataset.sheet));
  }

  for (const node of root.querySelectorAll(".home__card")) {
    const code = node.dataset.league;
    // No pool named: the board opens on the league's first, and its bar has
    // the rest.
    node.querySelector('[data-act="open"]').addEventListener("click", () => handlers.onOpen(code));
    node
      .querySelector('[data-act="leave"]')
      .addEventListener("click", () => askToLeave(code, node.dataset.name));
    wireCopy(node.querySelector('[data-act="copy"]'), code);
  }
}

/**
 * The two sheets: wired once, when they are built. The handlers they call are
 * read at the moment of the tap, so the ones the latest render brought are the
 * ones that run.
 */
function wireSheets(sheets) {
  for (const dialog of sheets.querySelectorAll(".home__sheet")) {
    dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
    // A tap outside the sheet, which on a modal dialog lands on the dialog
    // element itself rather than on anything inside it.
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  const create = sheets.querySelector('form[data-act="create"]');
  syncCreate(create);
  create.addEventListener("change", () => {
    syncCreate(create);
    // The one complaint the sheet can make on its own is answered by a tick.
    if (chosenKinds(create).length) showProblem(create, "");
  });
  create.addEventListener("submit", (event) => {
    event.preventDefault();
    const kinds = chosenKinds(create);
    if (kinds.length === 0) {
      showProblem(create, "Tick at least one pool for the league to run.");
      return;
    }
    attempt(create, () => handlers.onCreate({ name: create.elements.name.value, kinds }));
  });

  const join = sheets.querySelector('form[data-act="join"]');
  join.addEventListener("submit", (event) => {
    event.preventDefault();
    const typed = join.elements.code.value;
    if (!isCode(typed)) {
      showProblem(join, "That code is not twelve characters. Check it and try again.");
      return;
    }
    attempt(join, () => handlers.onJoin(normaliseCode(typed)));
  });

  // The leave question: the answer acts on whichever league asked it.
  const leave = sheets.querySelector("#home-leave");
  leave.querySelector('[data-act="leave-yes"]').addEventListener("click", () => {
    const code = leaving;
    leaving = null;
    leave.close();
    if (code) handlers.onLeave(code);
  });
  leave.querySelector('[data-act="leave-no"]').addEventListener("click", () => leave.close());
  leave.addEventListener("close", () => {
    leaving = null;
  });
}

/**
 * Open one sheet over the page. An earlier attempt's error is cleared, since
 * the person is starting again; what they typed is kept, since they may be
 * coming back to finish it. The sheet itself takes focus, not its first
 * field: a modal dialog focuses the field on open unless told otherwise, and
 * on a phone that brings the keyboard up over a sheet nobody has read yet.
 * The field is the obvious thing to tap.
 */
function openSheet(id) {
  const dialog = sheetsRoot?.querySelector(`#home-${id}`);
  if (!dialog || dialog.open) return;
  showProblem(dialog.querySelector(".home__form"), "");
  dialog.showModal();
  dialog.focus();
}

/**
 * Leaving, in two taps: the icon asks, in a sheet over the page, and only the
 * answer acts. Leaving is easy to undo - the code gets you back in - but a
 * card's corner is an easy place for a thumb to land, and the sheet means
 * nothing can be opened by the tap that was meant to say no.
 */
function askToLeave(code, name) {
  const dialog = sheetsRoot?.querySelector("#home-leave");
  if (!dialog || dialog.open) return;
  leaving = code;
  dialog.querySelector("[data-leave-name]").textContent = name;
  dialog.showModal();
  dialog.focus();
}

/**
 * Copy the code, as it is shown, and say so with the icon: a tick for a moment,
 * or a cross when the browser refused - an insecure origin, or a permission
 * declined. The code is on the card either way, which is the part that matters.
 */
function wireCopy(button, code) {
  button.addEventListener("click", async () => {
    let state = "done";
    try {
      await navigator.clipboard.writeText(formatCode(code));
    } catch {
      state = "failed";
    }
    button.innerHTML = ICONS[state];
    button.classList.add(`home__icon--${state}`);
    button.title = state === "done" ? "Code copied" : "Copy failed";
    setTimeout(() => {
      button.innerHTML = ICONS.copy;
      button.classList.remove(`home__icon--${state}`);
      button.title = "Copy code";
    }, 1800);
  });
}

/** The pools ticked in the create sheet, in the order they are offered. */
function chosenKinds(form) {
  return [...form.querySelectorAll('input[name="kinds"]:checked')].map((input) => input.value);
}

/**
 * Create is held until a pool is ticked. A league of no pools would have no
 * board to open, so the button says what is missing by being unavailable
 * rather than by failing after the tap.
 */
function syncCreate(form) {
  form.querySelector('button[type="submit"]').disabled = chosenKinds(form).length === 0;
}

/**
 * Run a sheet's handler and keep its answer in the sheet.
 *
 * A join or a create that does not go through is reported under the field it
 * concerns, and nothing else moves: the person has the sheet open with a thumb
 * on the button, and what they typed stays put, which is the thing they now
 * need to check. One that goes through shuts the sheet, since the board is
 * opening behind it.
 */
async function attempt(form, action) {
  showProblem(form, "");
  try {
    await action();
    form.closest("dialog")?.close();
  } catch (error) {
    showProblem(form, error?.message || "That did not go through. Try again.");
  }
}

function showProblem(form, message) {
  const line = form.querySelector(".home__form-error");
  line.textContent = message;
  line.hidden = !message;
}
