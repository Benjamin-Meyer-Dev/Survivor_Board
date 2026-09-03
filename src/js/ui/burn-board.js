/**
 * Burn board: all eligible teams, sorted by rating, struck through once the
 * plan spends them. Answers "who is still on the table" at a glance.
 */

import { escapeHtml } from "../core/format.js";
import { allTeams } from "../core/plan.js";

export function renderBurnBoard(root, countEl, board, teams) {
  const roster = allTeams(teams);
  // SP+ for college, market power ratings for the NFL. The file says which.
  const scale = teams.ratingSource ?? "rating";

  const sorted = Object.entries(roster).sort(([, a], [, b]) => b.rating - a.rating);

  root.innerHTML = sorted
    .map(([team, { rating }], index) => {
      const spentWeek = board.spentTeams[team];
      const badge = spentWeek ? `W${spentWeek}` : `${rating > 0 ? "+" : ""}${rating}`;
      return `
        <div class="burn__team${spentWeek ? " burn__team--spent" : ""}" style="--i:${index}"
             title="${escapeHtml(team)} · ${escapeHtml(scale)} ${rating}${spentWeek ? ` · spent week ${spentWeek}` : ""}">
          <span>${escapeHtml(team)}</span>
          <span class="burn__rating">${escapeHtml(badge)}</span>
        </div>`;
    })
    .join("");

  countEl.textContent = `${board.spentCount} of ${board.totalTeams} spent`;
}
