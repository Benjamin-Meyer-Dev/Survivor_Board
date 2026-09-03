/**
 * League switch.
 *
 * Two pools, one board. A segmented control rather than a dropdown because
 * there are exactly two of them and the current one should be readable without
 * opening anything.
 *
 * Built ONCE and updated in place afterwards, for the same reason the tab bar
 * is: this runs on every board render, and a marker element rebuilt from
 * markup has no previous position to slide from.
 *
 * Rendering only: app.js owns the reload that follows a change.
 */

import { LEAGUES, LEAGUE_IDS } from "../leagues.js";
import { escapeHtml } from "../core/format.js";

/** Latest handler, so the listeners bound on the first render stay current. */
let onLeague = () => {};

/**
 * @param {HTMLElement} root
 * @param {string} active Current league id.
 * @param {(id: string) => void} onSelect
 */
export function renderLeagueSwitch(root, active, onSelect) {
  if (!root) return;
  onLeague = onSelect;

  if (!root.firstElementChild) buildSwitch(root);

  const index = Math.max(LEAGUE_IDS.indexOf(active), 0);
  root.querySelector(".league__marker")?.style.setProperty("--i", String(index));

  for (const button of root.querySelectorAll("[data-league]")) {
    button.setAttribute("aria-pressed", String(button.dataset.league === active));
  }
}

function buildSwitch(root) {
  root.innerHTML = `
    <div class="league" role="group" aria-label="League">
      <span class="league__marker" aria-hidden="true"
            style="--n:${LEAGUE_IDS.length};--i:0"></span>
      ${LEAGUE_IDS.map(
        (id) => `
        <button type="button" class="league__btn" data-league="${id}"
                aria-pressed="false"
                aria-label="${escapeHtml(LEAGUES[id].label)}"
                >${escapeHtml(LEAGUES[id].short)}</button>`,
      ).join("")}
    </div>`;

  root.querySelectorAll("[data-league]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.getAttribute("aria-pressed") === "true") return;
      onLeague(button.dataset.league);
    });
  });
}
