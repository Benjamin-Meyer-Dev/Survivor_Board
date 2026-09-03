/**
 * Depth chart: every eligible team, best first, marked with where it sits on
 * the path. Three marks, kept apart so a suggestion is never mistaken for a
 * pick: locked teams are filled and checked, picked-but-unlocked teams are
 * outlined, and teams that are only in the coach's plan are ghosted.
 *
 * The legend runs across the foot of the chart. Each swatch in it is a tile
 * drawn by the same classes as the chart, in the state it explains, so the key
 * can never drift from what it describes.
 */

import { escapeHtml } from "../core/format.js";
import { allTeams } from "../core/plan.js";

export function renderBurnBoard(root, legendEl, board, teams) {
  const roster = allTeams(teams);
  // SP+ for college, market power ratings for the NFL. The file says which.
  const scale = teams.ratingSource ?? "rating";

  const sorted = Object.entries(roster).sort(
    ([teamA, a], [teamB, b]) => b.rating - a.rating || teamA.localeCompare(teamB),
  );

  root.innerHTML = sorted
    .map(([team, { rating }], index) => {
      const mark = markFor(board, team);
      const rank = index + 1;
      const badge = mark ? `W${mark.week}` : `${rating > 0 ? "+" : ""}${rating}`;
      return `
        <div class="burn__team${mark ? ` burn__team--${mark.state}` : ""}" style="--i:${index}"
             title="${escapeHtml(team)} · power rank #${rank} · ${escapeHtml(scale)} ${rating}${mark ? ` · ${mark.title}` : ""}">
          <span class="burn__identity">
            <span class="burn__rank" aria-label="Power rank ${rank}">#${rank}</span>
            <span class="burn__name">${escapeHtml(team)}</span>
          </span>
          <span class="burn__rating">${escapeHtml(badge)}</span>
        </div>`;
    })
    .join("");

  legendEl.innerHTML = legendMarkup();
}

/** Locked beats picked beats planned, so a team shows its firmest commitment. */
function markFor(board, team) {
  const spent = board.spentTeams[team];
  if (spent !== undefined) {
    return { state: "spent", week: spent, title: `locked week ${spent}` };
  }
  const picked = board.pickedTeams[team];
  if (picked !== undefined) {
    return {
      state: "picked",
      week: picked,
      title: `picked week ${picked}, not locked`,
    };
  }
  const planned = board.plannedTeams[team];
  if (planned !== undefined) {
    return { state: "planned", week: planned, title: `coach plan week ${planned}` };
  }
  return null;
}

/** One compact sample for each state the chart can show. */
function legendMarkup() {
  const items = [
    {
      swatch: "burn__team--spent",
      badge: "W3",
      key: "Locked",
    },
    {
      swatch: "burn__team--picked",
      badge: "W5",
      key: "Picked",
    },
    {
      swatch: "burn__team--planned",
      badge: "W7",
      key: "Coach Plan",
    },
    {
      swatch: "legend__swatch--open",
      badge: "+21",
      key: "Open",
    },
  ];

  return items
    .map(
      (item) => `
      <div class="legend__item">
        <span class="burn__team legend__swatch ${item.swatch}" aria-hidden="true">
          <span class="burn__identity"><span class="burn__name">Team</span></span>
          <span class="burn__rating">${item.badge}</span>
        </span>
        <span class="legend__key">${escapeHtml(item.key)}</span>
      </div>`,
    )
    .join("");
}
