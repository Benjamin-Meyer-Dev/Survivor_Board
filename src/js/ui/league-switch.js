/**
 * League switch.
 *
 * The leagues this device is in, as a dropdown, plus the way back to the home
 * page. It was a segmented control when there were exactly three pools built
 * into the app; a person can now be in as many leagues as they are in pools,
 * and a control that grows a cell per league is not a control.
 *
 * A native `select`, so the picker is the platform's own: a wheel on iOS, a
 * sheet on Android, a listbox on a desktop, all of them reachable by keyboard
 * and screen reader without a line of code here. What is styled is the closed
 * state, which is the state it is in on every render.
 *
 * Built ONCE and updated in place afterwards, like the tab bar: this runs on
 * every board render, and replacing the element under an open picker would
 * close it mid-choice. The options themselves are rebuilt only when the list
 * of leagues actually changes, for the same reason.
 *
 * Rendering only: app.js owns the reload that follows a change.
 */

import { escapeHtml } from "../core/format.js";

/** Latest handler, so the listener bound on the first render stays current. */
let onLeague = () => {};
/** The options currently in the picker, to know when they need rebuilding. */
let painted = "";

/** The value that means "leave this league and show the home page". */
const HOME = "home";

/**
 * @param {HTMLElement} root
 * @param {{league:{code:string,name:string}|null, leagues:Array<object>}} state
 *   `league` is the open one, or null on the home page.
 * @param {(target: string) => void} onSelect Called with a league code, or
 *   "home".
 */
export function renderLeagueSwitch(root, { league, leagues }, onSelect) {
  if (!root) return;
  onLeague = onSelect;

  if (!root.firstElementChild) buildSwitch(root);

  const select = root.querySelector(".league__select");
  const open = league?.code ?? null;

  // The open league may not be in this device's list yet - a link just opened,
  // a create still settling - so it is added to the options in its own right.
  const options = [
    ...(open && !leagues.some((entry) => entry.code === open)
      ? [{ code: open, name: league.name ?? "This league" }]
      : []),
    ...leagues.map((entry) => ({ code: entry.code, name: entry.name })),
  ];

  const signature = options.map((entry) => `${entry.code}:${entry.name}`).join("|");
  if (signature !== painted) {
    select.innerHTML = `
      ${options
        .map(
          (entry) => `
        <option value="${escapeHtml(entry.code)}">${escapeHtml(entry.name)}</option>`,
        )
        .join("")}
      <option value="${HOME}">${options.length ? "All leagues…" : "Home"}</option>`;
    painted = signature;
  }

  // Only when it differs: assigning to a select that is open on some platforms
  // scrolls it back to the assigned row.
  const value = open ?? HOME;
  if (select.value !== value) select.value = value;
}

function buildSwitch(root) {
  root.innerHTML = `
    <div class="league">
      <select class="league__select" aria-label="League"></select>
      <svg class="league__chevron" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2.5 4.5 6 8l3.5-3.5" />
      </svg>
    </div>`;

  root.querySelector(".league__select").addEventListener("change", (event) => {
    onLeague(event.target.value);
  });
}
