/**
 * The topline's league bar.
 *
 * The open league, at the top of the board: the way back to every league, the
 * league's name, and which of its pools the board is showing, with the pool's
 * paint as a mark. The picker holds this one league's pools - "NFL winners",
 * "NFL losers" - and nothing else, because that is the choice a person on a
 * board actually makes; another league is a trip through the home page. A
 * league of one pool has nothing to pick, so its pill just names it.
 *
 * The picker is drawn here, not by the platform: a chalkboard hung under the
 * pill with a row per pool, the one showing checked. It used to be a native
 * `select`, and on Android that opens the system's own radio dialog in the
 * middle of the field, in the system's face and colours - the one thing on the
 * board that is not chalk on turf. The price is that the keyboard and screen
 * reader behaviour is written out below: the pill is a button that opens a
 * listbox, arrows move through it, Enter or Space picks, Escape puts it away.
 *
 * Built ONCE and updated in place afterwards: this runs on every board render,
 * and replacing the elements under an open menu would close it mid-choice. The
 * only state kept here is whether the menu is open, which is the element's own.
 *
 * Rendering only: app.js owns the reload that follows a pick. The gear that
 * sits in the same topline is ui/settings.js, rendered into its own root.
 */

import { escapeHtml } from "../core/format.js";
import { POOL_KINDS, KIND_IDS, normaliseKinds } from "../sports.js";

/** Latest handlers, so the listeners bound on the first render stay current. */
let handlers = { onPool: () => {}, onHome: () => {} };
/** The rows currently in the menu, to know when they need rebuilding. */
let painted = "";
/** The bar's root once built, for the outside-tap listener. */
let bar = null;

/**
 * @param {HTMLElement} root
 * @param {{league:{code:string,name:string,kinds:string[]}|null, kind?:string|null}} state
 * @param {{onPool:(kind:string)=>void, onHome:()=>void}} given
 */
export function renderLeagueBar(root, { league, kind = null }, given) {
  if (!root) return;
  handlers = given;

  if (!root.firstElementChild) build(root);

  const kinds = normaliseKinds(league?.kinds);
  if (kinds.length === 0) kinds.push(KIND_IDS[0]);
  const showing = kinds.includes(kind) ? kind : kinds[0];

  root.querySelector(".league-bar__name").textContent = league?.name ?? "";

  const menu = root.querySelector(".league-bar__menu");
  const signature = `${league?.code ?? ""}:${kinds.join(",")}`;
  if (signature !== painted) {
    // Another league, or a pool added or taken away: new rows, and a menu
    // open on the old ones is put away rather than left showing them.
    closeMenu(root);
    menu.innerHTML = kinds.map(row).join("");
    painted = signature;
  }

  const one = kinds.length === 1;
  const pill = root.querySelector(".league-bar__pool");
  pill.classList.toggle("league-bar__pool--one", one);
  pill.disabled = one;
  if (one) closeMenu(root);

  root.querySelector(".league-bar__showing").textContent = POOL_KINDS[showing].label;
  for (const option of menu.children) {
    option.setAttribute("aria-selected", String(option.dataset.kind === showing));
  }
}

/** One pool, as a row: its paint, its name, and a check when it is the one showing. */
function row(id) {
  return `
    <li class="league-bar__option" role="option" data-kind="${id}" tabindex="-1" aria-selected="false">
      <span class="league-bar__option-mark" aria-hidden="true"></span>
      <span class="league-bar__option-label">${escapeHtml(POOL_KINDS[id].label)}</span>
      <svg class="league-bar__option-check" viewBox="0 0 24 24" aria-hidden="true">
        <path d="m5 12.5 4.5 4.5L19 7" />
      </svg>
    </li>`;
}

function build(root) {
  bar = root;
  root.innerHTML = `
    <button type="button" class="league-bar__back" aria-label="All leagues" title="All leagues">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
    </button>
    <div class="league-bar__league">
      <h2 class="league-bar__name"></h2>
      <div class="league-bar__picker">
        <button type="button" class="league-bar__pool" aria-haspopup="listbox"
                aria-expanded="false" aria-controls="league-bar-menu" title="Pool">
          <span class="league-bar__mark" aria-hidden="true"></span>
          <span class="league-bar__showing"></span>
          <svg class="league-bar__chevron" viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <ul class="league-bar__menu" id="league-bar-menu" role="listbox" aria-label="Pool" hidden></ul>
      </div>
    </div>`;

  root.querySelector(".league-bar__back").addEventListener("click", () => handlers.onHome());

  const pill = root.querySelector(".league-bar__pool");
  const menu = root.querySelector(".league-bar__menu");

  pill.addEventListener("click", () => (menu.hidden ? openMenu(root) : closeMenu(root)));
  pill.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openMenu(root);
  });

  menu.addEventListener("click", (event) => {
    const option = event.target.closest(".league-bar__option");
    if (option) choose(root, option.dataset.kind);
  });

  menu.addEventListener("keydown", (event) => {
    const options = [...menu.children];
    const at = options.indexOf(document.activeElement);
    const moves = {
      ArrowDown: at + 1,
      ArrowUp: at - 1,
      Home: 0,
      End: options.length - 1,
    };
    if (event.key in moves) {
      event.preventDefault();
      options[(moves[event.key] + options.length) % options.length]?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (at >= 0) choose(root, options[at].dataset.kind);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(root, { refocus: true });
    } else if (event.key === "Tab") {
      // Let the tab go where it was going; the menu just does not stay behind.
      closeMenu(root);
    }
  });
}

function openMenu(root) {
  const pill = root.querySelector(".league-bar__pool");
  const menu = root.querySelector(".league-bar__menu");
  if (pill.disabled || !menu.hidden) return;

  menu.classList.remove("league-bar__menu--right");
  menu.hidden = false;
  pill.setAttribute("aria-expanded", "true");
  // Hung from the pill's left edge unless that would run off the screen, in
  // which case from its right.
  if (menu.getBoundingClientRect().right > window.innerWidth - 8) {
    menu.classList.add("league-bar__menu--right");
  }
  document.addEventListener("pointerdown", onOutside, true);
  (menu.querySelector('[aria-selected="true"]') ?? menu.firstElementChild)?.focus();
}

function closeMenu(root, { refocus = false } = {}) {
  const menu = root.querySelector(".league-bar__menu");
  if (menu.hidden) return;

  menu.hidden = true;
  root.querySelector(".league-bar__pool").setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", onOutside, true);
  if (refocus) root.querySelector(".league-bar__pool").focus();
}

/** A press anywhere but the picker puts the menu away; the press itself still lands. */
function onOutside(event) {
  if (!bar || bar.querySelector(".league-bar__picker").contains(event.target)) return;
  closeMenu(bar);
}

function choose(root, kind) {
  const showing = root.querySelector('.league-bar__option[aria-selected="true"]')?.dataset.kind;
  closeMenu(root, { refocus: true });
  if (kind && kind !== showing) handlers.onPool(kind);
}
