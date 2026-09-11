/**
 * The bench: every eligible team, best first, marked with where it sits on
 * the path. Three marks, kept apart so a suggestion is never mistaken for a
 * pick: burned teams are struck through, picked-but-unlocked teams are
 * outlined in the flag, and teams that are only in the coach's plan are
 * pencilled in.
 *
 * The legend runs across the foot. Each swatch in it is a card drawn by the
 * same classes as the chart, in the state it explains, so the key can never
 * drift from what it describes.
 */

import { escapeHtml } from "../core/format.js";
import { frame, paint, reconcile } from "./patch.js";

/**
 * @param {HTMLElement} root
 * @param {HTMLElement} legendEl
 * @param {object} board Result of buildBoard(), sorted roster and all. The
 *   teams file is not read here: the board is the whole of what a UI module
 *   sees, and flattening the conferences again for the depth chart was the one
 *   place that broke the rule.
 */
export function renderBench(root, legendEl, board) {
  // SP+ for college, market power ratings for the NFL. The file says which.
  const scale = board.ratingSource;

  // Card by card (ui/patch.js): a pick marks one card and clears another, and
  // the other thirty to fifty stay as they were rather than being rebuilt for
  // the tap and again when the search lands.
  reconcile(
    frame(root, `<div class="bench"></div>`),
    board.roster
      .map(({ team, rating }, index) => {
        const mark = markFor(board, team);
        const rank = index + 1;
        return `
        <div class="bench__team${mark ? ` bench__team--${mark.state}` : ""}" style="--i:${index}"
             data-key="${escapeHtml(team)}" data-motion-key="bench-${escapeHtml(team)}"
             data-motion-signature="${mark ? `${mark.state}-${mark.week}` : "open"}"
             title="${escapeHtml(team)} · power rank #${rank} · ${escapeHtml(scale)} ${rating}${mark ? ` · ${mark.title}` : ""}">
          <span class="bench__identity">
            <span class="bench__name">${escapeHtml(team)}</span>
          </span>
          <span class="bench__rating">
            ${mark ? `<span class="bench__week">W${mark.week}</span>` : ""}
            <span class="bench__rank" aria-label="Power rank ${rank}">#${rank}</span>
          </span>
        </div>`;
      })
      .join(""),
  );

  paint(legendEl, legendMarkup());
}

/** Locked beats picked beats planned, so a team shows its firmest commitment. */
function markFor(board, team) {
  const spent = board.spentTeams[team];
  if (spent !== undefined) {
    return { state: "spent", week: spent, title: `locked week ${spent}` };
  }
  const picked = board.pickedTeams[team];
  if (picked !== undefined) {
    return { state: "picked", week: picked, title: `picked week ${picked}, not locked` };
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
    { swatch: "bench__team--spent", badge: '<span class="bench__week">W3</span>', key: "Burned" },
    { swatch: "bench__team--picked", badge: '<span class="bench__week">W5</span>', key: "Picked" },
    {
      swatch: "bench__team--planned",
      badge: '<span class="bench__week">W7</span>',
      key: "Coach plan",
    },
    { swatch: "legend__swatch--open", badge: '<span class="bench__rank">#12</span>', key: "Open" },
  ];

  return items
    .map(
      (item) => `
      <div class="legend__item">
        <span class="bench__team legend__swatch ${item.swatch}" aria-hidden="true">
          <span class="bench__identity"><span class="bench__name">Team</span></span>
          <span class="bench__rating">${item.badge}</span>
        </span>
        <span class="legend__key">${escapeHtml(item.key)}</span>
      </div>`,
    )
    .join("");
}
