/**
 * The model's working: how the team on the card was priced, and where the
 * season lands with it, in the turf between the field and the card.
 *
 * Everything here is about the selection - the team in the slot the card has
 * active, and the opening it makes with the other slot in a two-pick week -
 * and everything is a key over a figure over a word, the way the drive line
 * is, rather than a sentence. Three parts:
 *
 *   1. The chain. Four stops from ratings to a tier: the line the two power
 *      ratings project, the market's line and where it opened, the win
 *      probability with the price behind it, and the tier that falls in. Every
 *      number is one the model used (option.pricing, out of core/plan.js).
 *
 *   2. The comparison. A sentence first says the trade: whether this pick is
 *      safer this week, and whether it raises or lowers season survival versus
 *      the coach plan. Two rows put those four numbers side by side. Under
 *      them, the optimiser's thirty-two simulated rest-of-seasons
 *      (core/scenarios.js) land as dots on one clearly labelled axis. While a
 *      two-pick opening is being weighed, its rehearsal scores the exact pair.
 *
 *   3. The facts. What past games priced like this actually did, in how many
 *      simulated seasons the selection was near the best, and either its
 *      impact against the coach's plan or the closest challenger to that plan.
 *
 * A week already played shows nothing: its numbers are on the field, the drive
 * line and the card three times over. Read-only.
 */

import { formatPercent, formatSpread, formatMatchup, escapeHtml } from "../core/format.js";
import { confidenceTier, TIER_LABEL, DEFAULT_TIERS } from "../core/probability.js";
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

  // The frame survives every render. Keep its identity stable for the shared
  // data-settle motion, while the signature says when the team or one of its
  // live estimates has changed.
  panel.dataset.motionKey = "coach-read";
  panel.dataset.motionSignature =
    state.kind === "working"
      ? [
          state.subject.team,
          state.teams.join("+"),
          state.subject.winProb,
          state.candidate?.season ?? "",
          board.previewPathProbability ?? "",
          board.previewPending ? "pending" : "settled",
        ].join("|")
      : "empty";
  panel.setAttribute("aria-live", "polite");
  panel.classList.toggle("coach--picked", state.selection === "picked");
  panel.classList.toggle("coach--locked", state.selection === "locked");
  panel.classList.toggle(
    "coach--pending",
    state.selection === "picked" && Boolean(board.previewPending),
  );
  panel.classList.toggle("coach--empty", state.kind === "none");
  reconcile(
    panel,
    state.kind === "none"
      ? ""
      : head(state) + chain(state, board) + strip(state, board) + facts(state, board),
  );
}

/**
 * What there is to show for the week: the team to price, the opening it is
 * part of, and that opening's simulations when the coach ran them.
 *
 * The frontier belongs to one week - the first with a slot still open, which
 * is not always the week on the clock - and holds only the openings the coach
 * judged. It is null while a plan is being worked out and for a board planned
 * around locks that have since moved.
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

  // The opening: every slot's team, the card's own where it has one and the
  // subject where the active slot is empty.
  const options = week.picks.map((slot, index) =>
    index === Math.min(activeSlot, week.picks.length - 1) ? subject : slot.onPath,
  );
  const opening = options.filter(Boolean);
  const teams = opening.map((option) => option.team);

  const frontier = board.frontier;
  const judged =
    frontier && frontier.week === week.week && frontier.candidates?.length ? frontier : null;
  const candidate = judged?.candidates.find((entry) => sameTeams(entry.teams, teams)) ?? null;
  // The preview frontier in a two-pick pool is solved around the user's held
  // team. That is exactly what supplies this pair's dots, but it is not the
  // untouched coach plan the comparison promises. The week's recommendation
  // is that baseline and stays put while an unlocked pick is being weighed.
  const coachOpening =
    (week.recommended ?? []).length > 0
      ? week.recommended
      : (week.pathRecommendation ?? []).filter(Boolean);

  const selection = pick?.team ? (pick.status.locked ? "locked" : "picked") : "coach";

  return {
    kind: "working",
    week,
    subject,
    opening,
    teams,
    frontier: judged,
    candidate,
    coachOpening,
    selection,
  };
}

function sameTeams(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  const sorted = (list) => [...list].sort().join("|");
  return sorted(a) === sorted(b);
}

function head(state) {
  const { subject, week, selection } = state;
  const focus =
    selection === "picked" ? "Your pick" : selection === "locked" ? "Locked pick" : "Coach preview";
  return `<div class="coach__head" data-key="head">
    <span class="coach__heading">
      <span class="coach__focus"><span class="coach__pulse" aria-hidden="true"></span>${focus}</span>
      <span class="u-eyebrow coach__what">Live model read · Wk ${String(week.week).padStart(2, "0")}</span>
    </span>
    <span class="coach__game">${escapeHtml(subject.team)} ${escapeHtml(formatMatchup(subject.site, subject.opponent))}</span>
  </div>`;
}

/**
 * The four stops. A projected week has no market line to show, so that stop
 * says how far the projection is expected to miss instead - the widening the
 * simulations are drawn with (core/probability.js horizonVariance).
 */
function chain(state, board) {
  const { subject } = state;
  const p = subject.pricing;
  const tiers = board.rules?.tiers ?? DEFAULT_TIERS;
  const tier = subject.tier;

  const rating = (value) => (Number.isFinite(value) ? value.toFixed(1) : "—");
  const ratingsSub = `power ${rating(p.team.rating)} v ${rating(p.opponent.rating)}`;
  const homeNote =
    p.homeField > 0
      ? `, plus ${Math.abs(p.homeField)} for home field`
      : p.homeField < 0
        ? `, less ${Math.abs(p.homeField)} for playing away`
        : ", on a neutral field";

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
    ? `The line the market is posting${market.books ? `, across ${market.books} books` : ""}${
        market.opened !== null ? `; it opened at ${formatSpread(market.opened)}` : ""
      }`
    : "No line is posted yet. A projection this many weeks out usually misses the line the market eventually posts by about this much";

  const price = subject.winProb;
  const blended = market && market.weight > 0 && market.moneylineProb !== null;
  // The sigma keeps its case: the sub-line is set in small caps and Σ is a
  // different letter.
  const priceSub = blended
    ? `ML ${decimalOdds(market.moneyline)}`
    : `<span class="chain__sym">σ</span> ${p.sigma.toFixed(1)}`;
  const priceTitle = blended
    ? `The spread alone says ${formatPercent(p.fromSpread, 1)}; the moneyline (${decimalOdds(market.moneyline)} decimal) says ${formatPercent(market.moneylineProb, 1)}; the blend weights the moneyline at ${Math.round(market.weight * 100)}%`
    : `A margin scattered ${p.sigma.toFixed(1)} points either side of the line${
        p.horizonSd ? `, widened by ±${p.horizonSd.toFixed(1)} for the weeks ahead` : ""
      }`;

  return `<ol class="chain" data-key="chain" aria-label="How ${escapeHtml(subject.team)} was priced">
    <li class="chain__stop" title="The line the two teams' power ratings project on their own - the fitted ratings where the season has data, the preseason ones where it does not${homeNote}">
      <span class="chain__key">Ratings line</span>
      <span class="chain__value">${formatSpread(p.projected)}</span>
      <span class="chain__sub">${escapeHtml(ratingsSub)}</span>
    </li>
    <li class="chain__stop" title="${escapeHtml(marketTitle)}">
      <span class="chain__key">Market line</span>
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

/** An American moneyline as decimal odds: -295 is 1.34, +180 is 2.80. */
function decimalOdds(moneyline) {
  if (!Number.isFinite(moneyline) || moneyline === 0) return "—";
  const decimal = moneyline > 0 ? 1 + moneyline / 100 : 1 + 100 / Math.abs(moneyline);
  return decimal.toFixed(2);
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
 * The selected opening's current season number.
 *
 * A user pick owns the lock preview: that is the number that changes as they
 * try another team, and the one the board promises the lock will produce. The
 * coach's untouched call owns the frontier mean, since its dots and its bar
 * then describe the same simulated set.
 */
function estimateFor(state, board) {
  if (state.selection === "picked" && Number.isFinite(board.previewPathProbability)) {
    return board.previewPathProbability;
  }
  return state.candidate?.season ?? board.pathProbability;
}

/**
 * The selected opening's simulated seasons, as a constellation of dots, with
 * today's estimate and the coach route drawn through them.
 *
 * The axis is the dots' own, not nought's: thirty-two results between 3.4% and
 * 3.6% drawn from zero are a smear in the last inch of the strip; drawn from
 * 3.3% to 3.7% they are a shape across the whole of it. The ticks say what
 * the ends are, so a zoom reads as a zoom. Without dots the axis is a point
 * either side of the estimate, so the bar stands in the middle.
 */
function strip(state, board) {
  const { frontier, candidate, opening, teams } = state;
  if (!frontier) return "";

  const dots = Array.isArray(candidate?.survivals) ? candidate.survivals : [];
  const estimate = estimateFor(state, board);
  const weekProb =
    candidate?.weekWinProb ?? opening.reduce((product, option) => product * option.winProb, 1);
  const baseline = Number.isFinite(board.pathProbability) ? board.pathProbability : null;
  const liveEstimate = Number.isFinite(estimate)
    ? estimate
    : Number.isFinite(candidate?.scenarioMean)
      ? candidate.scenarioMean
      : 0;

  const values = [...dots, liveEstimate, baseline].filter(Number.isFinite);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const pad = Math.max((high - low) * 0.12, 0.001);
  const axisMin = Math.max(0, Math.floor((low - pad) * 1000) / 1000);
  const axisMax = Math.ceil((high + pad) * 1000) / 1000;
  const span = Math.max(axisMax - axisMin, 0.001);
  const at = (value) =>
    `${Math.max(0, Math.min(100, ((value - axisMin) / span) * 100)).toFixed(1)}%`;
  const tick = (value) => formatPercent(value, span < 0.01 ? 2 : 1);

  // A fixed lane pattern gives the futures a compact constellation rather
  // than piling thirty-two circles onto one rule. It is deterministic, so a
  // team changing position reads as model movement rather than visual noise.
  const lanes = [50, 28, 72, 16, 84, 39, 61, 22, 78, 45, 66, 34];
  const marks = dots
    .map(
      (value, index) =>
        `<span class="swarm__dot" style="left:${at(value)};top:${lanes[index % lanes.length]}%;--dot-order:${index}"></span>`,
    )
    .join("");
  const awaitingDots = state.selection === "picked" && board.previewPending;
  const missing = dots.length
    ? ""
    : awaitingDots
      ? `<span class="swarm__none" title="The selected opening is being simulated">simulating</span>`
      : `<span class="swarm__none" title="Scenario analysis is unavailable for this exact opening">estimate only</span>`;
  const name = escapeHtml(teams.join(" + "));
  const weekTier = confidenceTier(weekProb, board.rules?.tiers ?? DEFAULT_TIERS);
  const call = frontier.candidates?.[0] ?? null;
  const coachOpening = state.coachOpening?.length ? state.coachOpening : (call?.options ?? []);
  const coachWeekProb = coachOpening.length
    ? coachOpening.reduce((product, option) => product * option.winProb, 1)
    : (call?.weekWinProb ?? null);
  const delta = baseline === null ? null : liveEstimate - baseline;
  const deltaPoints = delta === null ? null : delta * 100;
  const personal = state.selection === "picked" || state.selection === "locked";
  const callName = coachOpening.length
    ? coachOpening.map((option) => option.team).join(" + ")
    : call
      ? call.teams.join(" + ")
      : "the coach pick";
  const weekPoints = coachWeekProb === null ? null : (weekProb - coachWeekProb) * 100;
  const weekComparison =
    weekPoints === null || Math.abs(weekPoints) < 0.05
      ? `about as safe this week as ${callName}`
      : weekPoints > 0
        ? `${Math.abs(weekPoints).toFixed(0)} points safer this week than ${callName}`
        : `${Math.abs(weekPoints).toFixed(0)} points riskier this week than ${callName}`;
  const seasonComparison =
    deltaPoints === null || Math.abs(deltaPoints) < 0.04
      ? "leaves your season chance essentially unchanged"
      : deltaPoints > 0
        ? `raises your chance of surviving the season from ${formatPercent(baseline, 1)} to ${formatPercent(liveEstimate, 1)}`
        : `lowers your chance of surviving the season from ${formatPercent(baseline, 1)} to ${formatPercent(liveEstimate, 1)}`;
  const tradeoff =
    weekPoints !== null &&
    deltaPoints !== null &&
    Math.abs(weekPoints) >= 0.05 &&
    Math.abs(deltaPoints) >= 0.04 &&
    Math.sign(weekPoints) !== Math.sign(deltaPoints);
  const explanation = personal
    ? `This pick is ${weekComparison}, ${tradeoff ? "but" : "and"} ${seasonComparison}.`
    : `The model’s pick has a ${formatPercent(weekProb, 0)} chance to survive this week and a ${formatPercent(liveEstimate, 1)} chance to survive the season.`;
  const focus =
    state.selection === "picked"
      ? board.previewPending
        ? "Recalculating your pick"
        : "Following your pick"
      : state.selection === "locked"
        ? "Locked selection"
        : candidate?.chosen
          ? "Coach’s call"
          : "Coach preview";
  const nowDelta =
    weekPoints === null
      ? "—"
      : Math.abs(weekPoints) < 0.05
        ? "Same"
        : `${weekPoints > 0 ? "+" : "−"}${Math.abs(weekPoints).toFixed(0)} pts`;
  const seasonDelta =
    deltaPoints === null
      ? "—"
      : Math.abs(deltaPoints) < 0.04
        ? "Same"
        : `${deltaPoints > 0 ? "+" : "−"}${Math.abs(deltaPoints).toFixed(1)} pts`;
  const comparison = personal
    ? `<div class="swarm__metrics" aria-label="Your pick compared with the coach plan">
        <span class="swarm__compare-head"></span>
        <span class="swarm__compare-head">Your pick</span>
        <span class="swarm__compare-head" title="Coach pick: ${escapeHtml(callName)}">Coach · ${escapeHtml(callName)}</span>
        <span class="swarm__compare-head">Difference</span>
        <span class="swarm__compare-label">This week</span>
        <strong class="swarm__compare-value swarm__week${weekTier ? ` confidence--${weekTier}` : ""}">${formatPercent(weekProb, 0)}</strong>
        <strong class="swarm__compare-value">${coachWeekProb === null ? "—" : formatPercent(coachWeekProb, 0)}</strong>
        <em class="swarm__impact swarm__impact--${weekPoints > 0.05 ? "gain" : weekPoints < -0.05 ? "cost" : "even"}">${nowDelta}</em>
        <span class="swarm__compare-label">Whole season</span>
        <strong class="swarm__compare-value swarm__value">${formatPercent(liveEstimate, 1)}</strong>
        <strong class="swarm__compare-value">${baseline === null ? "—" : formatPercent(baseline, 1)}</strong>
        <em class="swarm__impact swarm__impact--${deltaPoints > 0.04 ? "gain" : deltaPoints < -0.04 ? "cost" : "even"}">${seasonDelta}</em>
      </div>`
    : `<div class="swarm__metrics swarm__metrics--model" aria-label="Model pick probabilities">
        <div class="swarm__metric"><span class="swarm__metric-title">Survive this week</span><strong class="swarm__week${weekTier ? ` confidence--${weekTier}` : ""}">${formatPercent(weekProb, 0)}</strong></div>
        <div class="swarm__metric"><span class="swarm__metric-title">Survive the season</span><strong class="swarm__value">${formatPercent(liveEstimate, 1)}</strong></div>
      </div>`;
  const aria = `${teams.join(" and ")}: ${formatPercent(weekProb, 0)} chance this week and ${
    Number.isFinite(estimate) ? formatPercent(estimate, 1) : "no estimate"
  } season survival`;

  return `<section class="swarm${state.selection === "picked" ? " swarm--picked" : ""}" data-key="swarm" aria-label="${escapeHtml(aria)}">
    <div class="swarm__head">
      <div class="swarm__identity">
        <span class="swarm__eyebrow">What this pick means</span>
        <strong class="swarm__name${teams.length > 1 ? " swarm__name--pair" : ""}">${name}</strong>
        <span class="swarm__status">${focus}</span>
        <span class="swarm__verdict">${escapeHtml(explanation)}</span>
      </div>
    </div>
    ${comparison}
    <div class="swarm__plot" aria-hidden="true">
      <div class="swarm__axis">
        <span class="swarm__axis-label">${frontier.scenarios} simulated seasons</span>
        <span class="swarm__range">Each dot is one season · farther right is better</span>
      </div>
      <span class="swarm__strip">
        ${marks}${missing}
        ${baseline === null ? "" : `<span class="swarm__benchmark" style="left:${at(baseline)}"><span>Coach plan ${formatPercent(baseline, 1)}</span></span>`}
        <span class="swarm__mark" style="left:${at(liveEstimate)}"><span>Your pick ${formatPercent(liveEstimate, 1)}</span></span>
      </span>
      <span class="swarm__ticks"><span>Lower chance · ${tick(axisMin)}</span><span>Higher chance · ${tick(axisMax)}</span></span>
    </div>
  </section>`;
}

/**
 * Three plain-language checks under the comparison.
 *
 *   SIMILAR PAST PICKS / 90% WON / 173 GAMES AROUND 88% - whether probabilities
 *   like this one have been honest in completed games.
 *
 *   IN THE SIMULATIONS / 28 OF 32 BACKED THIS / AS A NEAR-BEST CHOICE - how
 *   often the selected opening stayed with the best available route.
 *
 *   COACH WOULD PICK - for a user pick, the opening it moved away from. On the
 *   coach's own call, the closest challenger instead.
 */
function facts(state, board) {
  const items = [];

  const band = bandFor(board.calibrationBands, state.subject.winProb);
  if (band && band.n >= 20) {
    items.push(
      fact(
        "Similar past picks",
        `${Math.round(band.actual * 100)}% won`,
        `${band.n} games around ${Math.round(band.predicted * 100)}%`,
        "Of every past game the model priced in this band, the share the favourite actually won",
      ),
    );
  }

  const { frontier, candidate } = state;
  const total = frontier?.scenarios ?? 0;
  if (candidate && total) {
    const backed = Math.round((candidate.robust ?? 0) * total);
    items.push(
      fact(
        "In the simulations",
        `${backed} of ${total} backed this`,
        "as a near-best choice",
        "Simulated seasons in which this opening was the best available, or within a whisker of it",
        true,
      ),
    );
  } else if (frontier && state.selection === "picked") {
    items.push(
      fact(
        "Exact-pick analysis",
        board.previewPending ? "Recalculating" : "Unavailable",
        board.previewPending ? "running 32 seasons" : "live estimate only",
        board.previewPending
          ? "The exact opening is being played through the same simulated seasons as the coach's call"
          : "This exact opening has a live season estimate, but its scenario set is unavailable",
        true,
      ),
    );
  }

  const [call, next] = frontier?.candidates ?? [];
  const nameOf = (entry) =>
    (entry.options?.length ? entry.options.map((option) => option.team) : entry.teams).join(" + ");
  if (call) {
    if (state.selection === "picked" || state.selection === "locked") {
      const estimate = estimateFor(state, board);
      const baseline = board.pathProbability;
      const coachOptions = state.coachOpening?.length ? state.coachOpening : (call.options ?? []);
      const coachName = coachOptions.length
        ? coachOptions.map((option) => option.team).join(" + ")
        : nameOf(call);
      const coachWeekProb = coachOptions.length
        ? coachOptions.reduce((product, option) => product * option.winProb, 1)
        : call.weekWinProb;
      if (Number.isFinite(estimate) && Number.isFinite(baseline)) {
        items.push(
          fact(
            "Coach would pick",
            escapeHtml(coachName),
            `${formatPercent(coachWeekProb, 0)} this week · ${formatPercent(baseline, 1)} season`,
            `${coachName} is the coach's baseline at ${formatPercent(baseline, 1)} season survival; this pick's live estimate is ${formatPercent(estimate, 1)}`,
            true,
          ),
        );
      }
    } else if (candidate?.chosen && next && total) {
      items.push(
        fact(
          "Next-best option",
          escapeHtml(nameOf(next)),
          `${formatPercent(next.season, 1)} season`,
          "The coach's next best opening and the season survival it leads to",
          true,
        ),
      );
    } else if (!candidate?.chosen) {
      items.push(
        fact(
          "Coach would pick",
          escapeHtml(nameOf(call)),
          `${formatPercent(call.season, 1)} season`,
          "The opening the coach calls for this week, and the season survival it leads to",
          true,
        ),
      );
    }
  }

  return items.length ? `<div class="facts" data-key="facts">${items.join("")}</div>` : "";
}

function fact(key, value, sub, title, isName = false) {
  return `<div class="facts__item" title="${escapeHtml(title)}">
    <span class="chain__key">${escapeHtml(key)}</span>
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
