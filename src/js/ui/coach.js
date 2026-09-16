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
 *   2. The route. One chart: each remaining week's chance of surviving it,
 *      along the route your pick leaves (the rehearsal the coach plans around
 *      it, core/plan.js) and along the coach's own route, with the season
 *      chance each arrives at. The two lines say the whole trade without a
 *      sentence - a pick that is safer this week stands higher at this week's
 *      column, and where the coach was saving that team for a later week, the
 *      coach's line stands higher there, and the season figures settle it.
 *
 *   3. The facts. What past games priced like this actually did, in how many
 *      simulated seasons the selection was near the best, and either its
 *      impact against the coach's plan or the closest challenger to that plan.
 *
 * A week already played shows nothing: its numbers are on the field, the drive
 * line and the card three times over. Read-only.
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
      : head(state) + chain(state, board) + route(state, board) + facts(state, board),
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
 * The route: week-by-week win chance along two routes through the rest of
 * the season, and the season chance each arrives at.
 *
 * Your route is the one the lock would leave - your pick this week and the
 * coach's plan around it (week.rehearsalPath, core/plan.js) - and the coach's
 * is the untouched plan (week.pathRecommendation). Both end at the numbers
 * the drive line quotes: "if locked" and the season chance. A week where the
 * two routes name the same team draws one mark; where they part, two, and
 * the week the coach was saving your team for is ruled and named, because
 * that is the whole of why a safer pick this week can leave a lower season.
 *
 * A pick pending in any week has the coach planning around it, and that plan
 * is the route the field shows, so it is drawn as yours whichever week is
 * being looked at. With nothing pending, a locked week has one route - the
 * lock is on it - and the coach's call for the week stands beside it as a
 * lone mark; the coach's own preview has one route and nothing to compare it
 * with.
 *
 * Drawn as an SVG stretched to the box for the lines, with the marks and
 * every word placed over it by percentage, so the marks stay round and the
 * type stays type whatever shape the band is.
 */
function route(state, board) {
  const { week: viewed, teams, opening, selection } = state;
  const weeks = board.weeks.filter((week) => week.week >= board.currentWeek);
  const at = weeks.findIndex((week) => week.week === viewed.week);
  if (!weeks.length || at < 0) return "";

  const stopsOf = (pathOf) =>
    weeks.map((week) => {
      const options = (pathOf(week) ?? []).filter(Boolean);
      return {
        week: week.week,
        options,
        prob: options.length
          ? options.reduce((product, option) => product * option.winProb, 1)
          : null,
      };
    });
  const nameOf = (options) => options.map((option) => option.team).join(" + ");

  const coachStops = stopsOf((week) => week.pathRecommendation);
  // A pick pending anywhere on the board has the coach planning around it,
  // and that plan is the route the field shows (week.rehearsalPath): yours,
  // whichever week is being looked at.
  const rehearsed = weeks.some((week) => Array.isArray(week.rehearsalPath));

  // The series. `you` is the route on the field, `coach` the untouched plan
  // it is measured against; `lone` is the coach's call for a locked week,
  // which has no route of its own to draw.
  let you = null;
  let coach = null;
  let lone = null;
  if (rehearsed) {
    you = {
      stops: stopsOf((week) => week.rehearsalPath),
      season: Number.isFinite(board.rehearsalProbability)
        ? board.rehearsalProbability
        : estimateFor(state, board),
    };
    coach = { stops: coachStops, season: board.pathProbability };
  } else if (selection === "picked") {
    you = { stops: coachStops, season: estimateFor(state, board) };
    you.stops[at] = {
      ...you.stops[at],
      options: opening,
      prob: opening.reduce((product, option) => product * option.winProb, 1),
    };
    coach = { stops: coachStops, season: board.pathProbability };
  } else if (selection === "locked") {
    you = { stops: coachStops, season: board.pathProbability };
    const call = state.coachOpening ?? [];
    if (
      call.length &&
      !sameTeams(
        call.map((option) => option.team),
        teams,
      )
    ) {
      lone = {
        options: call,
        prob: call.reduce((product, option) => product * option.winProb, 1),
      };
    }
  } else {
    coach = { stops: coachStops, season: board.pathProbability };
  }

  const series = [you, coach].filter(Boolean);
  const probs = series
    .flatMap((entry) => entry.stops.map((stop) => stop.prob))
    .concat(lone ? [lone.prob] : [])
    .filter(Number.isFinite);
  if (!probs.length) return "";

  // The scale is the data's, in steps of five, with room over and under for a
  // mark and its figure; the rules every ten. A survivor pick lives between
  // sixty and ninety-five, and from nought every week would be a flat line
  // along the top.
  const lo = Math.max(0, Math.floor((Math.min(...probs) - 0.07) * 20) / 20);
  const hi = Math.min(1, Math.ceil((Math.max(...probs) + 0.07) * 20) / 20);
  const span = Math.max(hi - lo, 0.05);
  const n = weeks.length;
  const xAt = (index) => ((index + 0.5) / n) * 100;
  const yAt = (prob) => ((hi - prob) / span) * 100;
  const pct = (value) => `${value.toFixed(2)}%`;

  const rules = [];
  for (let level = Math.ceil(lo * 10) / 10; level < hi - 1e-9; level += 0.1) {
    if (level > lo + 1e-9) rules.push(Math.round(level * 10) / 10);
  }
  const grid = rules
    .map(
      (level) =>
        `<span class="route__rule" style="top:${pct(yAt(level))}"><span class="route__rule-label">${Math.round(level * 100)}%</span></span>`,
    )
    .join("");

  // One polyline per unbroken run of weeks with a team on the route.
  const lineOf = (entry, kind) => {
    const runs = [];
    let run = [];
    entry.stops.forEach((stop, index) => {
      if (stop.prob === null) {
        if (run.length) runs.push(run);
        run = [];
        return;
      }
      run.push(`${xAt(index).toFixed(2)},${yAt(stop.prob).toFixed(2)}`);
    });
    if (run.length) runs.push(run);
    return runs
      .filter((points) => points.length > 1)
      .map(
        (points) =>
          `<polyline class="route__line route__line--${kind}" points="${points.join(" ")}" />`,
      )
      .join("");
  };

  const dotsOf = (entry, kind) =>
    entry.stops
      .map((stop, index) => {
        if (stop.prob === null) return "";
        const title = `Wk ${stop.week} · ${nameOf(stop.options)} · ${formatPercent(stop.prob, 0)}`;
        return `<span class="route__dot route__dot--${kind}${index === at ? " route__dot--here" : ""}" style="left:${pct(xAt(index))};top:${pct(yAt(stop.prob))};--order:${index}" title="${escapeHtml(title)}"></span>`;
      })
      .join("");

  // This week's figures ride their marks. The higher mark's figure stands
  // over it, or under it when the mark is up against the top; the lower
  // mark's stands under its own, and drops a further line when the higher
  // one is already under a mark within reach of it, so the two figures never
  // sit on each other. Two routes on the same team this week are one mark
  // and one figure.
  const here = [];
  if (you && you.stops[at].prob !== null) here.push({ kind: "you", prob: you.stops[at].prob });
  if (coach && coach.stops[at].prob !== null) {
    here.push({ kind: "coach", prob: coach.stops[at].prob });
  }
  if (lone) here.push({ kind: "coach", prob: lone.prob });
  here.sort((a, b) => b.prob - a.prob);
  const distinct = here.filter(
    (mark, index) => index === 0 || Math.abs(here[index - 1].prob - mark.prob) > 0.0005,
  );
  const figures = distinct
    .map((mark, index) => {
      const y = yAt(mark.prob);
      let place = "";
      if (index === 0) {
        place = y < 18 ? " route__figure--below" : "";
      } else {
        const upper = yAt(distinct[0].prob);
        const upperBelow = upper < 18;
        place =
          upperBelow && y - upper < 22
            ? " route__figure--below route__figure--second"
            : " route__figure--below";
      }
      return `<span class="route__figure route__figure--${mark.kind}${place}" style="left:${pct(xAt(at))};top:${pct(y)}">${formatPercent(mark.prob, 0)}</span>`;
    })
    .join("");

  const loneMark = lone
    ? `<span class="route__dot route__dot--coach route__dot--here route__dot--lone" style="left:${pct(xAt(at))};top:${pct(yAt(lone.prob))}" title="${escapeHtml(`Coach: ${nameOf(lone.options)} · ${formatPercent(lone.prob, 0)}`)}"></span>`
    : "";

  // Where the coach's route spends the team being looked at: saved for a
  // later week, or already played in an earlier one.
  const savedAt = coach
    ? coach.stops.findIndex(
        (stop, index) => index !== at && stop.options.some((option) => teams.includes(option.team)),
      )
    : -1;
  const savedTeams =
    savedAt >= 0
      ? coach.stops[savedAt].options.filter((option) => teams.includes(option.team))
      : [];
  const saved =
    savedAt >= 0
      ? `<span class="route__saved${savedAt / n > 0.62 ? " route__saved--left" : ""}" style="left:${pct(xAt(savedAt))}"><span class="route__saved-label">Coach ${savedAt > at ? "saves" : "plays"} ${escapeHtml(nameOf(savedTeams))}</span></span>`
      : "";

  const axis = weeks
    .map(
      (week, index) =>
        `<span class="route__week${index === at ? " route__week--here" : ""}${index === savedAt ? " route__week--saved" : ""}" style="left:${pct(xAt(index))}">${index === 0 ? "Wk " : ""}${week.week}</span>`,
    )
    .join("");

  const pending = Boolean(rehearsed && board.previewPending);
  const key = (kind, name, figure, word) =>
    `<li class="route__key route__key--${kind}"><i class="route__swatch" aria-hidden="true"></i><span class="route__key-name">${name}</span><b class="route__key-figure">${figure}</b><span class="route__key-word">${word}</span></li>`;
  const legend = [
    you &&
      key(
        "you",
        selection === "locked" && !rehearsed ? "Locked" : "You",
        Number.isFinite(you.season) ? formatPercent(you.season, 1) : "—",
        "season",
      ),
    coach && key("coach", "Coach", formatPercent(coach.season, 1), "season"),
    lone &&
      key(
        "coach",
        `Coach: ${escapeHtml(nameOf(lone.options))}`,
        formatPercent(lone.prob, 0),
        "this week",
      ),
  ]
    .filter(Boolean)
    .join("");

  const summary = series
    .map(
      (entry) =>
        `${entry === you ? "your route" : "the coach's route"}: ${formatPercent(entry.stops[at].prob ?? 0, 0)} this week, ${formatPercent(entry.season, 1)} for the season`,
    )
    .join("; ");

  return `<section class="route${you && coach ? " route--compared" : ""}${pending ? " route--pending" : ""}" data-key="route" aria-label="${escapeHtml(`Win chance by week - ${summary}`)}">
    <div class="route__head">
      <span class="route__eyebrow">Win chance by week</span>
      <ul class="route__legend">${legend}</ul>
    </div>
    <div class="route__plot" aria-hidden="true">
      <span class="route__band" style="left:${pct((at / n) * 100)};width:${pct(100 / n)}"></span>
      ${grid}
      <svg class="route__lines" viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
        ${coach ? lineOf(coach, "coach") : ""}${you ? lineOf(you, "you") : ""}
      </svg>
      ${saved}
      ${coach ? dotsOf(coach, "coach") : ""}${you ? dotsOf(you, "you") : ""}${loneMark}
      ${figures}
    </div>
    <div class="route__axis" aria-hidden="true">${axis}</div>
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
