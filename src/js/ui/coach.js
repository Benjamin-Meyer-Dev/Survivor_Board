/**
 * The model's working: how the team on the card was priced, and where the
 * season lands with it, in the turf between the field and the card.
 *
 * Everything here is about the selection - the team in the slot the card has
 * active, and the opening it makes with the other slot in a two-pick week -
 * and everything is a key over a figure over a word, the way the drive line
 * is, rather than a sentence. Two parts:
 *
 *   1. The chain. Four stops from the model to a tier: the model's own line
 *      (the spread the two power ratings and the home field come to, before
 *      the market is looked at), the market's line and where it opened, the
 *      win probability with the price behind it, and the tier that falls in.
 *      Every number is one the model used (option.pricing, core/plan.js).
 *
 *   2. The route. One chart: each remaining week's chance of surviving it,
 *      along the route the board is on - your picks and the coach's plan around
 *      them (the rehearsal, core/plan.js) - drawn solid, always. Where the
 *      coach's untouched plan would spend a week differently, that difference
 *      is pencilled in over those weeks alone, and the season figures settle
 *      the trade: a pick that is safer this week stands higher at this week's
 *      column, and where the coach was saving that team for a later week, the
 *      dotted branch stands higher there.
 *
 * There was a third part under these - three cards of supporting facts, the
 * calibration behind the price, how many simulated seasons backed the opening,
 * and what the coach would take instead. They are gone. Every one of them was
 * a footnote to something the two parts above already say, and a footnote set
 * in the same weight as the thing it supports is not read as a footnote: the
 * band is the price and the trade, and the room the cards took is the chart's.
 *
 * A week already played keeps the band and all four stops: the model's line,
 * the line the market went to the game with, what that priced the pick at, and
 * the tier. The model's line there is a live number - the ratings behind it are
 * refitted every week - so it is what the model makes of that game today rather
 * than what it said at kickoff, and its tooltip says so. Read side by side with
 * the closing line and the result underneath, that is the one comparison a
 * finished week is good for. Read-only.
 */

import { formatPercent, formatSpread, formatMatchup, escapeHtml } from "../core/format.js";
import { TIER_LABEL, DEFAULT_TIERS } from "../core/probability.js";
import { frame, reconcile } from "./patch.js";

/**
 * The tier in one word, for the chain's last stop.
 *
 * The board's own names for two of the five are two words - CLOSE CALL, UPSET
 * ALERT - and at ninety-odd pixels they are wider than the third of a phone
 * the tier shares with the win probability beside it. The card under the chart
 * calls the tier by its full name at full size; here it is the fourth figure
 * in a row of four, and one word is what there is room for.
 */
const TIER_WORD = Object.freeze({
  safe: "Lock",
  solid: "Solid",
  thin: "Shaky",
  close: "Close",
  danger: "Upset",
});

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
  // data-settle motion, while the signature says when the read it is showing
  // has changed.
  panel.dataset.motionKey = "coach-read";
  panel.dataset.motionSignature =
    state.kind === "working"
      ? readSignature(state)
      : state.kind === "past"
        ? `past|${state.week.week}|${state.subject?.team ?? ""}`
        : "empty";
  panel.setAttribute("aria-live", "polite");
  panel.classList.toggle("coach--picked", state.selection === "picked");
  panel.classList.toggle("coach--locked", state.selection === "locked");
  panel.classList.toggle(
    "coach--pending",
    state.selection === "picked" && Boolean(board.previewPending),
  );
  panel.classList.toggle("coach--empty", state.kind === "none");
  // The head and the chain are the week's page: they turn with the card, so
  // they travel with it under a finger (SLIDING in app.js names this box). The
  // chart is the season and stays where it is.
  //
  // A settled week keeps the page, on its closing numbers rather than a live
  // read: the week the card is on is the week being read about, and a box that
  // empties itself the moment a week is over reads as the board losing the
  // thread rather than as the week being finished. It goes only where there is
  // nothing to quote - a week nobody priced.
  const page =
    state.kind === "working" || (state.kind === "past" && closingPricing(state))
      ? `<div class="coach__page" data-key="page">${head(state)}${chain(state, board)}</div>`
      : "";
  const routeMarkup = state.kind === "none" ? "" : route(state, board);
  // Keep the chart's outer frame independent of the markup inside it. The
  // selected week changes its band, figures and axis, but usually not the SVG
  // route underneath; replacing the whole section for those small changes
  // made the line disappear and reappear for a frame at the end of a swipe.
  const routeShell = routeMarkup ? `<section class="route" data-key="route"></section>` : "";
  reconcile(panel, state.kind === "none" ? "" : page + routeShell);
  if (routeMarkup) renderRoute(panel.querySelector(':scope > [data-key="route"]'), routeMarkup);
  // The live board only. A week being staged for a swipe is rendered into a
  // detached box (stageWeek in app.js), and a copy that is about to be thrown
  // away has nothing to answer a touch about.
  if (root.isConnected) watchChart(panel);
}

/**
 * Update the season chart without remounting the route line.
 *
 * The outer route and plot are stable frames. Their direct children are keyed,
 * so the selected week's band, figures and axis can change independently while
 * an unchanged SVG is retained exactly as it stands on the compositor. A real
 * plan change still changes the SVG markup and reconcile replaces it normally.
 */
function renderRoute(current, markup) {
  if (!current) return;
  const template = document.createElement("template");
  template.innerHTML = markup;
  const next = template.content.firstElementChild;
  if (!next) return;
  const previousWeek = current.dataset.viewWeek;

  current.classList.toggle("route--compared", next.classList.contains("route--compared"));
  current.classList.toggle("route--pending", next.classList.contains("route--pending"));
  for (const attribute of [
    "data-motion-key",
    "data-motion-signature",
    "data-view-week",
    "aria-label",
  ]) {
    const value = next.getAttribute(attribute);
    if (value === null) current.removeAttribute(attribute);
    else current.setAttribute(attribute, value);
  }

  const head = next.querySelector(':scope > [data-key="head"]');
  const plot = next.querySelector(':scope > [data-key="plot"]');
  const axis = next.querySelector(':scope > [data-key="axis"]');
  const lines = plot?.querySelector(':scope > [data-key="lines"]');
  if (!head || !plot || !axis || !lines) return;
  const nextLines = [...lines.children];
  // Reconcile sees a constant SVG shell. The polylines are updated in place
  // below, including when a viewed pick genuinely changes the route, so the
  // browser never has to drop and recreate the drawing surface.
  lines.replaceChildren();

  reconcile(
    current,
    `${head.outerHTML}<div class="route__plot" data-key="plot" aria-hidden="true"></div>${axis.outerHTML}`,
  );
  const currentPlot = current.querySelector(':scope > [data-key="plot"]');
  reconcile(currentPlot, plot.innerHTML);
  patchRouteLines(currentPlot?.querySelector(':scope > [data-key="lines"]'), nextLines);

  // A callout quotes one column. If the band moved to another one, close the
  // old quote even though its stable node was deliberately retained.
  if (previousWeek && previousWeek !== current.dataset.viewWeek) {
    const callout = current.querySelector('.route__callout[data-key="callout"]');
    if (callout) {
      callout.hidden = true;
      callout.replaceChildren();
    }
  }
}

/** Keep each SVG route line mounted and change only the attributes it draws. */
function patchRouteLines(current, nextLines) {
  if (!current) return;
  const existing = new Map([...current.children].map((line) => [line.dataset.key, line]));
  const wanted = [];

  for (const next of nextLines) {
    const held = existing.get(next.dataset.key) ?? next.cloneNode(true);
    existing.delete(next.dataset.key);

    const attributes = new Set([...next.attributes].map((attribute) => attribute.name));
    for (const attribute of [...held.attributes]) {
      if (!attributes.has(attribute.name)) held.removeAttribute(attribute.name);
    }
    for (const attribute of [...next.attributes]) {
      held.setAttribute(attribute.name, attribute.value);
    }
    wanted.push(held);
  }

  const keep = new Set(wanted);
  wanted.forEach((line, index) => {
    const at = current.children[index] ?? null;
    if (at !== line) current.insertBefore(line, at);
  });
  for (const line of [...current.children]) {
    if (!keep.has(line)) line.remove();
  }
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
  // A week that has been played has no live read left to make - the ratings
  // behind one have moved on since. It keeps the band on its closing numbers
  // instead, and the chart under it whichever week is being looked at: the
  // season did not stop having a shape because the week in the frame is behind
  // you.
  const settled = week.picks.every((pick) => pick.status.result) || week.week < board.currentWeek;
  if (settled) {
    // The pick the week went with, for the closing line over the chart: the
    // slot the card has active where it held one, and failing that whatever the
    // week has that was priced - a week with one slot filled says what that
    // slot closed at rather than nothing at all.
    //
    // There is no third fallback, because there is nothing to fall back to. The
    // coach's board for a week is the teams it could still call, and once every
    // game in the week has been played none of them is callable, so
    // `week.coachRanked` is empty (core/plan.js). A week nobody picked was
    // never priced by anybody, and the band goes rather than invent a read for
    // it.
    const held = week.picks[Math.min(activeSlot, week.picks.length - 1)];
    const subject =
      (held?.onPath?.pricing ? held.onPath : null) ??
      week.picks.find((pick) => pick.onPath?.pricing)?.onPath ??
      null;
    return {
      kind: "past",
      week,
      subject,
      teams: week.picks.map((pick) => pick.team).filter(Boolean),
      opening: [],
      coachOpening: [],
      // What the band is quoting, so the word over it is the truth about the
      // team under it. Read off the subject rather than off the active slot,
      // which in a two-pick week can be the empty one beside a slot that was
      // filled and locked.
      selection: subject ? "locked" : "coach",
    };
  }

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

/**
 * What the head and the chain are showing, as one string.
 *
 * Every figure the page prints, and nothing else. The settle is for a read
 * that changed, and a number this page does not show is not one: the "if
 * locked" rehearsal and the coach's own season figure used to be in here, and
 * both of those land a beat after a week turns - so the model read replayed
 * its entrance over four figures that had not moved, which is what flickered
 * at the end of every swipe. The chart below keeps its own key for the same
 * reason: it settles when the plan it draws changes, not when the band over it
 * moves.
 *
 * The sub-lines are covered by the terms they are made of rather than named
 * separately - the ratings gap by the two ratings, the books and the opening
 * line by the market, the moneyline sub-line by its price and weight.
 */
function readSignature(state) {
  const { subject, week, selection } = state;
  const p = subject.pricing;
  const market = p.market;
  return [
    selection,
    week.week,
    subject.team,
    subject.site,
    subject.opponent,
    p.projected,
    p.team.rating,
    p.opponent.rating,
    p.homeField,
    market
      ? [market.spread, market.opened, market.books, market.moneyline, market.weight].join("/")
      : `±${p.horizonSd}`,
    p.sigma,
    subject.winProb,
    subject.tier,
  ].join("|");
}

/**
 * The closing numbers for a settled week: the pricing of the pick that was on
 * the path, and only where the market posted a line for it. A week the feed
 * never priced carries a projection and nothing else, and a projection is not a
 * closing line - so the page goes rather than quote one as though it were.
 */
function closingPricing(state) {
  const pricing = state.subject?.pricing ?? null;
  return pricing?.market ? pricing : null;
}

function head(state) {
  const { subject, week, selection } = state;
  const focus =
    selection === "picked" ? "Your pick" : selection === "locked" ? "Locked pick" : "Coach preview";
  // A settled week is not being read live. Its numbers are the ones the game
  // was played on, so the eyebrow says so rather than claiming a model read
  // that would move under the reader every time the ratings are refitted.
  const what = state.kind === "past" ? "Closing read" : "Live model read";
  return `<div class="coach__head" data-key="head">
    <span class="coach__heading">
      <span class="coach__focus"><span class="coach__pulse" aria-hidden="true"></span>${focus}</span>
      <span class="u-eyebrow coach__what">${what} · Wk ${String(week.week).padStart(2, "0")}</span>
    </span>
    <span class="coach__game">${escapeHtml(subject.team)} ${escapeHtml(formatMatchup(subject.site, subject.opponent))}</span>
  </div>`;
}

/**
 * The four stops. A projected week has no market line to show, so that stop
 * says how far the projection is expected to miss instead - the widening the
 * simulations are drawn with (core/probability.js horizonVariance).
 *
 * A settled week takes the same four, and only the words around them change:
 * the market's stop is the line the game was played on rather than the one it
 * is posting, and the model's stop carries the caveat that its ratings have
 * been refitted every week since.
 */
function chain(state, board) {
  const { subject } = state;
  const p = subject.pricing;
  const closed = state.kind === "past";
  const tiers = board.rules?.tiers ?? DEFAULT_TIERS;
  const tier = subject.tier;

  const rating = (value) => (Number.isFinite(value) ? value.toFixed(1) : "—");
  // The two terms the line is the sum of, rather than the two ratings it is
  // the difference of: "Ratings +3.4 · Home +2.0" adds up to the -5.4 over it,
  // where "86.7 v 78.1" left the reader to do the subtraction and say which
  // team each number belonged to. The gap is the pick's own - negative where
  // the ratings have it behind - and the home term is its own span, so a
  // narrow box lets that go rather than cutting the gap short to keep it.
  //
  // Named rather than jargoned. It read "3.4 power gap", which is this board's
  // own word for the difference between two power ratings and nobody else's:
  // the number is the same, and now it says where it comes from and carries
  // the sign the home term beside it carries, so the two read as the two
  // things being added up.
  const signed = (value) => `${value < 0 ? "−" : "+"}${Math.abs(value).toFixed(1)}`;
  const gap =
    Number.isFinite(p.team.rating) && Number.isFinite(p.opponent.rating)
      ? p.team.rating - p.opponent.rating
      : null;
  const gapTerm =
    gap === null
      ? `ratings ${rating(p.team.rating)} v ${rating(p.opponent.rating)}`
      : `Ratings ${signed(gap)}`;
  const homeTerm =
    p.homeField > 0
      ? `Home ${signed(p.homeField)}`
      : p.homeField < 0
        ? `Away ${signed(p.homeField)}`
        : "";
  const ratingsSub = gapTerm + (homeTerm ? `<span class="chain__term"> · ${homeTerm}</span>` : "");
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
    ? `The line the market ${closed ? "went to the game with" : "is posting"}${
        market.books ? `, across ${market.books} books` : ""
      }${market.opened !== null ? `; it opened at ${formatSpread(market.opened)}` : ""}`
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

  // The model's line stands on a played week too. It is a live number there -
  // the ratings behind it are refitted every week, so what it says is what the
  // model makes of that game now rather than what it made of it then - and the
  // tooltip says so, because the reader comparing it with the closing line
  // beside it is doing the one thing the number is good for: seeing where the
  // model and the market disagreed, with the result underneath to settle it.
  const rated = `${subject.team} is rated ${rating(p.team.rating)} and ${subject.opponent} ${rating(p.opponent.rating)}${homeNote}`;
  const modelTitle = closed
    ? `The model's own line for that game, as it stands now: the ratings behind it have been refitted every week since, so this is what the model makes of it today rather than what it said at kickoff. ${rated}`
    : `The model's own line: what the two teams' power ratings come to on their own, before the market is looked at. ${rated} - the fitted ratings where the season has data, the preseason ones where it does not`;

  return `<ol class="chain" data-key="chain" aria-label="How ${escapeHtml(subject.team)} ${closed ? "closed" : "was priced"}">
    <li class="chain__stop" title="${escapeHtml(modelTitle)}">
      <span class="chain__key">Model line</span>
      <span class="chain__value">${formatSpread(p.projected)}</span>
      <span class="chain__sub">${ratingsSub}</span>
    </li>
    <li class="chain__stop" title="${escapeHtml(marketTitle)}">
      <span class="chain__key">${closed ? "Closing line" : "Market line"}</span>
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
      <span class="chain__value"><span class="chip chip--${tier}">${TIER_WORD[tier] ?? TIER_LABEL[tier] ?? tier}</span></span>
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
 * The route: week-by-week win chance across the whole season, and the season
 * chance each route through the rest of it arrives at.
 *
 * The chart is the season, not the week. It runs from week one to the last
 * week the pool plays whatever week is open on the card, and the week being
 * looked at is a band standing on it - so turning the week moves the band and
 * leaves the season where it was, the way the field above does with its
 * bracket. It does not travel with the card either (SLIDING in app.js): a
 * summary that slid away every time the week turned was a week page pretending
 * to be a summary.
 *
 * Weeks already played are the green run at the left: what the pick was worth
 * on the day, drawn from the results rather than the plan, with a red mark
 * where one went down. They cost the chart nothing to carry - the numbers were
 * already on the board - and they are the half of the season the two routes
 * are the continuation of.
 *
 * There is always a solid line, and it is the route the board is on: your pick
 * this week and the coach's plan around it (week.rehearsalPath, core/plan.js),
 * or the plan alone in a week you have not picked yet. That line is the season
 * as it stands, so it is the one thing the chart is never without - it was
 * missing on a week with nothing picked, which left a chart drawn entirely in
 * the dashes that are supposed to mean "only pencilled in".
 *
 * The dashes are for a difference. The coach's untouched plan
 * (week.pathRecommendation) is drawn over the weeks it would spend on another
 * team and no others, branching off the solid line at the week before and
 * rejoining it at the week after, with a mark on each week it differs. Where
 * the two plans agree there is nothing to pencil in, and the week the coach was
 * saving your team for is ruled and named besides, because that is the whole of
 * why a safer pick this week can leave a lower season.
 *
 * A pick pending in any week has the coach planning around it, and that plan
 * is the route the field shows, so it is drawn as yours whichever week is
 * being looked at. With nothing pending, a locked week has the lock on its
 * line and the coach's call for the week stands beside it as a lone mark.
 *
 * Drawn as an SVG stretched to the box for the lines, with the marks and
 * every word placed over it by percentage, so the marks stay round and the
 * type stays type whatever shape the band is.
 */
function route(state, board) {
  const { week: viewed, teams, opening, selection } = state;
  const weeks = board.weeks;
  const at = weeks.findIndex((week) => week.week === viewed.week);
  if (!weeks.length || at < 0) return "";

  // A plan covers the weeks still to play. Before the current week the chart
  // is history instead, and a plan's idea of what it would have done there is
  // not what happened.
  const stopsOf = (pathOf) =>
    weeks.map((week) => {
      const options =
        week.week < board.currentWeek ? [] : ((pathOf(week) ?? []).filter(Boolean) ?? []);
      return {
        week: week.week,
        options,
        prob: options.length
          ? options.reduce((product, option) => product * option.winProb, 1)
          : null,
      };
    });
  const nameOf = (options) => options.map((option) => option.team).join(" + ");

  // What was played: the teams that were locked in, priced as they were priced
  // on the day (week.pathWinProb, core/plan.js), and how each week went. A
  // week with nothing locked in it - a pool joined late, a week the run does
  // not cover - is a hole in the line rather than a nought.
  const played = {
    stops: weeks.map((week) => {
      if (week.week >= board.currentWeek) {
        return { week: week.week, options: [], prob: null };
      }
      const done = week.picks.filter((pick) => pick.status.result && pick.onPath);
      return {
        week: week.week,
        // Each slot keeps its own result as well as the week's: a pool that
        // picks two teams can win one and lose the other, and the callout
        // draws a line per team.
        options: done.map((pick) => ({ ...pick.onPath, result: pick.status.result })),
        prob: done.length ? week.pathWinProb : null,
        result: done.some((pick) => pick.status.result === "L") ? "L" : "W",
      };
    }),
  };
  const anyPlayed = played.stops.some((stop) => stop.prob !== null);

  const coachStops = stopsOf((week) => week.pathRecommendation);
  // A pick pending anywhere on the board has the coach planning around it,
  // and that plan is the route the field shows (week.rehearsalPath): yours,
  // whichever week is being looked at.
  const rehearsed = weeks.some((week) => Array.isArray(week.rehearsalPath));

  // The solid line, always: the route the board is on. A rehearsal is it where
  // there is one, a pick on the card is laid over the plan at this week where
  // there is not, and with neither it is the plan itself - which is still the
  // season as it stands, and still the line the chart is about.
  //
  // The overlay copies the stops rather than writing into them: `coachStops` is
  // the array the untouched plan is drawn from as well, and writing your pick
  // into it put your team on the coach's line at the one week the two are being
  // compared at.
  const you = rehearsed
    ? {
        stops: stopsOf((week) => week.rehearsalPath),
        season: Number.isFinite(board.rehearsalProbability)
          ? board.rehearsalProbability
          : estimateFor(state, board),
      }
    : selection === "picked"
      ? {
          stops: coachStops.map((stop, index) =>
            index === at
              ? {
                  ...stop,
                  options: opening,
                  prob: opening.reduce((product, option) => product * option.winProb, 1),
                }
              : stop,
          ),
          season: estimateFor(state, board),
        }
      : { stops: coachStops, season: board.pathProbability };

  // The untouched plan, and the weeks it would spend on another team. It is
  // drawn only where that list is not empty: a dashed line laid exactly over
  // the solid one says nothing, and says it in the vocabulary the board keeps
  // for a suggestion.
  const coach = { stops: coachStops, season: board.pathProbability };
  const apart = you.stops.map(
    (stop, index) =>
      stop.prob !== null &&
      coach.stops[index].prob !== null &&
      !sameTeams(
        stop.options.map((option) => option.team),
        coach.stops[index].options.map((option) => option.team),
      ),
  );
  const alternative = apart.some(Boolean) ? coach : null;

  // The coach's call for a locked week, which has no route of its own to draw.
  let lone = null;
  if (!rehearsed && selection === "locked") {
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
  }

  const series = [you, alternative].filter(Boolean);
  const probs = [...series, ...(anyPlayed ? [played] : [])]
    .flatMap((entry) => entry.stops.map((stop) => stop.prob))
    .concat(lone ? [lone.prob] : [])
    .filter(Number.isFinite);
  if (!probs.length) return "";

  // The scale is the data's, in steps of two and a half, with room over and
  // under for a mark and its figure; the rules every ten. A survivor pick
  // lives between sixty and ninety-five, and from nought every week would be a
  // flat line along the top.
  //
  // Three and a half points of room, in steps of two and a half, where it was
  // seven in steps of five. The room is for a mark and the figure over it, and
  // those are pixels, not points: at the 56-pixel plot a short phone gives the
  // chart, seven points is fourteen pixels and about right; at the 180 the
  // band has now that the fact cards are gone, it is forty-five pixels of
  // turf under the lowest week and the season it is drawing sits in the top
  // half of its own box. Rounding out to the nearest five gave back as much
  // again - a 69.5 low became 60 - so both halves come in together.
  const lo = Math.max(0, Math.floor((Math.min(...probs) - 0.035) * 40) / 40);
  const hi = Math.min(1, Math.ceil((Math.max(...probs) + 0.035) * 40) / 40);
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
        `<span class="route__rule" data-key="rule-${Math.round(level * 1000)}" style="top:${pct(yAt(level))}"><span class="route__rule-label">${Math.round(level * 100)}%</span></span>`,
    )
    .join("");

  // One polyline per unbroken run of weeks with a team on the route. `tail` is
  // a point to finish the last run on that is not a week of its own: the
  // played line runs into the first week still to come, so the season is one
  // line through the current week rather than two charts side by side.
  const lineOf = (entry, kind, tail = null) => {
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
    if (tail && runs.length) runs.at(-1).push(tail);
    return runs
      .filter((points) => points.length > 1)
      .map(
        (points, index) =>
          `<polyline class="route__line route__line--${kind}" data-key="line-${kind}-${index}" points="${points.join(" ")}" />`,
      )
      .join("");
  };

  // The branch: the alternative over the weeks it differs on and nowhere else,
  // with the week either side of each run in the line so it leaves the route it
  // is an alternative to and comes back to it. A single week's difference is
  // still a branch and a rejoin that way, where the run on its own would be one
  // point and no line at all.
  const branchOf = (entry, kind, differs) => {
    const runs = [];
    differs.forEach((parted, index) => {
      if (!parted) return;
      const last = runs.at(-1);
      if (last && last.at(-1) === index - 1) last.push(index);
      else runs.push([index]);
    });
    return runs
      .map((run) => [run[0] - 1, ...run, run.at(-1) + 1])
      .map((span) => span.filter((index) => entry.stops[index] && entry.stops[index].prob !== null))
      .filter((span) => span.length > 1)
      .map(
        (span, index) =>
          `<polyline class="route__line route__line--${kind}" data-key="line-${kind}-${index}" points="${span
            .map((stop) => `${xAt(stop).toFixed(2)},${yAt(entry.stops[stop].prob).toFixed(2)}`)
            .join(" ")}" />`,
      )
      .join("");
  };

  // Getting there: the chance of every pick before this week winning, along the
  // route the mark belongs to. The weeks already played are facts rather than
  // chances - you are here, however you got here - so they weigh nothing, and
  // what is left is the plan between now and that week, multiplied through.
  //
  // Buy backs are deliberately not in it, which is the one place on the board
  // that ignores them. A buy back is an option, not a result: the pool lets you
  // pay to come back from a loss in a forgiving week, and whether that is worth
  // doing is a decision for the week it happens in. Counting it here made the
  // figure true and useless - a pool that forgives weeks 1 and 2 reported a
  // hundred percent chance of reaching week 3 while week 2 was still a 78% game
  // on the same chart, because losing it could not end the run. This is the run
  // made on the picks alone. The season figures in the legend and on the drive
  // line still count the buy back, because that is what the coach is planning
  // for, and they are the entry's chances rather than this route's.
  //
  // Every chance the chart quotes is written to a tenth, here and on the marks
  // and in the figures over them, so a column of them reads down as one kind of
  // number. A whole percent was never enough at either end of the range: a
  // route that reaches the last week of an eighteen-week season two and a half
  // times in a hundred is not the "3%" a whole number makes of it, and one that
  // gets there four times in a thousand is certainly not "0%"; and at the other
  // end two teams a point apart were both "84%" on the week they had to be told
  // apart on.
  const figureOf = (value) => formatPercent(value, 1);
  const reachOf = (entry) => {
    let reach = 1;
    return entry.stops.map((stop) => {
      const here = reach;
      for (const option of stop.options) reach *= option.winProb;
      return stop.prob === null ? null : here;
    });
  };

  // A mark is a week, and a week in a two-team pool is two games multiplied
  // together. The mark plots the product, because that is the chance of getting
  // through the week, but the product is not a thing you can check: 84% over a
  // week is a different pick depending on whether it is two 92s or a 97 and a
  // 87. So the mark carries its legs as well, and the callout gives each team
  // its own line. One team is one leg and the leg is the week, so a pool that
  // picks once a week is written the same way with nothing spare.
  const legsOf = (options) =>
    JSON.stringify(
      options.map((option) => [option.team, figureOf(option.winProb), option.result ?? ""]),
    );

  // Each mark carries its own week, team and figures, because a touch on the
  // chart is answered out of the marks themselves (watchChart): the week is
  // the column, and what is standing in it is what the callout reads back.
  // They used to carry a `title` instead, which is a tooltip, which is a thing
  // a phone does not have.
  const dotsOf = (entry, kind, { only = null, reach = null } = {}) =>
    entry.stops
      .map((stop, index) => {
        if (stop.prob === null || (only && !only[index])) return "";
        const lost = stop.result === "L" ? " route__dot--lost" : "";
        const reached =
          reach && Number.isFinite(reach[index]) ? ` data-reach="${figureOf(reach[index])}"` : "";
        return `<span class="route__dot route__dot--${kind}${lost}${index === at ? " route__dot--here" : ""}" data-key="dot-${kind}-${index}" style="left:${pct(xAt(index))};top:${pct(yAt(stop.prob))};--order:${index}" data-at="${index}" data-week="${stop.week}" data-kind="${kind}"${stop.result ? ` data-result="${stop.result}"` : ""} data-team="${escapeHtml(nameOf(stop.options))}" data-prob="${figureOf(stop.prob)}" data-legs="${escapeHtml(legsOf(stop.options))}"${reached}></span>`;
      })
      .join("");

  // Where the season stands now, for the played line to run into.
  const firstLive = you.stops.findIndex((stop) => stop.prob !== null);
  const liveTail =
    anyPlayed && firstLive >= 0
      ? `${xAt(firstLive).toFixed(2)},${yAt(you.stops[firstLive].prob).toFixed(2)}`
      : null;

  // This week's figures ride their marks. The higher mark's figure stands
  // over it, or under it when the mark is up against the top; the lower
  // mark's stands under its own, and drops a further line when the higher
  // one is already under a mark within reach of it, so the two figures never
  // sit on each other. Two routes on the same team this week are one mark
  // and one figure.
  const here = [];
  if (you.stops[at].prob !== null) here.push({ kind: "you", prob: you.stops[at].prob });
  if (alternative && apart[at] && alternative.stops[at].prob !== null) {
    here.push({ kind: "coach", prob: alternative.stops[at].prob });
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
      return `<span class="route__figure route__figure--${mark.kind}${place}" data-key="figure-${index}" style="left:${pct(xAt(at))};top:${pct(y)}">${figureOf(mark.prob)}</span>`;
    })
    .join("");

  const loneMark = lone
    ? `<span class="route__dot route__dot--coach route__dot--here route__dot--lone" data-key="dot-lone" style="left:${pct(xAt(at))};top:${pct(yAt(lone.prob))}" data-at="${at}" data-week="${weeks[at].week}" data-kind="coach" data-team="${escapeHtml(nameOf(lone.options))}" data-prob="${figureOf(lone.prob)}" data-legs="${escapeHtml(legsOf(lone.options))}"></span>`
    : "";

  // Where the coach's route spends the team being looked at: saved for a
  // later week, or already played in an earlier one.
  const savedAt = coach.stops.findIndex(
    (stop, index) => index !== at && stop.options.some((option) => teams.includes(option.team)),
  );
  const savedTeams =
    savedAt >= 0
      ? coach.stops[savedAt].options.filter((option) => teams.includes(option.team))
      : [];
  const saved =
    savedAt >= 0
      ? `<span class="route__saved${savedAt / n > 0.62 ? " route__saved--left" : ""}" data-key="saved" style="left:${pct(xAt(savedAt))}"><span class="route__saved-label">Coach ${savedAt > at ? "saves" : "plays"} ${escapeHtml(nameOf(savedTeams))}</span></span>`
      : "";

  const axis = weeks
    .map(
      (week, index) =>
        `<span class="route__week${index === at ? " route__week--here" : ""}${index === savedAt ? " route__week--saved" : ""}" style="left:${pct(xAt(index))}">${week.week}</span>`,
    )
    .join("");

  const pending = Boolean(rehearsed && board.previewPending);
  const key = (kind, name, figure, word) =>
    `<li class="route__key route__key--${kind}"><i class="route__swatch" aria-hidden="true"></i><span class="route__key-name">${name}</span><b class="route__key-figure">${figure}</b><span class="route__key-word">${word}</span></li>`;
  // What the solid line is: your pick's route where you have made one, the lock
  // where the week is closed on it, and the plan itself where you have not - it
  // is still the route the board is on, and naming it "You" in a week you have
  // picked nothing in would be the chart claiming a decision you have not made.
  const yourName = rehearsed
    ? "You"
    : selection === "locked"
      ? "Locked"
      : selection === "coach"
        ? "Plan"
        : "You";
  const legend = [
    key(
      "you",
      yourName,
      Number.isFinite(you.season) ? formatPercent(you.season, 1) : "—",
      "season",
    ),
    alternative && key("coach", "Coach", formatPercent(alternative.season, 1), "season"),
    lone &&
      key("coach", `Coach: ${escapeHtml(nameOf(lone.options))}`, figureOf(lone.prob), "this week"),
  ]
    .filter(Boolean)
    .join("");

  const summary = series
    .map(
      (entry) =>
        `${entry === you ? "your route" : "the coach's route"}: ${figureOf(entry.stops[at].prob ?? 0)} this week, ${formatPercent(entry.season, 1)} for the season`,
    )
    .join("; ");

  // The chart's own key for the shared data-settle motion (app.js), which the
  // week it is being looked at from is deliberately not part of: the marks
  // land again when the plan they are drawing changes, and stay put when all
  // that moved is the band.
  const signature = series
    .map((entry) => `${entry.stops.map((stop) => nameOf(stop.options)).join(">")}@${entry.season}`)
    .join("|");

  return `<section class="route${alternative ? " route--compared" : ""}${pending ? " route--pending" : ""}" data-key="route" data-motion-key="coach-route" data-motion-signature="${escapeHtml(signature)}" data-view-week="${viewed.week}" aria-label="${escapeHtml(`Survival chance by week - ${summary}`)}">
    <div class="route__head" data-key="head">
      <span class="route__eyebrow">Survival chance by week</span>
      <ul class="route__legend">${legend}</ul>
    </div>
    <div class="route__plot" data-key="plot" aria-hidden="true">
      <span class="route__band" data-key="band" style="left:${pct((at / n) * 100)};width:${pct(100 / n)}"></span>
      ${grid}
      <svg class="route__lines" data-key="lines" viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
        ${anyPlayed ? lineOf(played, "played", liveTail) : ""}${alternative ? branchOf(alternative, "coach", apart) : ""}${lineOf(you, "you")}
      </svg>
      ${saved}
      ${anyPlayed ? dotsOf(played, "played") : ""}${alternative ? dotsOf(alternative, "coach", { only: apart, reach: reachOf(alternative) }) : ""}${dotsOf(you, "you", { reach: reachOf(you) })}${loneMark}
      ${figures}
      <span class="route__callout" data-key="callout" hidden></span>
    </div>
    <div class="route__axis" data-key="axis" aria-hidden="true">${axis}</div>
  </section>`;
}

/** How far a finger may travel and still be a touch rather than a swipe. */
const TAP_SLOP = 8;

/**
 * The gap the callout keeps from the mark it belongs to, which is the one thing
 * about its placement this file has to know: `--shift-y` in components.css sets
 * it, and `reveal` needs it to work out whether the callout fits above the mark
 * or has to drop under it. Twelve above, fourteen below - the larger of the two
 * here, so the side being tested for is never the tighter one.
 */
const CALLOUT_GAP = 14;

/**
 * Touch a week on the chart and it says who is standing there.
 *
 * The marks carried a `title` and nothing else, which is a tooltip: a thing a
 * mouse has and a phone does not, on a board that is a phone first. So the
 * chart answers a touch instead - anywhere in a week's column, not on the
 * eight pixels of the mark itself - with the week, a line per team on each
 * route, the chance that team's own game carries and the chance of getting
 * there to play the week, in a callout over the mark.
 *
 * Bound once, to the panel, which survives every render (frame in ui/patch.js);
 * the callout lives in the chart's own markup, so a render that redraws the
 * chart takes it down with the numbers it was quoting, and a render that does
 * not leaves it up.
 *
 * On the release, and only for a finger that stayed put: the case is one of
 * the surfaces a sideways drag turns the week on (watchDrags in app.js), and a
 * swipe that flashed a callout on its way past would be the chart answering a
 * question about a week nobody is looking at any more. A mouse gets it on the
 * move, as the tooltip used to be, and loses it at the edge of the case.
 */
function watchChart(panel) {
  if (panel.dataset.chartWatched) return;
  panel.dataset.chartWatched = "yes";

  let down = null;
  const plotOf = (target) => target?.closest?.(".route__plot") ?? null;

  panel.addEventListener("pointerdown", (event) => {
    const plot = plotOf(event.target);
    down = plot && event.isPrimary ? { x: event.clientX, y: event.clientY, plot } : null;
  });

  panel.addEventListener("pointerup", (event) => {
    const start = down;
    down = null;
    if (!start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP) return;
    reveal(start.plot, event.clientX);
  });

  panel.addEventListener("pointercancel", () => {
    down = null;
  });

  panel.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse") return;
    const plot = plotOf(event.target);
    if (plot) reveal(plot, event.clientX);
  });

  panel.addEventListener("pointerleave", () => hideCallout(panel));

  // A touch anywhere else puts it away - including elsewhere on the board,
  // which is the only way a finger has of saying it has read it. Once for the
  // page rather than once per panel: the board has one case, but it renders a
  // second copy of it for every week it swipes past.
  if (dismissWatched) return;
  dismissWatched = true;
  document.addEventListener("pointerdown", (event) => {
    if (!plotOf(event.target)) hideCallout(document);
  });
}

/** Whether the page-wide dismissal is already listening. */
let dismissWatched = false;

function hideCallout(root) {
  for (const callout of root.querySelectorAll(".route__callout")) callout.hidden = true;
}

/**
 * Name what is standing in the column under `clientX`.
 *
 * The marks say where they are in their own inline styles, as percentages of
 * the plot, so the callout is placed off those rather than off a second
 * measurement of the page: the column is the nearest mark's, and the callout
 * stands over the highest mark in it. Against the ends of the chart it hangs
 * from the side it has room on, and against the top it drops under the mark,
 * because the case clips what leaves it.
 */
function reveal(plot, clientX) {
  const callout = plot.querySelector(".route__callout");
  if (!callout) return;
  const dots = [...plot.querySelectorAll(".route__dot[data-at]")];
  if (!dots.length) return;

  const box = plot.getBoundingClientRect();
  const wanted = box.width > 0 ? ((clientX - box.left) / box.width) * 100 : 0;
  const xOf = (dot) => parseFloat(dot.style.left);
  const nearest = dots.reduce((best, dot) =>
    Math.abs(xOf(dot) - wanted) < Math.abs(xOf(best) - wanted) ? dot : best,
  );
  const column = dots.filter((dot) => dot.dataset.at === nearest.dataset.at);

  // Your route first, and one line where both routes are on the same team:
  // that is the one mark the chart draws for them.
  const marks = [];
  const order = (dot) => (dot.dataset.kind === "you" ? 0 : 1);
  for (const dot of [...column].sort((a, b) => order(a) - order(b))) {
    const { kind, team, prob, reach, result, legs } = dot.dataset;
    if (marks.some((mark) => mark.team === team && mark.prob === prob)) continue;
    marks.push({ kind, team, prob, reach, result, legs: JSON.parse(legs || "[]") });
  }

  // A line per team rather than per mark: a college pool picks two a week, and
  // "Texas + Oregon 84%" is the product of two games neither of which is 84%.
  // Each line carries the team's own chance; the week's own figure stands over
  // the mark on the chart, which is where the product belongs. A leg that lost
  // is drawn as lost on its own line, because the other one may have won.
  // "To here" is the week's, not the team's, so it rides the first line of a
  // mark and the rest of them leave the column standing empty.
  const rows = marks.flatMap((mark) =>
    mark.legs.length > 1
      ? mark.legs.map(([team, prob, result], index) => ({
          kind: mark.kind,
          team,
          prob,
          result: result || null,
          reach: mark.reach,
          lead: index === 0,
        }))
      : [{ ...mark, lead: true }],
  );
  const split = marks.some((mark) => mark.legs.length > 1);

  // Two figures, because one of them cannot be read without the other: what the
  // week itself is worth, and the chance of being in the pool to play it - the
  // plan's own weeks up to there, and nothing from the weeks already played,
  // which happened. A 90% week in the last column of the season is not a 90%
  // week if the plan only gets there half the time, and the two columns say so
  // side by side rather than leaving it to be worked out. A played week has no
  // second figure: you were there.
  const reached = rows.some((row) => row.reach);
  const x = xOf(nearest);
  const y = Math.min(...column.map((dot) => parseFloat(dot.style.top)));
  callout.innerHTML =
    `<span class="route__callout-head"><b class="route__callout-week">Wk ${escapeHtml(nearest.dataset.week)}</b>${
      reached
        ? `<span class="route__callout-label">${split ? "Game" : "Week"}</span><span class="route__callout-label">To here</span>`
        : ""
    }</span>` +
    rows
      .map(
        (row) =>
          `<span class="route__callout-row route__callout-row--${row.kind}${row.result === "L" ? " route__callout-row--lost" : ""}${row.lead ? "" : " route__callout-row--leg"}"><i class="route__swatch" aria-hidden="true"></i><span class="route__callout-team">${escapeHtml(row.team)}</span><b class="route__callout-prob">${escapeHtml(row.prob)}</b>${
            reached
              ? `<b class="route__callout-reach">${row.lead ? (row.reach ? escapeHtml(row.reach) : "—") : ""}</b>`
              : ""
          }</span>`,
      )
      .join("");
  callout.style.left = `${x.toFixed(2)}%`;
  callout.style.top = `${y.toFixed(2)}%`;
  callout.hidden = false;

  // Which end it hangs from is measured rather than guessed at. It was a fifth
  // of the plot from either end, which was the right guess for a box as wide as
  // a team name and one four-character figure and the wrong one for what it is
  // now: two columns of figures written to a tenth, over a college week that
  // puts two teams in the box. The widest of those ran a dozen pixels out of
  // the chart on a phone. So it is centred on the mark where the box that makes
  // fits inside the plot, and hung from whichever end it is running past where
  // it does not.
  callout.classList.remove("route__callout--right", "route__callout--left");
  const plotBox = plot.getBoundingClientRect();
  const centred = callout.getBoundingClientRect();
  if (centred.left < plotBox.left) callout.classList.add("route__callout--right");
  else if (centred.right > plotBox.right) callout.classList.add("route__callout--left");
  // Above the mark where there is room for it, under the mark where there is
  // not. How much room it needs is measured rather than assumed: it was a fixed
  // third of the plot, which was the right number for a callout of a week and
  // two teams and the wrong one the moment a second column of figures gave it
  // a heading row - a high mark then put it over the legend, which is the pair
  // of season figures the whole chart is a comparison of. The plot is unhidden
  // and it is the case that clips (components.css), so what this protects is
  // what can be read, not what fits.
  const room = plotBox.height;
  const needed = room ? ((callout.offsetHeight + CALLOUT_GAP) / room) * 100 : 0;
  callout.classList.toggle("route__callout--below", y < needed);
}
