/**
 * Who is in this league, hung under an info button.
 *
 * Two places ask the same question. The home card names a league you are not
 * looking at yet and says "3 people" beside its pools; the topline names the
 * one you are on. In both, the number was the whole answer - three people, and
 * no way to find out which three without leaving for the other board and back.
 *
 * So the count gets a button and the button gets the names. One panel, built
 * the same way in both places, because it is the same question and a person who
 * learns it on the home page should not have to learn it again on the board.
 *
 * Only where there is somebody else. A league of one is a list with your own
 * name in it, which answers nothing, and an icon that opens it is a control
 * that never has anything to say.
 *
 * The panel is markup rather than a `<dialog>`: it is four names hung off the
 * corner of something, closer to the pool picker beside it (ui/league-bar.js)
 * than to the sheets the home page opens. One listener on the document runs
 * every panel on the page, so a list of cards costs one listener rather than
 * one per card, and opening any panel closes whichever was already open.
 */

import { escapeHtml } from "../core/format.js";

/** The info glyph: the dot and the stem, at the same weight as the icons beside it. */
const INFO = `<svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <path d="M12 7.75v.5" />
  </svg>`;

/** Ids have to be unique on the page, and a card's code is not enough on its own. */
let count = 0;

/** Whether the document listener is on. It is bound once, for every panel. */
let watching = false;

/**
 * The button and its panel, as markup to drop into a card or a bar.
 *
 * @param {Array<{id:string, name:string}>} people Everyone in the league.
 * @param {string} me This device's member id, so one row can say so.
 * @param {object} [options]
 * @param {string} [options.className] Extra classes for the button, so it can
 *   wear whatever its neighbours wear.
 * @param {boolean} [options.right] Hang the panel off the right edge instead,
 *   for a button sitting at the right of its row.
 * @returns {string} Empty when there is nobody else, which is the caller's
 *   answer to whether the button belongs there at all.
 */
export function rosterMarkup(people, me, { className = "", right = false } = {}) {
  const list = Array.isArray(people) ? people : [];
  if (list.length < 2) return "";

  const id = `roster-${++count}`;
  return `
    <div class="roster">
      <button type="button" class="roster__open ${className}" data-roster="${id}"
              aria-expanded="false" aria-controls="${id}"
              aria-label="Who is in this league" title="Who is in this league">${INFO}</button>
      <div class="roster__panel${right ? " roster__panel--right" : ""}" id="${id}" hidden
           role="group" aria-label="Who is in this league">
        <ul class="roster__list">
          ${list.map((person) => row(person, me)).join("")}
        </ul>
      </div>
    </div>`;
}

/**
 * One person. A name the league was joined without falls back to the word
 * rather than to an empty row: somebody is there either way, and a blank line
 * reads as the list having failed rather than as a person who never said.
 */
function row(person, me) {
  const name = person.name?.trim() || "Someone";
  const mine = person.id === me;
  return `
    <li class="roster__person${mine ? " roster__person--me" : ""}">
      <span class="roster__name">${escapeHtml(name)}</span>
      ${mine ? `<span class="roster__you">you</span>` : ""}
    </li>`;
}

/**
 * Run every roster panel on the page, now and for the rest of the session.
 *
 * Called once at startup. Bound to the document rather than to a panel's own
 * root because both hosts rebuild their markup underneath it - the home list
 * redraws as leagues arrive, the topline on every board render - and a listener
 * on the document outlives all of that.
 */
export function watchRosters() {
  if (watching) return;
  watching = true;

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest?.("[data-roster]");
    if (trigger) {
      const panel = document.getElementById(trigger.dataset.roster);
      const opening = panel?.hidden;
      closeAll();
      if (opening) open(trigger, panel);
      return;
    }
    // A tap inside an open panel is not a tap that should close it; anywhere
    // else on the page is.
    if (!event.target.closest?.(".roster__panel")) closeAll();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const open = document.querySelector('[data-roster][aria-expanded="true"]');
    if (!open) return;
    // Only what this panel's own key press was for: a sheet or a menu open over
    // it has its own Escape, and it was offered this one first.
    event.stopPropagation();
    closeAll();
    open.focus();
  });

  // A panel hung off a card in a scrolling list has to go when the card does,
  // or it is left pointing at whatever scrolled into its place.
  document.addEventListener("scroll", () => closeAll(), { capture: true, passive: true });
}

function open(trigger, panel) {
  panel.hidden = false;
  trigger.setAttribute("aria-expanded", "true");

  // Below the button, unless below is where it would be cut in half. The home
  // list scrolls, so a card near the foot of it has no room under it at all,
  // and a panel hung there is a list of names with the names off the bottom.
  // Measured rather than guessed at, because what clips it is the scroller on
  // one page and the window on the other.
  panel.classList.remove("roster__panel--up");
  const box = panel.getBoundingClientRect();
  const limit = clipOf(panel);
  const under = limit.bottom - box.top;
  const over = trigger.getBoundingClientRect().top - limit.top;
  if (box.height > under && over > under) panel.classList.add("roster__panel--up");
}

/**
 * The box that will cut this panel off: the nearest ancestor that scrolls or
 * hides what leaves it, and the window where there is none.
 */
function clipOf(node) {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(parent);
    if (/auto|scroll|hidden/.test(overflowY) || /auto|scroll|hidden/.test(overflowX)) {
      return parent.getBoundingClientRect();
    }
  }
  return { top: 0, bottom: window.innerHeight };
}

/** Put away whatever is open. Cheap enough to run on every stray tap. */
function closeAll() {
  for (const trigger of document.querySelectorAll('[data-roster][aria-expanded="true"]')) {
    trigger.setAttribute("aria-expanded", "false");
    const panel = document.getElementById(trigger.dataset.roster);
    if (panel) panel.hidden = true;
  }
}
