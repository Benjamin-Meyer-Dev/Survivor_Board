/**
 * Depth chart: selected teams are spent; coach-planned teams are advisory.
 * Both appear without conflating a suggestion with a user's actual pick.
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
      const plannedWeek = board.plannedTeams[team];
      const badge = spentWeek
        ? `W${spentWeek}`
        : plannedWeek
          ? `P${plannedWeek}`
          : `${rating > 0 ? "+" : ""}${rating}`;
      const stateClass = spentWeek
        ? " burn__team--spent"
        : plannedWeek
          ? " burn__team--planned"
          : "";
      const stateTitle = spentWeek
        ? ` · selected week ${spentWeek}`
        : plannedWeek
          ? ` · coach plan week ${plannedWeek}`
          : "";
      return `
        <div class="burn__team${stateClass}" style="--i:${index}"
             title="${escapeHtml(team)} · ${escapeHtml(scale)} ${rating}${stateTitle}">
          <span>${escapeHtml(team)}</span>
          <span class="burn__rating">${escapeHtml(badge)}</span>
        </div>`;
    })
    .join("");

  countEl.textContent = `${board.spentCount} selected · ${board.plannedCount} in coach plan`;
}
