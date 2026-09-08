/**
 * League switch.
 *
 * The boards this device can open, as a dropdown, plus the way back to the
 * home page. It was a segmented control when there were exactly three pools
 * built into the app; a person can now be in as many leagues as they are in
 * pools, and a control that grows a cell per league is not a control.
 *
 * One row per board rather than per league: a league that plays more than one
 * season is listed once for each, as "The Office Pool · NFL" and "The Office
 * Pool · College", so the closed picker always names both the league and the
 * season the board beneath it is showing. A league of one season is a single
 * row under its own name.
 *
 * A native `select`, so the picker is the platform's own: a wheel on iOS, a
 * sheet on Android, a listbox on a desktop, all of them reachable by keyboard
 * and screen reader without a line of code here. What is styled is the closed
 * state, which is the state it is in on every render.
 *
 * Built ONCE and updated in place afterwards, like the tab bar: this runs on
 * every board render, and replacing the element under an open picker would
 * close it mid-choice. The options themselves are rebuilt only when the list
 * of boards actually changes, for the same reason.
 *
 * Rendering only: app.js owns the reload that follows a change.
 */

import { escapeHtml } from "../core/format.js";
import { SPORTS, SPORT_IDS, normaliseSports } from "../sports.js";

/** Latest handler, so the listener bound on the first render stays current. */
let onLeague = () => {};
/** The options currently in the picker, to know when they need rebuilding. */
let painted = "";

/** The value that means "leave this league and show the home page". */
const HOME = "home";

/** An option's value: which league, and which of its seasons, as app.js reads it. */
const valueFor = (code, sport) => `${code}/${sport}`;

/**
 * @param {HTMLElement} root
 * @param {{league:{code:string,name?:string,sports?:string[]}|null,
 *   sport?:string|null, leagues:Array<object>}} state `league` is the open one,
 *   or null on the home page, and `sport` the season of the board showing.
 * @param {(target: string) => void} onSelect Called with "CODE/SPORT", or
 *   "home".
 */
export function renderLeagueSwitch(root, { league, sport = null, leagues }, onSelect) {
  if (!root) return;
  onLeague = onSelect;

  if (!root.firstElementChild) buildSwitch(root);

  const select = root.querySelector(".league__select");
  const open = league?.code ?? null;

  const listed = leagues.map(seasonsOf);
  // The open league may not be in this device's list yet - a link just opened,
  // a create still settling - so it is added to the options in its own right.
  const entries =
    open && !listed.some((entry) => entry.code === open)
      ? [
          seasonsOf({
            code: open,
            name: league.name ?? "This league",
            sports: league.sports ?? [sport],
          }),
          ...listed,
        ]
      : listed;

  const signature = entries
    .map((entry) => `${entry.code}:${entry.name}:${entry.sports.join(",")}`)
    .join("|");
  if (signature !== painted) {
    select.innerHTML = `
      ${entries.flatMap(optionsFor).join("")}
      <option value="${HOME}">${entries.length ? "All leagues…" : "Home"}</option>`;
    painted = signature;
  }

  // Only when it differs: assigning to a select that is open on some platforms
  // scrolls it back to the assigned row.
  const showing = entries.find((entry) => entry.code === open);
  const season = showing?.sports.includes(sport) ? sport : showing?.sports[0];
  const value = open ? valueFor(open, season) : HOME;
  if (select.value !== value) select.value = value;
}

/**
 * A league's seasons, cleaned. A league with none the repo still carries is
 * drawn as one of the first season rather than as a row with no board.
 */
function seasonsOf(league) {
  const sports = normaliseSports(league.sports ?? [league.sport]);
  return { code: league.code, name: league.name, sports: sports.length ? sports : [SPORT_IDS[0]] };
}

/** One option per board: the league's name alone, or with the season when it has several. */
function optionsFor(entry) {
  return entry.sports.map((sport) => {
    const label = entry.sports.length > 1 ? `${entry.name} · ${SPORTS[sport].label}` : entry.name;
    return `
        <option value="${escapeHtml(valueFor(entry.code, sport))}">${escapeHtml(label)}</option>`;
  });
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
