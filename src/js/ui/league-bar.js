/**
 * League bar.
 *
 * The open league, under the masthead: the way back to every league, the
 * league's name, and which of its pools the board is showing. The picker holds
 * this one league's pools - "NFL winners", "NFL losers" - and nothing else,
 * because that is the choice a person on a board actually makes; another
 * league is a trip through the home page, which is where leagues are told
 * apart. A league of one pool has nothing to pick, so its pill just names it.
 *
 * A native `select`, so the picker is the platform's own: a wheel on iOS, a
 * sheet on Android, a listbox on a desktop, all of them reachable by keyboard
 * and screen reader without a line of code here. What is styled is the closed
 * state, which is the state it is in on every render.
 *
 * Built ONCE and updated in place afterwards, like the tab bar: this runs on
 * every board render, and replacing the element under an open picker would
 * close it mid-choice. The options themselves are rebuilt only when the
 * league's pools actually change, for the same reason.
 *
 * Rendering only: app.js owns the reload that follows a change. The gear that
 * sits in the same bar is ui/settings.js, rendered into its own root.
 */

import { escapeHtml } from "../core/format.js";
import { POOL_KINDS, KIND_IDS, normaliseKinds } from "../sports.js";

/** Latest handlers, so the listeners bound on the first render stay current. */
let handlers = { onPool: () => {}, onHome: () => {} };
/** The options currently in the picker, to know when they need rebuilding. */
let painted = "";

/**
 * @param {HTMLElement} root
 * @param {{league:{code:string,name:string,kinds:string[]}|null, kind?:string|null}} state
 *   The open league and the pool of the board showing.
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

  const select = root.querySelector(".league-bar__select");
  const signature = `${league?.code ?? ""}:${kinds.join(",")}`;
  if (signature !== painted) {
    select.innerHTML = kinds
      .map((id) => `<option value="${id}">${escapeHtml(POOL_KINDS[id].label)}</option>`)
      .join("");
    painted = signature;
  }

  // One pool: nothing to pick, so the pill names it and the select is shut.
  const one = kinds.length === 1;
  root.querySelector(".league-bar__pool").classList.toggle("league-bar__pool--one", one);
  select.disabled = one;

  // Only when it differs: assigning to a select that is open on some platforms
  // scrolls it back to the assigned row.
  if (select.value !== showing) select.value = showing;
}

function build(root) {
  root.innerHTML = `
    <button type="button" class="league-bar__back">
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <path d="M7.5 2.5 4 6l3.5 3.5" />
      </svg>
      Leagues
    </button>
    <div class="league-bar__league">
      <h2 class="league-bar__name"></h2>
      <div class="league-bar__pool">
        <select class="league-bar__select" aria-label="Pool"></select>
        <svg class="league-bar__chevron" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" />
        </svg>
      </div>
    </div>`;

  root.querySelector(".league-bar__back").addEventListener("click", () => handlers.onHome());
  root.querySelector(".league-bar__select").addEventListener("change", (event) => {
    handlers.onPool(event.target.value);
  });
}
