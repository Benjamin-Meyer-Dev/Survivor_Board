/**
 * Depth chart: every eligible team, best first, marked with where it sits on
 * the path. Three marks, kept apart so a suggestion is never mistaken for a
 * pick: locked teams are crossed off, picked-but-unlocked teams are outlined,
 * and teams that are only in the coach's plan are ghosted.
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

  const sorted = Object.entries(roster).sort(([, a], [, b]) => b.rating - a.rating);
  let open = 0;

  root.innerHTML = sorted
    .map(([team, { rating }], index) => {
      const mark = markFor(board, team);
      if (!mark) open += 1;
      const badge = mark ? `${mark.letter}${mark.week}` : `${rating > 0 ? "+" : ""}${rating}`;
      return `
        <div class="burn__team${mark ? ` burn__team--${mark.state}` : ""}" style="--i:${index}"
             title="${escapeHtml(team)} · ${escapeHtml(scale)} ${rating}${mark ? ` · ${mark.title}` : ""}">
          <span>${escapeHtml(team)}</span>
          <span class="burn__rating">${escapeHtml(badge)}</span>
        </div>`;
    })
    .join("");

  legendEl.innerHTML = legendMarkup(board, open);
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

/** One entry per state the chart can show, each with how many teams are in it. */
function legendMarkup(board, open) {
  const items = [
    {
      swatch: "burn__team--spent",
      badge: "W3",
      key: "Locked",
      count: board.spentCount,
      note: "crossed off, W and the week it was burned",
    },
    {
      swatch: "burn__team--picked",
      badge: "W5",
      key: "Picked",
      count: board.pickedCount,
      note: "outlined, not locked yet",
    },
    {
      swatch: "burn__team--planned",
      badge: "P7",
      key: "Coach plan",
      count: board.plannedCount,
      note: "pencilled in, P and the week the coach would take it",
    },
    {
      swatch: "legend__swatch--open",
      badge: "+21",
      key: "Open",
      count: open,
      note: "the number is the power rating",
    },
  ];

  return items
    .map(
      (item) => `
      <div class="legend__item">
        <span class="burn__team legend__swatch ${item.swatch}" aria-hidden="true">
          <span>Team</span>
          <span class="burn__rating">${item.badge}</span>
        </span>
        <span class="legend__text">
          <span class="legend__key">${escapeHtml(item.key)}</span>
          <span class="legend__note">${teamCount(item.count)} &middot; ${escapeHtml(item.note)}</span>
        </span>
      </div>`,
    )
    .join("");
}

function teamCount(count) {
  return `${count} team${count === 1 ? "" : "s"}`;
}
