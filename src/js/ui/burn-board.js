/**
 * Depth chart: every eligible team, best first, marked with where it sits on
 * the path. Three marks, kept apart so a suggestion is never mistaken for a
 * pick: locked teams are crossed off, picked-but-unlocked teams are outlined,
 * and teams that are only in the coach's plan are ghosted.
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
      const mark = markFor(board, team);
      const badge = mark ? `${mark.letter}${mark.week}` : `${rating > 0 ? "+" : ""}${rating}`;
      return `
        <div class="burn__team${mark ? ` burn__team--${mark.state}` : ""}" style="--i:${index}"
             title="${escapeHtml(team)} · ${escapeHtml(scale)} ${rating}${mark ? ` · ${mark.title}` : ""}">
          <span>${escapeHtml(team)}</span>
          <span class="burn__rating">${escapeHtml(badge)}</span>
        </div>`;
    })
    .join("");

  countEl.textContent = `${board.spentCount} locked · ${board.pickedCount} picked · ${board.plannedCount} in coach plan`;
}

/** Locked beats picked beats planned, so a team shows its firmest commitment. */
function markFor(board, team) {
  const spent = board.spentTeams[team];
  if (spent !== undefined) {
    return { state: "spent", letter: "W", week: spent, title: `locked week ${spent}` };
  }
  const picked = board.pickedTeams[team];
  if (picked !== undefined) {
    return {
      state: "picked",
      letter: "W",
      week: picked,
      title: `picked week ${picked}, not locked`,
    };
  }
  const planned = board.plannedTeams[team];
  if (planned !== undefined) {
    return { state: "planned", letter: "P", week: planned, title: `coach plan week ${planned}` };
  }
  return null;
}
