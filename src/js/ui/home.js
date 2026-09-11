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
 * the list is patched as leagues arrive, and a sheet someone is typing into
 * must not be touched by it. The leave question is a third sheet in the same
 * root, filled with the league's name when it is asked. Every one of them
 * leaves on its own motion rather than on close(), which is a cut
 * (closeDialog in ui/motion.js).
 *
 * The page is built once and patched after (ui/patch.js), keyed by code, so a
 * card is the same element from one render to the next. That is what lets a
 * league be seen to arrive and to go, and the cards either side of it to move
 * into the space: a node thrown away and rebuilt has no before to move from.
 *
 * Rendering only: app.js owns creating, joining, leaving and opening. When a
 * create or a join throws, the reason is shown inside the sheet that asked,
 * under its field, rather than as a notice at the top of the page.
 */

import { APP_NAME } from "../config.js";
import { POOL_KINDS, KIND_IDS, normaliseKinds } from "../sports.js";
import { formatCode, normaliseCode, isCode } from "../core/code.js";
import { escapeHtml } from "../core/format.js";
import { delegate } from "./events.js";
import { frame, reconcile } from "./patch.js";
import {
  afterMotion,
  capturePlaces,
  closeDialog,
  grow,
  keepOpen,
  prefersReducedMotion,
  settleInto,
  shrink,
} from "./motion.js";

/** Latest handlers, so the sheets wired on the first render stay current. */
let homeHandlers = {};
/** Where the two sheets were built, so they can be shut from outside. */
let sheetsRoot = null;

/**
 * Shut both sheets, for the next time the home page is shown. On the spot,
 * without their exit: the page they sit over is itself arriving, and a sheet
 * fading off a page that is fading in is two moves nobody asked for.
 */
export function closeHomePanels() {
  for (const dialog of sheetsRoot?.querySelectorAll("dialog[open]") ?? []) {
    closeDialog(dialog, { now: true });
  }
}

/**
 * Say a league is opening: its card wears the state and its Open button says
 * so, until the board is up or the list is drawn again. app.js calls it on
 * the tap, ahead of the load it then waits on, so the page stays where it is
 * and still answers the tap - the list used to leave at once, and a load that
 * outran its fade was spent on a blank screen.
 */
export function markOpening(root, code) {
  const card = cardFor(root, code);
  if (!card) return;
  card.classList.add("is-opening");
  const button = card.querySelector('[data-act="open"]');
  if (!button) return;
  button.setAttribute("aria-busy", "true");
  button.innerHTML = `Opening… ${ICONS.go}`;
}

/**
 * Send a league's card away, before the list is drawn without it.
 *
 * The list keeps its cards across renders now (renderHome), so a card being
 * left or deleted can be seen to go instead of being gone the next time the
 * page is painted - and the cards after it move up into the space it leaves
 * rather than being somewhere else already (settleInto in ui/motion.js).
 *
 * Resolves when the card has gone, so app.js can hold the render that removes
 * it until then.
 *
 * @param {HTMLElement} root
 * @param {string} code
 * @returns {Promise<void>}
 */
export async function playLeagueExit(root, code) {
  const card = cardFor(root, code);
  if (!card || prefersReducedMotion()) return;
  card.classList.add("is-leaving");
  await afterMotion(card, { subtree: false });
}

/** One league's card. A code is twelve letters and digits, so it is its own selector. */
function cardFor(root, code) {
  // Escaped anyway where the browser offers it (core/code.js).
  const safe = globalThis.CSS?.escape?.(code) ?? code;
  return root?.querySelector(`.home__card[data-league="${safe}"]`) ?? null;
}

/**
 * Put a card that said it was opening back the way it was.
 *
 * The mark is written straight onto the DOM rather than carried in the markup,
 * so the list keeping its cards would keep it too - and the one render that
 * follows a failed open is exactly the render that has to take it off.
 */
function clearOpening(list) {
  for (const card of list.querySelectorAll(".home__card.is-opening")) {
    card.classList.remove("is-opening");
    const button = card.querySelector('[data-act="open"]');
    if (!button) continue;
    button.removeAttribute("aria-busy");
    button.innerHTML = `Open league ${ICONS.go}`;
  }
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
  /* A key laid flat: the bow, the shaft, and two teeth hanging off it. The
     diagonal one this replaces drew its teeth across the shaft rather than
     off one side of it, so at 17px the head read as a cross rather than as a
     key. Flat and level with the plus beside it also gives the bow's hole
     enough room to still be a hole at that size. */
  key: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="8" cy="12" r="5.5" />
    <path d="M13.5 12h8M17.5 12v4M21.5 12v2.6" />
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
/** This person's name as last rendered, for the rename sheet to start from. */
let me = "";

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
 *   onLeave(code), onRenameMe(name). onCreate and onJoin may reject; the message is
 *   shown in their sheet.
 * @param {HTMLElement} [sheets] Where the two sheets live. Built once, on the
 *   first render that names it, and left alone after.
 */
export function renderHome(root, state, given, sheets = null) {
  if (!root) return;
  homeHandlers = given;
  if (sheets) {
    sheetsRoot = sheets;
    if (!sheets.firstElementChild) {
      sheets.innerHTML = sheetsMarkup();
      wireSheets(sheets);
    }
  }
  me = state.name ?? "";

  // Built once and patched after (ui/patch.js), where it used to be rebuilt
  // from innerHTML on every render. A league's card is now the same element
  // from one render to the next, which is the whole of what lets a card be
  // seen to arrive or to go: a node thrown away and replaced has no before to
  // animate from, so leaving a league used to be a card that was simply not
  // there any more.
  const first = !root.firstElementChild;
  const home = frame(root, `<section class="home"></section>`);
  if (first) wire(root);

  const list = home.querySelector(".home__list");
  // Where everything stood before the render, so what the render moves can be
  // moved there rather than found there.
  const places = capturePlaces(list?.children ?? []);
  const hadCards = new Set(places.keys());
  const hadMessages = [...home.querySelectorAll(".home__message")];

  reconcile(home, shellMarkup(state));
  const cards = home.querySelector(".home__list");
  reconcile(cards, listMarkup(state));
  clearOpening(cards);

  if (first || prefersReducedMotion()) return;
  settleInto(cards.children, places);
  playArrivals(cards, hadCards);
  playMessages(home, hadMessages);
}

/** The page itself: the head, whatever it has to say, the two buttons, the list. */
function shellMarkup({ name, shared, message }) {
  return `
    <header class="home__head" data-key="head">
      <div>
        <h1 class="home__brand">
          <svg viewBox="0 0 34 21" aria-hidden="true">
            <ellipse cx="17" cy="10.5" rx="15.6" ry="9.2" fill="none" stroke="currentColor" stroke-width="2.1" />
            <path d="M11.6 10.5h10.8M14 7.6v5.8M17 7.1v6.8M20 7.6v5.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
          </svg>
          ${APP_NAME}
        </h1>
        <p class="u-eyebrow home__eyebrow">Your leagues</p>
        <h2 class="home__title">${escapeHtml(name || APP_NAME)}</h2>
      </div>
      <button type="button" class="home__name" data-act="rename-me">Not you?</button>
    </header>

    ${message ? `<div class="notice notice--warn home__message" data-key="message">${escapeHtml(message)}</div>` : ""}

    ${
      shared
        ? ""
        : `<div class="notice home__message" data-key="local">
             Sharing is off in this build, so leagues and their codes stay on this
             device. Everything else works.
           </div>`
    }

    <div class="home__menu" data-key="menu">
      ${SHEETS.map(
        (sheet) => `
      <button type="button" class="home__menu-btn" data-sheet="${sheet.id}"
              aria-haspopup="dialog" aria-controls="home-${sheet.id}">
        ${sheet.icon}
        ${escapeHtml(sheet.label)}
      </button>`,
      ).join("")}
    </div>

    <div class="home__list" data-key="list"></div>`;
}

/** The cards, or the empty field where there are none. */
function listMarkup({ leagues, loading }) {
  if (leagues.length) return leagues.map(card).join("");
  return `<p class="home__empty" data-key="empty">
      ${loading ? "Looking for your leagues…" : "No leagues yet. Make one, or join one with a code someone sent you."}
    </p>`;
}

/**
 * Cards this render brought: a league made, one joined, or one another device
 * turned up with. The empty field arrives the same way when the last card has
 * gone, since it is what the list becomes rather than what is left of it.
 */
function playArrivals(list, had) {
  for (const node of list.children) {
    if (!had.has(node.dataset.key)) node.classList.add("is-entering");
  }
  for (const node of list.querySelectorAll(".is-entering")) {
    afterMotion(node, { subtree: false }).then(() => node.classList.remove("is-entering"));
  }
}

/**
 * And the lines above the list: a code that would not open, a build with
 * sharing off. They sit over the whole page, so one appearing pushes every
 * card down and one going pulls them back up; both grow and shrink in place
 * instead, and the cards ride the change (settleInto).
 */
function playMessages(home, had) {
  for (const node of home.querySelectorAll(".home__message")) {
    if (!had.includes(node)) grow(node);
  }
  // reconcile has already taken the ones that went off the page, so each goes
  // back where it was - above the two buttons - to shrink out of the way.
  const menu = home.querySelector(".home__menu");
  for (const node of had) {
    if (node.isConnected || node.classList.contains("is-shrinking")) continue;
    delete node.dataset.key;
    home.insertBefore(node, menu);
    shrink(node);
  }
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
        <input class="home__input home__input--code" id="home-code" name="code" type="text"
               placeholder="BXQK-7HRT-M4WD" autocomplete="off" autocapitalize="characters"
               spellcheck="false" aria-label="The code you were sent" />
        <p class="home__form-error" role="alert" hidden></p>
        <button type="submit" class="home__btn home__btn--go" disabled>Join</button>
      </form>
    </dialog>

    <dialog class="home__sheet home__sheet--confirm" id="home-rename" aria-labelledby="home-rename-title" tabindex="-1" autofocus>
      <div class="home__sheet-head">
        <h3 class="home__sheet-title" id="home-rename-title">Who's picking?</h3>
        <button type="button" class="home__icon home__sheet-close" data-close
                aria-label="Close">${ICONS.close}</button>
      </div>
      <form class="home__form" data-act="rename">
        <label class="home__label" for="home-me">Your name</label>
        <input class="home__input" id="home-me" name="name" type="text" maxlength="40"
               autocomplete="name" autocapitalize="words" spellcheck="false" placeholder="Ben" />
        <p class="home__form-error" role="alert" hidden></p>
        <div class="home__confirm-row">
          <button type="submit" class="home__btn home__btn--go">Save</button>
          <button type="button" class="home__btn home__btn--quiet" data-close>Cancel</button>
        </div>
      </form>
    </dialog>

    <dialog class="home__sheet home__sheet--confirm" id="home-leave" aria-labelledby="home-leave-title" tabindex="-1" autofocus>
      <div class="home__sheet-head">
        <h3 class="home__sheet-title" id="home-leave-title">Leave this league?</h3>
        <button type="button" class="home__icon home__sheet-close" data-close
                aria-label="Close">${ICONS.close}</button>
      </div>
      <div class="home__form">
        <p class="home__confirm-ask" data-leave-ask="others">
          Leave <strong data-leave-name></strong>? It stays for everyone else, and the code
          gets you back in.
        </p>
        <p class="home__confirm-ask" data-leave-ask="alone" hidden>
          Nobody else is in <strong data-leave-name></strong>, so leaving deletes it. Every
          pool and every pick goes with it.
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
             data-league="${escapeHtml(league.code)}" data-key="${escapeHtml(league.code)}"
             data-name="${escapeHtml(league.name)}"
             data-members="${league.members ?? ""}">
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

/**
 * The list and the menu, wired once to the page's own root.
 *
 * Bound to the root rather than to each card (ui/events.js): the cards outlive
 * a render now, and a listener added to each of them on every render would
 * stack up one per league per paint. The card a tap landed in is read off the
 * event instead.
 */
function wire(root) {
  delegate(root, "click", '[data-act="rename-me"]', () => {
    // The name as it stands, to edit rather than retype.
    const field = sheetsRoot?.querySelector("#home-me");
    if (field) field.value = me;
    openSheet("rename");
  });

  delegate(root, "click", "[data-sheet]", (button) => openSheet(button.dataset.sheet));

  // No pool named: the board opens on the league's first, and its bar has the
  // rest.
  delegate(root, "click", '[data-act="open"]', (button) =>
    homeHandlers.onOpen(button.closest(".home__card").dataset.league),
  );

  delegate(root, "click", '[data-act="leave"]', (button) => {
    const node = button.closest(".home__card");
    askToLeave(node.dataset.league, node.dataset.name, node.dataset.members === "1");
  });

  delegate(root, "click", '[data-act="copy"]', (button) =>
    copyCode(button, button.closest(".home__card").dataset.league),
  );
}

/**
 * The two sheets: wired once, when they are built. The handlers they call are
 * read at the moment of the tap, so the ones the latest render brought are the
 * ones that run.
 */
function wireSheets(sheets) {
  // Every way out of a sheet goes through closeDialog (ui/motion.js), which
  // plays the exit and closes underneath it: the cross, Cancel, a tap on the
  // backdrop and Esc, as well as the buttons that act.
  for (const dialog of sheets.querySelectorAll(".home__sheet")) {
    for (const close of dialog.querySelectorAll("[data-close]")) {
      close.addEventListener("click", () => closeDialog(dialog));
    }
    // A tap outside the sheet, which on a modal dialog lands on the dialog
    // element itself rather than on anything inside it.
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeDialog(dialog);
    });
    // Esc, which the platform answers by closing on the spot. Taken over so it
    // leaves the way every other exit does.
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeDialog(dialog);
    });
  }

  const create = sheets.querySelector('form[data-act="create"]');
  syncCreate(create);
  create.addEventListener("input", () => syncCreate(create));
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
    attempt(create, () => homeHandlers.onCreate({ name: create.elements.name.value, kinds }));
  });

  const join = sheets.querySelector('form[data-act="join"]');
  syncJoin(join);
  join.addEventListener("input", () => syncJoin(join));
  join.addEventListener("submit", (event) => {
    event.preventDefault();
    const typed = join.elements.code.value;
    if (!isCode(typed)) {
      showProblem(join, "That code is not twelve characters. Check it and try again.");
      return;
    }
    attempt(join, () => homeHandlers.onJoin(normaliseCode(typed)));
  });

  // The name: trimmed, never blank - it is how the others know whose picks
  // are whose - and saved on Save, which shuts the sheet.
  const rename = sheets.querySelector('form[data-act="rename"]');
  rename.addEventListener("submit", (event) => {
    event.preventDefault();
    const typed = rename.elements.name.value.trim().slice(0, 40);
    if (!typed) {
      showProblem(rename, "A name is how the others know which picks are yours.");
      return;
    }
    closeDialog(rename.closest("dialog"));
    homeHandlers.onRenameMe(typed);
  });

  // The leave question: the answer acts on whichever league asked it.
  const leave = sheets.querySelector("#home-leave");
  leave.querySelector('[data-act="leave-yes"]').addEventListener("click", () => {
    const code = leaving;
    leaving = null;
    // The sheet is off the screen before the card it was about starts to go,
    // so the two reads as one answer rather than as two things happening at
    // once over the top of each other.
    closeDialog(leave).then(() => {
      if (code) homeHandlers.onLeave(code);
    });
  });
  leave.querySelector('[data-act="leave-no"]').addEventListener("click", () => closeDialog(leave));
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
  keepOpen(dialog);
  showProblem(dialog.querySelector(".home__form"), "", { now: true });
  dialog.showModal();
  dialog.focus();
}

/**
 * Leaving, in two taps: the icon asks, in a sheet over the page, and only the
 * answer acts. Leaving is easy to undo - the code gets you back in - but a
 * card's corner is an easy place for a thumb to land, and the sheet means
 * nothing can be opened by the tap that was meant to say no.
 *
 * Unless nobody else is in the league: then leaving takes it down, and the
 * sheet becomes a delete question - title, words and buttons, in the terms
 * the settings sheet's own delete uses - so nobody deletes a league thinking
 * they only stepped out of it. `alone` is what the last refresh counted; a
 * head count still loading, or others who joined since, is a league that
 * stays, and the directory decides from the rows either way.
 */
function askToLeave(code, name, alone) {
  const dialog = sheetsRoot?.querySelector("#home-leave");
  if (!dialog || dialog.open) return;
  keepOpen(dialog);
  leaving = code;
  for (const slot of dialog.querySelectorAll("[data-leave-name]")) slot.textContent = name;
  for (const ask of dialog.querySelectorAll("[data-leave-ask]")) {
    ask.hidden = (ask.dataset.leaveAsk === "alone") !== alone;
  }
  dialog.querySelector("#home-leave-title").textContent = alone
    ? "Delete this league?"
    : "Leave this league?";
  dialog.querySelector('[data-act="leave-yes"]').textContent = alone
    ? "Yes, delete the league"
    : "Yes, leave";
  dialog.querySelector('[data-act="leave-no"]').textContent = alone ? "Keep it" : "Stay";
  dialog.showModal();
  dialog.focus();
}

/**
 * Copy the code, as it is shown, and say so with the icon: a tick for a moment,
 * or a cross when the browser refused - an insecure origin, or a permission
 * declined. The code is on the card either way, which is the part that matters.
 */
async function copyCode(button, code) {
  let state = "done";
  try {
    await navigator.clipboard.writeText(formatCode(code));
  } catch {
    state = "failed";
  }
  button.innerHTML = ICONS[state];
  // The swap is the whole of the feedback, so the new icon arrives rather than
  // appears (icon-swap in motion.css). Left on for good: the icon changes back
  // in a moment and that swap is the same news the other way.
  button.classList.add(`home__icon--${state}`, "is-swapped");
  button.title = state === "done" ? "Code copied" : "Copy failed";
  setTimeout(() => {
    button.innerHTML = ICONS.copy;
    button.classList.remove(`home__icon--${state}`);
    button.title = "Copy code";
  }, 1800);
}

/** The pools ticked in the create sheet, in the order they are offered. */
function chosenKinds(form) {
  return [...form.querySelectorAll('input[name="kinds"]:checked')].map((input) => input.value);
}

/**
 * Create is held until the league has a name and a pool is ticked. A league
 * of no pools would have no board to open, and one with no name nothing to
 * list it by, so the button says what is missing by being unavailable rather
 * than by failing after the tap.
 */
function syncCreate(form) {
  const named = form.elements.name.value.trim().length > 0;
  form.querySelector('button[type="submit"]').disabled = !named || chosenKinds(form).length === 0;
}

/** Join is held until something has been typed into the code box. */
function syncJoin(form) {
  form.querySelector('button[type="submit"]').disabled =
    form.elements.code.value.trim().length === 0;
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
    closeDialog(form.closest("dialog"));
  } catch (error) {
    showProblem(form, error?.message || "That did not go through. Try again.");
  }
}

/**
 * The one complaint a sheet can make, under the field it is about.
 *
 * It grows into place and shrinks back out (ui/motion.js), because it sits
 * above the button the thumb is on: a line that simply appeared pushed the
 * button down by its own height between one frame and the next, which on a
 * phone is the button moving out from under the finger that is about to press
 * it again.
 *
 * @param {HTMLElement} form
 * @param {string} message "" to take the line away.
 * @param {{now?:boolean}} [options] `now` for a sheet being opened, where
 *   there is nothing on screen yet for the line to leave.
 */
function showProblem(form, message, { now = false } = {}) {
  const line = form.querySelector(".home__form-error");
  const shown = !line.hidden;
  if (message) {
    line.textContent = message;
    if (shown) return;
    line.classList.remove("is-shrinking");
    line.hidden = false;
    if (!now) grow(line);
    return;
  }
  if (!shown) return;
  if (now || prefersReducedMotion()) {
    line.textContent = "";
    line.hidden = true;
    return;
  }
  // Shrunk rather than removed: the line is part of the sheet's markup and has
  // to be there for the next complaint, so it hides itself once it has gone.
  line.style.setProperty("--motion-from", `${line.offsetHeight}px`);
  line.classList.add("is-shrinking");
  afterMotion(line, { subtree: false }).then(() => {
    line.classList.remove("is-shrinking");
    line.style.removeProperty("--motion-from");
    line.textContent = "";
    line.hidden = true;
  });
}
