/**
 * The topline's league bar.
 *
 * The open league, at the top of the board: the way back to every league, the
 * league's name, who else is on it, a way to ask whether anything has changed,
 * and which of its pools the board is showing, with the pool's paint as a
 * mark.
 *
 * The refresh button sits beside the info button because the two answer
 * neighbouring questions about the same league - who is in it, and what they
 * have done since you looked. It is here rather than left to a pull at the top
 * of the page: the page does not reload on a pull (base.css stops it, and a
 * reload would lose the week you were on), so the gesture people reach for had
 * nothing behind it. It also does the one thing the pull was good for - a new
 * build of the app arrives on it (checkForUpdate in app.js), and the reload
 * that brings it in comes back to the week and the slot it left.
 *
 * The name and the pool stack as a title block - the name chalked large, the
 * pool as a line under it - so the name gets the bar's whole width between the
 * back arrow and the gear, minus the two tools it carries. The picker holds
 * this one league's
 * pools - "NFL winners", "NFL losers" - and nothing else, because that is the
 * choice a person on a board actually makes; another league is a trip through
 * the home page. A league of one pool has nothing to pick, so its line just
 * names it.
 *
 * The picker is drawn here, not by the platform: a chalkboard hung under the
 * line with a row per pool, the one showing checked and any pool whose run is
 * over marked OUT (see `row`). It used to be a native
 * `select`, and on Android that opens the system's own radio dialog in the
 * middle of the field, in the system's face and colours - the one thing on the
 * board that is not chalk on turf. The price is that the keyboard and screen
 * reader behaviour is written out below: the line is a button that opens a
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
import { afterMotion, prefersReducedMotion } from "./motion.js";
import { rosterMarkup } from "./roster.js";

/**
 * The refresh glyph: one turn of the wheel, with the head where the turn ends.
 * Drawn on the same circle as the info button beside it (r=7.3 about the
 * middle, near enough the roster's r=9 once its arrow is counted), so the two
 * discs hold glyphs of the same weight rather than one large and one small.
 */
const REFRESH = `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M20 5v5h-5" />
    <path d="M18.4 15.5A7.3 7.3 0 1 1 17.2 6.9L20 10" />
  </svg>`;

/** Latest handlers, so the listeners bound on the first render stay current. */
let handlers = { onPool: () => {}, onHome: () => {}, onRefresh: () => {} };
/** The rows currently in the menu, to know when they need rebuilding. */
let painted = "";
/** And which of them were marked out, for the same reason. */
let marked = "";
/** And who was last in the roster panel, for the same reason. */
let roster = "";
/** The bar's root once built, for the outside-tap listener. */
let bar = null;

/**
 * @param {HTMLElement} root
 * @param {{league:{code:string,name:string,kinds:string[],
 *   people?:Array<{id:string,name:string}>}|null, kind?:string|null,
 *   me?:string, standings?:Record<string,{eliminated:boolean,
 *   eliminatedWeek:number|null}>}} state `me` is this device's member id, so
 *   the roster can say which row is you. `standings` says which of the
 *   league's pools are out (readStandings in app.js); a kind it does not name
 *   is one nothing is known about yet, and its row is drawn plain.
 * @param {{onPool:(kind:string)=>void, onHome:()=>void, onRefresh:()=>void}} given
 */
export function renderLeagueBar(root, { league, kind = null, me = "", standings = {} }, given) {
  if (!root) return;
  handlers = given;

  if (!root.firstElementChild) build(root);

  const kinds = normaliseKinds(league?.kinds);
  if (kinds.length === 0) kinds.push(KIND_IDS[0]);
  const showing = kinds.includes(kind) ? kind : kinds[0];

  root.querySelector(".league-bar__name").textContent = league?.name ?? "";

  // Who else is on this board. Rebuilt only when the people change: this runs
  // on every render, and replacing the button under an open panel would shut
  // it while somebody was reading it.
  const people = Array.isArray(league?.people) ? league.people : [];
  const named = people.map((person) => `${person.id}:${person.name}`).join("|");
  if (named !== roster) {
    root.querySelector(".league-bar__who").innerHTML = rosterMarkup(people, me, {
      className: "league-bar__icon",
    });
    roster = named;
  }

  const menu = root.querySelector(".league-bar__menu");
  const signature = `${league?.code ?? ""}:${kinds.join(",")}`;
  // A run ending is a change to the rows themselves, so it is part of what
  // says whether they need rebuilding. Rebuilt together rather than patched
  // in place: a mark arriving on a row is the menu being made, not a menu
  // somebody is reading changing under them - the standings land within a
  // render or two of the board, long before anyone has opened it.
  const outs = kinds.map((id) => (standings[id]?.eliminated ? "1" : "0")).join("");
  if (signature !== painted || outs !== marked) {
    // Another league, or a pool added or taken away: new rows, and a menu
    // open on the old ones is put away rather than left showing them. On the
    // spot, not on its own motion: the rows it would be fading are replaced on
    // the next line, so there is nothing left to watch go.
    closeMenu(root, { now: true });
    menu.innerHTML = kinds.map((id) => row(id, standings[id])).join("");
    painted = signature;
    marked = outs;
  }

  const one = kinds.length === 1;
  const trigger = root.querySelector(".league-bar__pool");
  trigger.classList.toggle("league-bar__pool--one", one);
  trigger.disabled = one;
  if (one) closeMenu(root);

  root.querySelector(".league-bar__showing").textContent = POOL_KINDS[showing].label;
  for (const option of menu.children) {
    option.setAttribute("aria-selected", String(option.dataset.kind === showing));
  }
}

/**
 * Say the pool named on the line is being got ready.
 *
 * A board is not swapped until the next one is built and planned (switchPool
 * in app.js), so between the tap and the change there is a stretch where the
 * board you are looking at is the old one and the picker already says the new
 * one. That stretch is the whole of what a cold pool costs, and it used to
 * happen behind a board faded to nothing, where there was nothing to say.
 *
 * The mark is on the line rather than beside it: no spinner, no word, just the
 * pool's own name breathing in the chalk it is about to be drawn in. The line
 * stops taking taps while it runs - the switch is already being made, and a
 * second one cannot be.
 *
 * @param {HTMLElement|null} root
 * @param {boolean} busy
 */
export function markPoolLoading(root, busy) {
  const trigger = root?.querySelector(".league-bar__pool");
  if (!trigger) return;
  trigger.classList.toggle("is-loading", busy);
  if (busy) trigger.setAttribute("aria-busy", "true");
  else trigger.removeAttribute("aria-busy");
}

/**
 * Say the board is being checked.
 *
 * The glyph turns - the wheel it is drawn as, doing the thing it depicts -
 * rather than a spinner arriving beside it, and it takes no second tap while
 * it does, since the read is already out. What the refresh finds says itself:
 * a change settles onto the board the way another phone's lock does, and a
 * board that has not moved does not move.
 *
 * @param {HTMLElement|null} root
 * @param {boolean} busy
 */
export function markRefreshing(root, busy) {
  const button = root?.querySelector(".league-bar__refresh");
  if (!button) return;
  button.classList.toggle("is-refreshing", busy);
  if (busy) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
}

/**
 * One pool, as a row: its paint, its name, an OUT mark where the run is over,
 * and a check when it is the one showing.
 *
 * The mark is the reason this menu is worth reading before you tap: two pools
 * of one league are told apart by their paint and their name, and neither says
 * that one of them ended in week 3. It is the danger the board's own "Out"
 * flag and the end-of-season band are drawn in, so the three are one signal,
 * and it names the week in its title for anyone who wants it.
 *
 * @param {string} id
 * @param {{eliminated:boolean, eliminatedWeek:number|null}} [standing] Absent
 *   for a pool nothing is known about yet, which is drawn plain: a row that
 *   has not been worked out and a row that is alive look the same, and the
 *   mark only ever appears, never quietly goes.
 */
function row(id, standing) {
  const out = Boolean(standing?.eliminated);
  const week = standing?.eliminatedWeek;
  return `
    <li class="league-bar__option" role="option" data-kind="${id}" tabindex="-1" aria-selected="false">
      <span class="league-bar__option-mark" aria-hidden="true"></span>
      <span class="league-bar__option-label">${escapeHtml(POOL_KINDS[id].label)}</span>
      ${out ? `<span class="league-bar__option-out"${week ? ` title="Eliminated in week ${week}"` : ""}>Out</span>` : ""}
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
      <div class="league-bar__title">
        <h2 class="league-bar__name"></h2>
        <div class="league-bar__tools">
          <div class="league-bar__who"></div>
          <button type="button" class="league-bar__icon league-bar__refresh"
                  aria-label="Check for changes" title="Check for changes">${REFRESH}</button>
        </div>
      </div>
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
  root.querySelector(".league-bar__refresh").addEventListener("click", () => handlers.onRefresh());

  const trigger = root.querySelector(".league-bar__pool");
  const menu = root.querySelector(".league-bar__menu");

  trigger.addEventListener("click", () => (menu.hidden ? openMenu(root) : closeMenu(root)));
  trigger.addEventListener("keydown", (event) => {
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
  const trigger = root.querySelector(".league-bar__pool");
  const menu = root.querySelector(".league-bar__menu");
  if (trigger.disabled || !menu.hidden) return;

  // A menu caught part way out is opened again rather than hidden behind its
  // own exit: the tap that re-opened it is the newer instruction.
  menu.classList.remove("league-bar__menu--right", "is-closing");
  closing = null;
  menu.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  // Hung from the trigger's left edge unless that would run off the screen, in
  // which case from its right.
  if (menu.getBoundingClientRect().right > window.innerWidth - 8) {
    menu.classList.add("league-bar__menu--right");
  }
  document.addEventListener("pointerdown", onOutside, true);
  (menu.querySelector('[aria-selected="true"]') ?? menu.firstElementChild)?.focus();
}

/** The exit in flight, so an open, or a second close, can call it off. */
let closing = null;

/**
 * Put the menu away on its own motion.
 *
 * `hidden` is display:none, which is a cut: the CSS asks for the discrete
 * display change to wait for the fade, and the paths that cut were the ones
 * where the browser never got to run it. So the exit plays first and the hide
 * follows it (menu-exit in motion.css), for every way out - the trigger, a
 * press outside, Escape, Tab, and choosing a pool.
 *
 * @param {HTMLElement} root
 * @param {{refocus?:boolean, now?:boolean}} [options] `now` hides it on the
 *   spot, for a menu whose rows are about to be rebuilt under it.
 */
function closeMenu(root, { refocus = false, now = false } = {}) {
  const menu = root.querySelector(".league-bar__menu");
  const trigger = root.querySelector(".league-bar__pool");
  if (menu.hidden) return;

  // Focus and the announcement go now, whatever the motion is doing: a menu
  // that is on its way out is already shut as far as anything but the eye is
  // concerned, and a listbox left holding focus while it fades is a trap.
  trigger.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", onOutside, true);
  if (refocus) trigger.focus();

  if (now || prefersReducedMotion()) {
    menu.classList.remove("is-closing");
    closing = null;
    menu.hidden = true;
    return;
  }

  const play = {};
  closing = play;
  menu.classList.add("is-closing");
  afterMotion(menu, { subtree: false }).then(() => {
    // Opened again while this was playing: the menu on screen is the new one.
    if (closing !== play) return;
    closing = null;
    menu.hidden = true;
    menu.classList.remove("is-closing");
  });
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
