/**
 * The model's working: how the week's pick was priced, and where the season
 * lands in the futures the coach ran.
 *
 * The card above the drawer says what the number is. This says how it got
 * there, in the turf between the field and the card, as two drawings:
 *
 *   1. The chain. Four stops from ratings to a tier - the two power ratings
 *      and the line they project, the market's line and where it opened, the
 *      probability the spread and the moneyline come to before the blend, and
 *      the tier that probability falls in. Every number is one the model used
 *      (option.pricing, out of core/plan.js); nothing is recomputed here.
 *
 *   2. The swarm. For the week the coach is deciding, the optimiser scores
 *      each opening across thirty-two futures of the rest of the season
 *      (core/scenarios.js) and until now kept only the mean. Each future's own
 *      answer is a chalk dot on a season-survival axis, one row per opening,
 *      the call lit. Where the dots bunch the model is sure; where they scatter
 *      it is betting on projections. Two rows that land on each other are two
 *      picks the search cannot tell apart, and you can see that rather than
 *      being told.
 *
 * Under both, one line each: how games the model priced like this have
 * actually gone (the calibration's bands), and how many futures agreed with
 * the runner-up.
 *
 * The subject of the chain is the slot the card has active - the pick, or the
 * coach's suggestion for an open slot - so it prices the team on the card, in
 * every week that still has a game to play. The swarm only exists for the week
 * with an open decision, since that is the only week the futures are run for.
 * A week already played shows nothing: its numbers are on the field, the drive
 * line and the card three times over.
 *
 * Read-only. Everything here can be acted on one thumb away.
 */

import { formatPercent, formatSpread, formatMatchup, escapeHtml } from "../core/format.js";
import { TIER_LABEL, DEFAULT_TIERS } from "../core/probability.js";
import { frame, reconcile } from "./patch.js";

/**
 * @param {HTMLElement} root
 * @param {object} board Result of buildBoard().
 * @param {number} viewWeek The week being looked at (1-based).
 * @param {number} activeSlot Which of the week's slots the card has active.
 */
export function renderCoach(root, board, viewWeek, activeSlot = 0) {
  const week = board.weeks.find((entry) => entry.week === viewWeek) ?? board.weeks[0];
  const panel = frame(root, `<div class="coach"></div>`);
  const state = stateFor(board, week, activeSlot);
  panel.classList.toggle("coach--empty", state.kind === "none");
  reconcile(
    panel,
    state.kind === "none"
      ? ""
      : head(state) + chain(state, board) + swarm(state) + facts(state, board),
  );
}

/**
 * What there is to show for the week: the subject to price, and the frontier
 * when this is the week it was judged for.
 *
 * The frontier belongs to one week - the first with a slot still open, which
 * is not always the week on the clock - and it is null while a plan is being
 * worked out and for a board planned around locks that have since moved.
 */
function stateFor(board, week, activeSlot) {
  if (board.eliminated) return { kind: "none" };
  const settled = week.picks.every((pick) => pick.status.result) || week.week < board.currentWeek;
  if (settled) return { kind: "none" };

  const pick = week.picks[Math.min(activeSlot, week.picks.length - 1)];
  // The team on the card for this slot, or failing that the coach's first
  // call for the week - whichever is priced.
  const subject = pick?.onPath?.pricing ? pick.onPath : (week.coachRanked ?? [])[0];
  if (!subject?.pricing) return { kind: "none" };

  const frontier = board.frontier;
  const judged =
    frontier && frontier.week === week.week && frontier.candidates?.length
      ? frontier.candidates
      : null;
  return { kind: "working", week, subject, frontier: judged ? frontier : null };
}

function head(state) {
  const { subject, week } = state;
  return `<div class="coach__head" data-key="head">
    <span class="u-eyebrow coach__what">The model’s working · Wk ${String(week.week).padStart(2, "0")}</span>
    <span class="coach__game">${escapeHtml(subject.team)} ${escapeHtml(formatMatchup(subject.site, subject.opponent))}</span>
  </div>`;
}

/**
 * The four stops. A projected week has no market stop to speak of, so that
 * stop says how far the projection is expected to miss instead - the widening
 * the futures are drawn with (core/probability.js horizonVariance).
 */
function chain(state, board) {
  const { subject } = state;
  const p = subject.pricing;
  const tiers = board.rules?.tiers ?? DEFAULT_TIERS;
  const tier = subject.tier;

  const rating = (value) => (Number.isFinite(value) ? value.toFixed(1) : "—");
  const ratingsSub = `${rating(p.team.rating)} v ${rating(p.opponent.rating)}`;
  const homeNote =
    p.homeField > 0
      ? `, ${formatSpread(-p.homeField).replace("-", "")} points for home field`
      : p.homeField < 0
        ? `, ${Math.abs(p.homeField)} points against for playing away`
        : ", neutral site";

  const market = p.market;
  const marketValue = market ? formatSpread(market.spread) : "—";
  const marketSub = market
    ? market.opened !== null && market.opened !== market.spread
      ? `opened ${formatSpread(market.opened)}`
      : market.books
        ? `${market.books} books`
        : "posted"
    : `±${p.horizonSd.toFixed(1)} pts`;
  const marketTitle = market
    ? `The market's line${market.books ? ` across ${market.books} books` : ""}${
        market.opened !== null ? `; it opened at ${formatSpread(market.opened)}` : ""
      }`
    : "No line posted yet: the model's own line, and how far a projection this many weeks out is expected to miss the line the market eventually posts";

  const price = subject.winProb;
  const blended = market && market.weight > 0 && market.moneylineProb !== null;
  // The sigma keeps its case: the sub-line is set in small caps and Σ is a
  // different letter.
  const priceSub = blended
    ? `ML ${formatMoneyline(market.moneyline)}`
    : `<span class="chain__sym">σ</span> ${p.sigma.toFixed(1)}`;
  const priceTitle = blended
    ? `The spread alone says ${formatPercent(p.fromSpread, 1)}; the moneyline says ${formatPercent(market.moneylineProb, 1)}; the blend weights the moneyline at ${Math.round(market.weight * 100)}%`
    : `A margin scattered ${p.sigma.toFixed(1)} points either side of the line${
        p.horizonSd ? `, widened by ±${p.horizonSd.toFixed(1)} for the weeks ahead` : ""
      }`;

  return `<ol class="chain" data-key="chain" aria-label="How ${escapeHtml(subject.team)} was priced">
    <li class="chain__stop" title="Power ratings, the fitted ones where the season has data${homeNote}">
      <span class="chain__key">Ratings</span>
      <span class="chain__value">${formatSpread(p.projected)}</span>
      <span class="chain__sub">${ratingsSub}</span>
    </li>
    <li class="chain__stop" title="${escapeHtml(marketTitle)}">
      <span class="chain__key">Market</span>
      <span class="chain__value">${marketValue}</span>
      <span class="chain__sub">${escapeHtml(marketSub)}</span>
    </li>
    <li class="chain__stop" title="${escapeHtml(priceTitle)}">
      <span class="chain__key">Win prob</span>
      <span class="chain__value${tier ? ` confidence--${tier}` : ""}">${formatPercent(price, 1)}</span>
      <span class="chain__sub">${priceSub}</span>
    </li>
    <li class="chain__stop" title="Where that probability falls on this league's confidence scale">
      <span class="chain__key">Tier</span>
      <span class="chain__value"><span class="chip chip--${tier}">${TIER_LABEL[tier] ?? tier}</span></span>
      <span class="chain__sub">${tierBand(tier, tiers)}</span>
    </li>
  </ol>`;
}

function formatMoneyline(moneyline) {
  if (!Number.isFinite(moneyline)) return "—";
  return `${moneyline > 0 ? "+" : ""}${moneyline}`;
}

/** The band of probability a tier covers, as the scale reads. */
function tierBand(tier, tiers) {
  const pct = (value) => `${Math.round(value * 100)}`;
  switch (tier) {
    case "safe":
      return `${pct(tiers.safe)}%+`;
    case "solid":
      return `${pct(tiers.solid)}–${pct(tiers.safe)}%`;
    case "thin":
      return `${pct(tiers.thin)}–${pct(tiers.solid)}%`;
    case "close":
      return `50–${pct(tiers.thin)}%`;
    default:
      return "under 50%";
  }
}

/**
 * The futures, as dots. One strip per opening on a shared axis, the point
 * estimate - the number the strip's own row on the drive line shows - as a bar
 * through the dots.
 *
 * The axis is the data's, not nought's. Four openings whose futures all land
 * between 3.4% and 3.6% drawn from zero are four identical smears in the last
 * inch of the strip; drawn from 3.3% to 3.7% they are four different shapes
 * across the whole of it, which is the drawing. The ticks say what the ends
 * are, so a spread that has been zoomed into reads as zoomed.
 */
function swarm(state) {
  const frontier = state.frontier;
  if (!frontier) return "";
  const rows = frontier.candidates.filter((candidate) => Array.isArray(candidate.survivals));
  if (!rows.length) return "";

  const values = rows.flatMap((candidate) => [...candidate.survivals, candidate.season]);
  const low = Math.min(...values);
  const high = Math.max(...values);
  // Room either side so the outermost dots are not on the ends, floored at a
  // tenth of a point so a set of identical futures still has an axis.
  const pad = Math.max((high - low) * 0.12, 0.001);
  const axisMin = Math.max(0, Math.floor((low - pad) * 1000) / 1000);
  const axisMax = Math.ceil((high + pad) * 1000) / 1000;
  const span = Math.max(axisMax - axisMin, 0.001);
  const at = (value) => `${(((value - axisMin) / span) * 100).toFixed(1)}%`;
  // One decimal unless the whole axis is under a point wide, when it takes two
  // to tell the ends apart.
  const tick = (value) => formatPercent(value, span < 0.01 ? 2 : 1);

  const list = rows
    .map((candidate, index) => {
      const teams = candidate.options?.length
        ? candidate.options.map((option) => option.team)
        : candidate.teams;
      // A pair is set a size smaller so it keeps to one line: every row the
      // same height is what lets the block drop whole rows when it is short
      // rather than half of one (components.css).
      const name = escapeHtml(teams.join(" + "));
      const dots = candidate.survivals
        .map((value) => `<span class="swarm__dot" style="left:${at(value)}"></span>`)
        .join("");
      // This week's chance beside the season's, because the two disagreeing
      // is the whole lesson: the sharpest pick this week is rarely the one
      // that gets the season furthest.
      const weekTier = candidate.options?.[0]?.tier;
      return `<li class="swarm__row${candidate.chosen ? " swarm__row--chosen" : ""}" data-key="row-${index}">
        <span class="swarm__name${teams.length > 1 ? " swarm__name--pair" : ""}">${name}</span>
        <span class="swarm__strip" aria-hidden="true">${dots}<span class="swarm__mark" style="left:${at(candidate.season)}"></span></span>
        <span class="swarm__week${weekTier ? ` confidence--${weekTier}` : ""}">${formatPercent(candidate.weekWinProb, 0)}</span>
        <span class="swarm__value">${formatPercent(candidate.season, 1)}</span>
      </li>`;
    })
    .join("");

  return `<div class="swarm" data-key="swarm">
    <div class="swarm__axis" aria-hidden="true">
      <span class="swarm__axis-label">${frontier.scenarios} futures</span>
      <span class="swarm__ticks"><span>${tick(axisMin)}</span><span>${tick((axisMin + axisMax) / 2)}</span><span>${tick(axisMax)}</span></span>
      <span class="swarm__axis-label swarm__axis-label--unit">Week</span>
      <span class="swarm__axis-label swarm__axis-label--unit">Season</span>
    </div>
    <ol class="swarm__rows">${list}</ol>
    <div class="swarm__legend" aria-hidden="true">
      <span class="swarm__legend-item"><span class="swarm__legend-dot"></span>one future</span>
      <span class="swarm__legend-item"><span class="swarm__legend-bar"></span>today’s number</span>
    </div>
  </div>`;
}

/**
 * Three figures across the foot, set like the stops above them - a key, a
 * number, a word under it - rather than as sentences. The record: of every
 * past game the model priced in this band, how many the favourite actually
 * won. The call: in how many futures it was the best opening or as good as.
 * The next best: named, and in how many futures it matched the call.
 */
function facts(state, board) {
  const items = [];

  const band = bandFor(board.calibrationBands, state.subject.winProb);
  if (band && band.n >= 20) {
    items.push(
      fact(
        "Track record",
        `${Math.round(band.predicted * 100)}% → ${Math.round(band.actual * 100)}%`,
        `${band.n} games priced like this`,
        "Of past games the model priced in this band, the share the favourite actually won",
      ),
    );
  }

  const total = state.frontier?.scenarios ?? 0;
  const [call, next] = state.frontier?.candidates ?? [];
  if (call && total) {
    items.push(
      fact(
        "Call holds up",
        `${Math.round((call.robust ?? 0) * total)} of ${total}`,
        "futures",
        "Futures in which the call was the best opening, or within a whisker of it",
      ),
    );
  }
  if (next && total) {
    const name = (
      next.options?.length ? next.options.map((option) => option.team) : next.teams
    ).join(" + ");
    const agree = Math.round((next.robust ?? 0) * total);
    items.push(
      fact(
        "Next best",
        escapeHtml(name),
        `even in ${agree} of ${total}`,
        "The runner-up, and the futures in which it did as well as the call",
        true,
      ),
    );
  }

  return items.length ? `<div class="facts" data-key="facts">${items.join("")}</div>` : "";
}

function fact(key, value, sub, title, isName = false) {
  return `<div class="facts__item" title="${escapeHtml(title)}">
    <span class="chain__key">${key}</span>
    <span class="chain__value${isName ? " chain__value--name" : ""}">${value}</span>
    <span class="chain__sub">${escapeHtml(sub)}</span>
  </div>`;
}

/** The calibration band a probability falls in, or null without a table. */
function bandFor(bands, probability) {
  if (!Array.isArray(bands) || !Number.isFinite(probability)) return null;
  // The bands are written for the favourite's side. A pick under even odds is
  // read through its opposite: a 40% pick is the 60% band seen from the other
  // bench.
  const p = probability < 0.5 ? 1 - probability : probability;
  return (
    bands.find((band) => p >= band.low && p < band.high) ??
    (p >= (bands.at(-1)?.low ?? 1) ? bands.at(-1) : null)
  );
}
