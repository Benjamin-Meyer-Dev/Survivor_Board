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
      : head(state) + chain(state, board) + swarm(state) + foot(state, board),
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
 * The chain in a sentence, for the reading that does not follow dots along a
 * rule: what the ratings alone would make it, what the market makes it and
 * which way it has moved, and what that prices at. Shown when the band is tall
 * enough to afford a line of prose under the stops (components.css).
 */
function chainCaption(subject) {
  const p = subject.pricing;
  const team = escapeHtml(subject.team);
  const ratings = `Power ratings alone make ${team} ${formatSpread(p.projected)}${
    p.homeField > 0 ? " at home" : p.homeField < 0 ? " on the road" : ""
  }`;
  let market;
  if (p.market) {
    const moved =
      p.market.opened !== null && p.market.opened !== p.market.spread
        ? `, ${Math.abs(p.market.spread) > Math.abs(p.market.opened) ? "out" : "in"} from ${formatSpread(p.market.opened)}`
        : "";
    market = `the market says ${formatSpread(p.market.spread)}${moved}`;
  } else {
    market = `no line is posted yet, and a projection this far out usually misses by about ${p.horizonSd.toFixed(1)} points`;
  }
  const via =
    p.market && p.market.weight > 0 && p.market.moneylineProb !== null
      ? "with the moneyline"
      : "on the margin curve";
  const tier = TIER_LABEL[subject.tier] ?? subject.tier;
  return `<p class="coach__caption" data-key="chain-caption">${ratings}; ${market}; ${via} that prices at ${formatPercent(subject.winProb, 1)} — ${escapeHtml(tier)}.</p>`;
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
  </ol>${chainCaption(subject)}`;
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
 * The futures, as dots. One strip per opening on a shared axis from nought to
 * a little past the best any future managed, so the rows are read against
 * each other. The point estimate - the number the strip's own row on the drive
 * line shows - is a bar through the dots.
 */
function swarm(state) {
  const frontier = state.frontier;
  if (!frontier) return "";
  const rows = frontier.candidates.filter((candidate) => Array.isArray(candidate.survivals));
  if (!rows.length) return "";

  const top = Math.max(
    ...rows.flatMap((candidate) => [...candidate.survivals, candidate.season]),
    0.001,
  );
  // To the next half a percent, so the axis ends on a number worth printing.
  const axisMax = Math.ceil(top * 200) / 200;
  const at = (value) => `${((value / axisMax) * 100).toFixed(1)}%`;
  const tick = (value) => formatPercent(value, axisMax < 0.1 ? 1 : 0);

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
      <span class="swarm__ticks"><span>${tick(0)}</span><span>${tick(axisMax / 2)}</span><span>${tick(axisMax)}</span></span>
      <span class="swarm__axis-label swarm__axis-label--unit">Week</span>
      <span class="swarm__axis-label swarm__axis-label--unit">Season</span>
    </div>
    <ol class="swarm__rows">${list}</ol>
    <p class="coach__caption" data-key="swarm-caption">The coach replayed the rest of the season ${frontier.scenarios} times with the lines nudged the way they usually miss. Each dot is where one of those futures left the season; the bar is today’s number. Dots that pile up mean the model is sure; dots that spread mean it is guessing.</p>
  </div>`;
}

/**
 * Two sentences, each about one of the drawings above it. The first is the
 * calibration speaking: of every past game the model priced in this band, how
 * many the favourite actually won. The second is the swarm counted: in how
 * many of the futures the runner-up did as well as the call.
 */
function foot(state, board) {
  const lines = [];

  const band = bandFor(board.calibrationBands, state.subject.winProb);
  if (band && band.n >= 20) {
    lines.push(
      `Games the model has priced around ${Math.round(band.predicted * 100)}% went on to win ${Math.round(
        band.actual * 100,
      )}% of ${band.n}.`,
    );
  }

  const candidates = state.frontier?.candidates ?? [];
  const [call, next] = candidates;
  if (call && next && state.frontier.scenarios) {
    const total = state.frontier.scenarios;
    const agree = Math.round((next.robust ?? 0) * total);
    const name = escapeHtml(
      (next.options?.length ? next.options.map((option) => option.team) : next.teams).join(" + "),
    );
    lines.push(
      agree >= total - 1
        ? `${name} lands with the call in ${agree} of ${total} futures: nothing between them.`
        : agree === 0
          ? `No future had ${name} as good as the call.`
          : `${name} does as well as the call in ${agree} of ${total} futures.`,
    );
  }

  return lines.length ? `<p class="coach__note" data-key="note">${lines.join(" ")}</p>` : "";
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
