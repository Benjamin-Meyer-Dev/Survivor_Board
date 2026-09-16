/**
 * The coach's case: why this pick and not the other three.
 *
 * The card above the drawer says what the coach calls for. It has never said
 * why, and the why is the whole of what this app knows that a glance at the
 * lines does not. The optimiser judges the openings to the week on the clock
 * across thirty-two futures and keeps the best four of them - each one's week,
 * the season it leads to, and how often it held up - and until now that
 * reasoning was computed on every plan and shown nowhere (board.frontier, out
 * of core/recommend.js).
 *
 * What it is for is the one thing a survivor board has to teach: the biggest
 * favourite this week is usually not the best pick of the season. A team at
 * 81% now that the plan needs in November is worth less than one at 73% that
 * costs nothing later, and no amount of staring at a spread will show that.
 * Two columns side by side do.
 *
 * Three states, because the band is between the field and the card and both of
 * those follow the week you are looking at, so this has to as well:
 *
 *   - the week the coach is actually deciding: the full case, four candidates
 *     against three measures.
 *   - any other week still to play: what the coach ranks there, and the line.
 *     No season number and no futures - those are judged for the opening in
 *     hand and for nothing else - so the columns say something different
 *     rather than standing empty.
 *   - a week that has been played: nothing. The result is on the field, the
 *     drive line and the card already, and a coach's ranking of games that are
 *     over is not an opinion, it is a list.
 *
 * Read-only. Everything here can be acted on one thumb away - the call card
 * takes the top call, the sideline takes any of them - and a third place to
 * pick a team is a third place to pick it by accident.
 *
 * The box it stands in keeps its height whatever this puts in it (layout.css),
 * so scrubbing along the field never resizes the field.
 */

import { formatPercent, formatSpread, formatMatchup, escapeHtml } from "../core/format.js";
import { frame, reconcile } from "./patch.js";

/** How many of the coach's calls a week that is not the decision shows. */
const RANKED_SHOWN = 4;

/**
 * @param {HTMLElement} root
 * @param {object} board Result of buildBoard().
 * @param {number} viewWeek The week being looked at (1-based).
 */
export function renderCoach(root, board, viewWeek) {
  const week = board.weeks.find((entry) => entry.week === viewWeek) ?? board.weeks[0];
  const panel = frame(root, `<div class="coach"></div>`);
  const state = caseFor(board, week);
  panel.classList.toggle("coach--empty", state.kind === "none");
  reconcile(panel, state.kind === "none" ? "" : head(state) + table(state) + foot(state));
}

/**
 * Which of the three the week is, and the rows for it.
 *
 * The frontier belongs to one week - the first with a slot still open, which
 * is not always the week on the clock - and it is null while a plan is being
 * worked out and for a board planned around locks that have since moved. Every
 * one of those is a week with no case to make rather than an error.
 */
function caseFor(board, week) {
  if (board.eliminated) return { kind: "none" };

  const frontier = board.frontier;
  if (frontier && frontier.week === week.week && frontier.candidates?.length) {
    return { kind: "case", week, frontier, rows: frontier.candidates };
  }

  // Played, or playing: the week's own numbers are history and the board tells
  // that story three other ways.
  const settled = week.picks.every((pick) => pick.status.result) || week.week < board.currentWeek;
  if (settled) return { kind: "none" };

  const ranked = (week.coachRanked ?? []).slice(0, RANKED_SHOWN);
  if (!ranked.length) return { kind: "none" };
  return { kind: "ranked", week, rows: ranked };
}

function head(state) {
  const what = state.kind === "case" ? "The coach’s case" : "The coach ranks";
  const futures =
    state.kind === "case" && state.frontier.scenarios
      ? `<span class="coach__futures">${state.frontier.scenarios} futures</span>`
      : "";
  return `<div class="coach__head" data-key="head">
    <span class="u-eyebrow coach__what">${what} · Wk ${String(state.week.week).padStart(2, "0")}</span>
    ${futures}
  </div>`;
}

/**
 * The rows, as a grid so the figures line up in columns down the block. A list
 * rather than a table: there is no row header to give a table its meaning, and
 * a screen reader reading "row 2, column 3" over four numbers is worse off
 * than one reading four labelled lines.
 */
function table(state) {
  const columns =
    state.kind === "case"
      ? `<span class="coach__col">Week</span>
         <span class="coach__col" title="Your chance of surviving the whole season if you take this">Season</span>
         <span class="coach__col" title="Share of the futures the coach judged in which this held up as well as the best of them">Holds</span>`
      : `<span class="coach__col">Week</span>
         <span class="coach__col">Spread</span>`;

  const rows =
    state.kind === "case"
      ? state.rows.map((candidate, index) => caseRow(candidate, index)).join("")
      : state.rows.map((option) => rankedRow(option, state.week)).join("");

  return `<div class="coach__table coach__table--${state.kind}" data-key="table">
    <div class="coach__columns" aria-hidden="true">
      <span></span>${columns}
    </div>
    <ol class="coach__rows">${rows}</ol>
  </div>`;
}

/**
 * One candidate. The teams are the opening, so a college week names two of
 * them; they are the pair or nothing, which is why they share a cell rather
 * than taking a row each.
 *
 * The season figure carries the confidence chalk of the week's own pick so the
 * column reads the way every other probability on the board does, and the
 * chosen row wears the flag - it is the one the card is already showing.
 */
function caseRow(candidate, index) {
  const options = candidate.options ?? [];
  const teams = options.length ? options.map((option) => option.team) : candidate.teams;
  const tier = options[0]?.tier;
  // Who it plays, under the name. Only where the opening is one team: a
  // college week names two, and two games under two names is four lines in a
  // row that has room for two.
  const game =
    options.length === 1 && options[0].opponent
      ? `<span class="coach__game">${escapeHtml(formatMatchup(options[0].site, options[0].opponent))}</span>`
      : "";
  return `<li class="coach__row${candidate.chosen ? " coach__row--chosen" : ""}"
       data-key="row-${index}">
    <span class="coach__team">
      <span class="coach__pick">${escapeHtml(teams.join(" + "))}</span>
      ${game}
    </span>
    <span class="coach__figure${tier ? ` confidence--${tier}` : ""}">${formatPercent(candidate.weekWinProb, 0)}</span>
    <span class="coach__figure coach__figure--season">${formatPercent(candidate.season, 1)}</span>
    <span class="coach__figure coach__figure--robust">${formatPercent(candidate.robust, 0)}</span>
  </li>`;
}

/** One of the coach's calls for a week it is not deciding yet. */
function rankedRow(option, week) {
  const taken = week.picks.some((pick) => pick.team === option.team);
  return `<li class="coach__row${taken ? " coach__row--chosen" : ""}" data-key="row-${option.team}">
    <span class="coach__team">
      <span class="coach__pick">${escapeHtml(option.team)}</span>
      ${option.opponent ? `<span class="coach__game">${escapeHtml(formatMatchup(option.site, option.opponent))}</span>` : ""}
    </span>
    <span class="coach__figure${option.tier ? ` confidence--${option.tier}` : ""}">${formatPercent(option.winProb, 0)}</span>
    <span class="coach__figure coach__figure--season">${formatSpread(option.spread)}</span>
  </li>`;
}

/**
 * The line under the table, and the only sentence on it: what the runner-up
 * would cost. It is the number the two columns are there to make visible, said
 * once in words for the reading that does not compare columns.
 *
 * Only where the runner-up is actually behind. Two openings the search cannot
 * separate are two openings worth the same, and "costs 0% of your season" is a
 * sentence that has nothing to say.
 *
 * Written around the name rather than through it. A team is a plural in
 * American usage and a singular in the rest of it - "Buccaneers is the next
 * best" is wrong to half the people reading it and "are" is wrong to the other
 * half - so the name is named and the sentence goes on without it.
 */
function foot(state) {
  if (state.kind !== "case") return "";
  const [call, next] = state.rows;
  if (!call || !next) return "";

  const cost = next.seasonCost ?? 0;
  if (cost < 0.01) {
    return `<p class="coach__note" data-key="note">Nothing in it: the top two hold the season up as well as each other.</p>`;
  }

  const name = escapeHtml(
    (next.options?.length ? next.options.map((option) => option.team) : next.teams).join(" + "),
  );
  // The whole point of the two columns, in a sentence: the sharper bet this
  // week is the dearer one over the season.
  const sharper = next.weekWinProb > call.weekWinProb + 0.005;
  const why = sharper ? " — sharper this week," : ",";
  return `<p class="coach__note" data-key="note">Next best: ${name}${why} ${formatPercent(cost, 0)} of the season behind.</p>`;
}
