/**
 * Recommendation engine.
 *
 * Given the remaining weeks, which teams should each week hold to maximise the
 * chance of surviving the season? This is not "take the biggest favourite every
 * week" - that strands you in the middle of the year, where nothing is soft. It
 * is a whole-path optimisation under the no-repeat rule.
 *
 * League agnostic: the college pool takes two picks a week with no forgiveness,
 * the NFL pool takes one with a buy back covering the opening weeks. Both fall
 * out of picksPerWeek, buyBackWeeks and buyBacks.
 *
 * Pure and environment-free, so scripts/refresh-odds.mjs runs the same code
 * the browser does and can tell when the recommendation has moved.
 *
 * Three layers:
 *
 *   1. A beam search over the weeks finds the best complete path on the
 *      numbers as they stand. Exact search over the set of spent teams is
 *      infeasible, but the beam keeps the coupling between weeks that a greedy
 *      pass throws away, and the finalists are re-scored on the exact survival
 *      maths so buy backs are valued properly.
 *
 *   2. The frontier judges this week's choice under uncertainty. The best path
 *      commits to a December pick priced off today's ratings, and today's
 *      ratings will be wrong by an amount the calibration knows. So the few
 *      candidates this week that any good path starts with are each played
 *      through a set of futures (core/scenarios.js): in each future the rest
 *      of the season is re-planned around the candidate, exactly, by
 *      assignment (core/assignment.js), and the candidate that survives most
 *      of those futures is the call. That values keeping options open, which
 *      a single path priced to the decimal cannot.
 *
 *   3. The call keeps a floor on this week's chance: the season is the goal,
 *      but not at the price of a week that is nearly a coin flip. A week a buy
 *      back in hand covers spends the weakest team the futures cannot fault,
 *      keeping the stronger ones for the weeks that can end the season. And
 *      when the pool asks for it (data/<league>/pool.json), the field's
 *      leverage weighs in: surviving alongside everyone else wins nothing
 *      (core/equity.js). By default the field is only priced and reported.
 */

import { survival } from "./survival.js";
import { assignPath, FORBIDDEN } from "./assignment.js";
import { scenarioSet } from "./scenarios.js";
import { DEFAULT_MODEL } from "./probability.js";
import { equityOverlay, bySurvival, byEquity } from "./equity.js";

/** Beams carried between weeks. Higher = better paths, slower. */
const BEAM_WIDTH = 160;

/** Teams considered per slot per week, best win probability first. */
const CANDIDATE_WIDTH = 12;

/** Future weeks scanned when estimating what a beam has left. */
const LOOKAHEAD_POOL = 16;

/** Beams re-scored on the exact survival maths once the search has finished. */
const FINALISTS = 40;

/**
 * Candidates that get a lookahead each week. An order of magnitude wider than
 * the beam, so the cheap pre-rank cannot realistically drop a path the
 * expensive one would have kept.
 */
const SHORTLIST = 1200;

/** Futures each candidate for this week is played through. */
export const SCENARIO_COUNT = 32;

/** Candidates for this week that get the scenario treatment. */
const FRONTIER_WIDTH = 6;

/** Alternatives the frontier reports, best first. */
const FRONTIER_SHOWN = 4;

/**
 * How many calls the coach makes for a week, as a multiple of the picks it has
 * to make there: one pick a week gets a first and a second choice, two picks a
 * week get four ranked. Enough that there is always a named fallback for every
 * slot the week has, and no more - a list longer than the week is deep stops
 * being advice and becomes the whole board over again.
 */
export const COACH_DEPTH = 2;

/**
 * A candidate counts as holding up in a future when it is within this share
 * of the best candidate's survival there.
 */
const ROBUST_MARGIN = 0.03;

/** Probabilities multiply, so we add logs and avoid underflow across 26 picks. */
const logp = (p) => Math.log(Math.max(p, 1e-9));

/**
 * @param {object} args
 * @param {Array} args.weeks  [{week, options:[{team,winProb,...}], fixed:[teamOrNull,teamOrNull]}]
 * @param {Set<string>} args.burned Teams already spent and unavailable.
 * @param {number} args.picksPerWeek
 * @param {number[]} args.buyBackWeeks Weeks where a loss is forgiven.
 * @param {number} args.buyBacks How many losses the pool forgives in total.
 * @param {object|null} [args.seed] A path to compete as a finalist.
 * @param {object} [args.model] The probability model, for the futures.
 * @param {number} [args.scenarios] How many futures to play; 0 skips the frontier.
 * @param {"win"|"lose"} [args.objective] What a pick has to do. Every winProb
 *   handed in is already the chance the pick carries its week, so this is only
 *   for the futures, which price spreads of their own (core/scenarios.js).
 * @param {boolean} [args.quick] The exact assignment alone, no beam and no
 *   frontier: a millisecond's answer for a preview, where the full search's
 *   hundred would be felt on every tap. The beam still runs if the assignment
 *   has no legal answer.
 * @param {object|null} [args.pool] data/<league>/pool.json, when kept. The
 *   frontier prices leverage against the field it names, or against one
 *   implied from the lines (core/equity.js), and calls the week by its mode.
 * @param {number} [args.poolBuyBacks] The buy backs the pool grants everyone,
 *   for the field's own cushion; `buyBacks` is what this entry has left.
 * @returns {{picks:Object<number,string[]>, pathProbability:number, shortfalls:number[],
 *            frontier:object|null, ranked:Object<number,string[]>}} `ranked` is
 *   the coach's calls for each week, best first and COACH_DEPTH times as many
 *   as the week needs (see rankCalls). Empty for a quick answer.
 */
export function recommendPath({
  weeks,
  burned,
  picksPerWeek = 2,
  buyBackWeeks = [],
  buyBacks = 0,
  seed = null,
  model = DEFAULT_MODEL,
  scenarios = SCENARIO_COUNT,
  quick = false,
  objective = "win",
  pool = null,
  poolBuyBacks = buyBacks,
}) {
  const forgiving = new Set(buyBacks > 0 ? buyBackWeeks : []);

  // The beam has to prune long before it knows how a path ends, and the score
  // it prunes on cannot express "a loss here is forgiven" - that is a property
  // of the whole path, not of one week. So the search is run more than once at
  // different levels of forgiveness, and every finalist from every pass is then
  // compared on the real survival maths.
  //
  // 0 discounts nothing (the college pool, one pass). 1 treats a forgiving week
  // as free, which finds the paths that spend a weak team early to keep a
  // strong one for later. The share in between is what one buy back spread over
  // its weeks is actually worth. The exact re-score at the end decides.
  const credits = forgiving.size === 0 ? [0] : ladder(Math.min(1, buyBacks / forgiving.size));

  const finalists = [];
  for (const credit of credits) {
    if (!quick) finalists.push(...search(credit).slice(0, FINALISTS));
    // The same problem with the coupling between weeks dropped is an
    // assignment, solved exactly in a millisecond (core/assignment.js). When
    // its answer breaks no rule - it never takes a spent team, and only the
    // two-sides-of-one-game rule is outside it - it is a finalist too, and
    // the exact re-score below decides between it and the beam's own. A quick
    // answer is this finalist alone.
    const exact = assignedFinalist(credit);
    if (exact) finalists.push(exact);
  }
  // Nothing legal from the assignment at any level, so the beam has to run
  // after all: quick was a preference, not a promise of a worse answer.
  if (quick && finalists.length === 0) {
    for (const credit of credits) finalists.push(...search(credit).slice(0, FINALISTS));
  }

  // The path already on the board competes on equal terms, so the
  // recommendation can never come back worse than what you already have.
  if (seed) {
    const seeded = scorePath({ weeks, burned, path: seed, picksPerWeek });
    if (seeded) finalists.push(seeded);
  }

  if (finalists.length === 0) {
    return { picks: {}, pathProbability: 0, shortfalls: [], frontier: null, ranked: {} };
  }

  for (const beam of finalists) {
    beam.survival = survivalOfPath({ weeks, path: beam.picks, buyBackWeeks, buyBacks });
  }
  finalists.sort((a, b) => b.survival - a.survival);
  let best = finalists[0];

  // This week's call, judged across futures rather than on one path.
  const frontier =
    scenarios > 0 && !quick
      ? judgeFrontier({
          weeks,
          burned,
          picksPerWeek,
          buyBackWeeks,
          buyBacks,
          finalists,
          model,
          scenarios,
          objective,
          pool,
          poolBuyBacks,
        })
      : null;

  // The path shown is the best path that starts the way the frontier says.
  // Usually that is the best path outright. When the futures prefer another
  // opening, the frontier's own best path through it - the better of the
  // beam's finalist and the exact assignment - is what is shown, and failing
  // both the beam is run again with the opening fixed.
  if (frontier?.chosen) {
    const opening = frontier.chosen.teams;
    const through = frontier.chosen.path
      ? {
          picks: frontier.chosen.path,
          survival: frontier.chosen.season,
          // A week holding fewer picks than the pool asks for is short by
          // nature - one fixture left, say - and reports itself so, exactly
          // as the beam's own paths do.
          shortfalls: weeks
            .filter((week) => (frontier.chosen.path[week.week] ?? []).length < picksPerWeek)
            .map((week) => week.week),
        }
      : (finalists.find((beam) => sameSet(beam.picks[weeks[0].week] ?? [], opening)) ??
        pathThrough(opening));
    if (
      through &&
      (through.survival > best.survival || !sameSet(opening, best.picks[weeks[0].week] ?? []))
    ) {
      best = through;
    }
  }

  return {
    picks: best.picks,
    pathProbability: best.survival,
    shortfalls: best.shortfalls,
    frontier: frontier ? { ...frontier, chosen: { teams: frontier.chosen.teams } } : null,
    // A preview is answering a tap and gets the path alone; the coach's ranked
    // board belongs to the committed plan, which is what the board shows it
    // from (core/plan.js).
    ranked: quick ? {} : rankCalls(best.picks, frontier),
  };

  /**
   * The coach's calls for every week, best first and COACH_DEPTH times as many
   * as the week needs: the path's own pick or picks, then the fallbacks behind
   * them.
   *
   * A fallback is not "the next biggest favourite this week". It is what the
   * whole rest of the season does when the calls already ranked for that week
   * are off the table, which is the only reading of second choice a survivor
   * pool has: the team you would take instead, given everything you would then
   * spend the other weeks on. So each rank is a re-plan (nextBest), and the
   * week on the clock skips it - the frontier has already ranked that week's
   * openings across the futures, which is a better answer than a re-plan on
   * today's numbers alone.
   *
   * Weeks whose slots are all locked get nothing: there is no call left to
   * make, and the fallback for a decision already committed to is not advice.
   */
  function rankCalls(path, judged) {
    const board = {};
    for (const week of weeks) {
      const fixed = (week.fixed ?? []).filter(Boolean);
      if (picksPerWeek - fixed.length <= 0) continue;
      const list = (path[week.week] ?? []).filter((team) => !fixed.includes(team));
      // Twice what the coach actually calls for the week, which is what the
      // week needs except where the fixtures are short of it: a week down to
      // one game left is one call, and one call gets one fallback. A week the
      // path could not fill at all gets nothing - a fallback stands behind a
      // call, and with no call there is nothing for it to stand behind.
      if (list.length === 0) continue;
      const depth = list.length * COACH_DEPTH;

      if (judged?.week === week.week) {
        for (const candidate of judged.candidates ?? []) {
          for (const team of candidate.teams) {
            if (list.length < depth && !list.includes(team)) list.push(team);
          }
        }
      }

      while (list.length < depth) {
        const found = nextBest(week, fixed, list);
        if (found.length === 0) break;
        list.push(...found);
      }
      if (list.length > 0) board[week.week] = list.slice(0, depth);
    }
    return board;
  }

  /**
   * What a week takes when the calls already ranked for it are barred: the
   * remaining season re-planned around that by exact assignment, at each level
   * of forgiveness, and judged on the same survival maths the path itself was
   * chosen on. Barred in that week only - a team ruled out of week 5 is still
   * the best thing week 9 has.
   *
   * A week with no complete re-plan behind it - late in a season the teams
   * cannot cover - falls back to its own best remaining line, which is still
   * the honest next call even where the path cannot be finished.
   */
  function nextBest(week, fixed, taken) {
    const barred = new Set(taken);
    let found = null;
    for (const credit of credits) {
      const effective = (at, p) => (forgiving.has(at) ? 1 - (1 - p) * (1 - credit) : p);
      const assigned = assignPath({
        weeks,
        burned,
        picksPerWeek,
        weightOf: (at, team, winProb) =>
          at === week.week && barred.has(team) ? FORBIDDEN : logp(effective(at, winProb)),
      });
      if (!assigned.complete || !conflictFree(weeks, assigned.picks)) continue;
      const survived = survivalOfPath({
        weeks,
        path: assigned.picks,
        buyBackWeeks,
        buyBacks,
      });
      if (!found || survived > found.survival)
        found = { survival: survived, picks: assigned.picks };
    }
    const teams = (found?.picks[week.week] ?? []).filter(
      (team) => !fixed.includes(team) && !barred.has(team),
    );
    if (teams.length > 0) return teams;

    const spare = openOptions(week, fixed).find(
      (option) => !burned.has(option.team) && !barred.has(option.team),
    );
    return spare ? [spare.team] : [];
  }

  /**
   * The exact best path with the coupling dropped, at one level of
   * forgiveness, or null when it takes both sides of a game somewhere or
   * leaves a slot unfilled.
   */
  function assignedFinalist(credit) {
    const effective = (week, p) => (forgiving.has(week) ? 1 - (1 - p) * (1 - credit) : p);
    const assigned = assignPath({
      weeks,
      burned,
      picksPerWeek,
      weightOf: (week, team, winProb) => logp(effective(week, winProb)),
    });
    if (!assigned.complete || !conflictFree(weeks, assigned.picks)) return null;
    const used = new Set(burned);
    for (const teams of Object.values(assigned.picks)) for (const team of teams) used.add(team);
    return { used, score: assigned.value, picks: assigned.picks, shortfalls: [] };
  }

  /** The best complete path that opens with these teams, by a second beam. */
  function pathThrough(teams) {
    const [first, ...rest] = weeks;
    const slots = [...(first.fixed ?? [])];
    const open = teams.filter((team) => !slots.includes(team));
    for (let index = 0; index < slots.length && open.length; index += 1) {
      if (!slots[index]) slots[index] = open.shift();
    }
    while (open.length) slots.push(open.shift());
    const fixed = [{ ...first, fixed: slots }, ...rest];
    const found = recommendPath({
      weeks: fixed,
      burned,
      picksPerWeek,
      buyBackWeeks,
      buyBacks,
      model,
      scenarios: 0,
    });
    if (!found.picks[first.week]) return null;
    return { picks: found.picks, survival: found.pathProbability, shortfalls: found.shortfalls };
  }

  /** One beam search, scoring forgiving weeks at the given discount. */
  function search(credit) {
    const effective = (week, p) => (forgiving.has(week) ? 1 - (1 - p) * (1 - credit) : p);
    // Ranking beams on score alone is myopically greedy: a path that spends its
    // best teams early looks best right up until the late weeks it has ruined.
    // Each beam is ranked on score PLUS an optimistic estimate of what it has
    // left, so paths are compared over the whole season.
    const pools = weeks.map((week) =>
      [...week.options]
        .sort((a, b) => b.winProb - a.winProb)
        .slice(0, LOOKAHEAD_POOL)
        .map((option) => ({ team: option.team, lp: logp(effective(week.week, option.winProb)) })),
    );

    // Each later week takes the best teams it has left, and a team taken by
    // one week is reserved from the ones after it. Still optimistic - the
    // earlier week gets first call on a team two weeks both want - but a
    // team is never counted twice, which is what made the old estimate value
    // a saved star as if it could play every remaining Saturday.
    const estimateRemaining = (used, fromIndex) => {
      const reserved = new Set();
      let total = 0;
      for (let i = fromIndex; i < pools.length; i += 1) {
        let taken = 0;
        for (const entry of pools[i]) {
          if (used.has(entry.team) || reserved.has(entry.team)) continue;
          reserved.add(entry.team);
          total += entry.lp;
          taken += 1;
          if (taken === picksPerWeek) break;
        }
      }
      return total;
    };

    let beams = [{ used: new Set(burned), score: 0, picks: {}, shortfalls: [] }];

    for (const [index, week] of weeks.entries()) {
      const fixed = (week.fixed ?? []).filter(Boolean);
      const need = picksPerWeek - fixed.length;

      const lp = (winProb) => logp(effective(week.week, winProb));

      // Fixed picks still score, so totals stay comparable between beams.
      const fixedScore = fixed.reduce((sum, team) => {
        const option = week.options.find((o) => o.team === team);
        return sum + lp(option?.winProb ?? 0.5);
      }, 0);

      const ranked = openOptions(week, fixed);

      // A two-pick week expands every beam into ~66 candidates, so this list
      // runs to ten thousand entries. They are proposals, not beams: just the
      // parent, the teams taken and the running score. Copying the spent-team
      // set for each one was the single most expensive thing the search did,
      // and all but a handful of those copies were thrown away unread.
      const next = [];

      for (const beam of beams) {
        const available = ranked
          .filter((option) => !beam.used.has(option.team))
          .slice(0, CANDIDATE_WIDTH);

        if (need <= 0 || available.length === 0) {
          next.push(propose(beam, fixed, fixedScore, available.length < need));
          continue;
        }

        if (need === 1) {
          for (const option of available) {
            next.push(propose(beam, [...fixed, option.team], fixedScore + lp(option.winProb)));
          }
          continue;
        }

        if (available.length === 1) {
          const only = available[0];
          next.push(propose(beam, [...fixed, only.team], fixedScore + lp(only.winProb), true));
          continue;
        }

        // The same rule between two open slots: one game cannot fill both of
        // them. When that pairing is all the week has left - one fixture still
        // to play, both slots open - the week takes one pick rather than a
        // guaranteed loss alongside it, and reports itself short.
        let paired = false;
        for (let i = 0; i < available.length; i += 1) {
          for (let j = i + 1; j < available.length; j += 1) {
            const a = available[i];
            const b = available[j];
            if (a.opponent === b.team) continue;
            paired = true;
            next.push(
              propose(beam, [...fixed, a.team, b.team], fixedScore + lp(a.winProb) + lp(b.winProb)),
            );
          }
        }

        if (!paired) {
          // Sorted by win probability, so this is the better side of the one
          // game left.
          const top = available[0];
          next.push(propose(beam, [...fixed, top.team], fixedScore + lp(top.winProb), true));
        }
      }

      // The lookahead is the other expensive part: it walks every remaining
      // week for every candidate it is given. Score alone is a cheap and
      // well-correlated ordering, so the field is cut on that first and only
      // the shortlist pays for a set copy and a lookahead. The shortlist is an
      // order of magnitude wider than the beam that survives it.
      if (next.length > SHORTLIST) {
        next.sort((a, b) => b.score - a.score);
        next.length = SHORTLIST;
      }

      // Rank on score + lookahead, but keep `score` as the true path score.
      const scored = next.map((proposal) => {
        const beam = materialise(proposal, week.week);
        beam.rank = beam.score + estimateRemaining(beam.used, index + 1);
        return beam;
      });
      scored.sort((a, b) => b.rank - a.rank);

      // Two beams holding the same spent set are interchangeable from here on;
      // keeping both just crowds out genuinely different paths.
      const seen = new Set();
      beams = [];
      for (const beam of scored) {
        const signature = [...beam.used].sort().join("|");
        if (seen.has(signature)) continue;
        seen.add(signature);
        beams.push(beam);
        if (beams.length === BEAM_WIDTH) break;
      }
      if (beams.length === 0) break;
    }

    return beams;
  }
}

/**
 * The teams a week's open slots can choose from, best first. Both sides of one
 * game cannot both come through it, so a team playing one this week already
 * holds is no candidate: it would spend a slot on a certain loss.
 */
function openOptions(week, fixed) {
  const fixedOpponents = new Set(
    fixed.flatMap((team) => {
      const option = week.options.find((o) => o.team === team);
      return option ? [option.opponent] : [];
    }),
  );
  return [...week.options]
    .filter((option) => !fixed.includes(option.team) && !fixedOpponents.has(option.team))
    .sort((a, b) => b.winProb - a.winProb);
}

/**
 * This week's choice, judged across futures.
 *
 * The candidates are the openings the finalists actually use - every good
 * path starts with one of a handful of teams - plus the week's outright
 * favourite(s), so the safest call is always on the table. Each is then
 * played through the same set of futures: the rest of the season is
 * re-planned around it by exact assignment on the future's numbers, and the
 * whole path is scored on the exact survival maths. What comes back per
 * candidate is its survival in every future, and from that its mean, its
 * downside, and how often it was within a whisker of the best. The pool's
 * field is then laid over the candidates and the mode makes the call
 * (core/equity.js): the best mean above the floor - or the best equity, when
 * the pool asks - and in a week a buy back in hand covers, the weakest team
 * among the openings within a whisker of it.
 *
 * @returns {object|null} Null when this week has nothing open to decide.
 */
function judgeFrontier({
  weeks,
  burned,
  picksPerWeek,
  buyBackWeeks,
  buyBacks,
  finalists,
  model,
  scenarios,
  objective = "win",
  pool = null,
  poolBuyBacks = buyBacks,
}) {
  const [first, ...rest] = weeks;
  if (!first) return null;
  const fixed = (first.fixed ?? []).filter(Boolean);
  const need = picksPerWeek - fixed.length;
  if (need <= 0) return null;

  const ranked = openOptions(first, fixed).filter((option) => !burned.has(option.team));
  if (ranked.length === 0) return null;

  // Openings, distinct, best finalist first.
  const candidates = [];
  const seenKey = new Set();
  const consider = (teams) => {
    const open = teams.filter((team) => !fixed.includes(team));
    if (open.length === 0) return;
    const key = [...open].sort().join("|");
    if (seenKey.has(key)) return;
    seenKey.add(key);
    candidates.push(open);
  };
  for (const beam of finalists) {
    if (candidates.length >= FRONTIER_WIDTH) break;
    consider(beam.picks[first.week] ?? []);
  }
  // The week's favourite(s), taken greedily and never two sides of one game.
  const greedy = [];
  for (const option of ranked) {
    if (greedy.some((taken) => taken.opponent === option.team)) continue;
    greedy.push(option);
    if (greedy.length === need) break;
  }
  consider(greedy.map((option) => option.team));
  if (candidates.length === 0) return null;

  const forgiving = new Set(buyBacks > 0 ? buyBackWeeks : []);
  const optionOf = (week, team) => week.options.find((option) => option.team === team);
  const weeklyProb = (teams) =>
    [...fixed, ...teams].reduce(
      (product, team) => product * (optionOf(first, team)?.winProb ?? 0.5),
      1,
    );

  // Every candidate is judged on the same futures. A week's distance from
  // this one is what the futures draw on; the board sets it, and a caller
  // that has not is read as one week per week.
  const ahead = rest.map((week, index) => ({
    ...week,
    options: week.options.map((option) => ({
      ...option,
      weeksAhead: option.weeksAhead ?? index + 1,
    })),
  }));
  // The futures re-price a drawn spread, so they need to know which side of it
  // this pool is on (see core/scenarios.js).
  const futures = scenarioSet({ weeks: ahead, model, count: scenarios, objective });

  const judged = candidates.map((teams) => {
    const opening = [...fixed, ...teams];
    const spent = new Set([...burned, ...opening]);
    const openingProb = weeklyProb(teams);
    const weightOf = continuationWeights({
      currentWeek: first.week,
      openingProb,
      weeks: rest,
      forgiving,
      buyBacks,
    });

    const survivals = futures.map((future) => {
      const continuation = assignPath({ weeks: future, burned: spent, picksPerWeek, weightOf });
      return survivalOfPath({
        weeks: [first, ...future],
        path: { ...continuation.picks, [first.week]: opening },
        buyBackWeeks,
        buyBacks,
      });
    });

    // The point-estimate path through this opening, for the number the strip
    // shows: the better of the best finalist that opens this way and the
    // exact assignment of the rest around it. The beam's finalists are the
    // paths that survived a search for the best opening, so the ones through
    // another opening can be poor company; the assignment is not.
    const finalist = finalists.find((beam) => sameSet(beam.picks[first.week] ?? [], opening));
    let season = finalist?.survival ?? 0;
    let path = finalist?.picks ?? null;
    const continuation = assignPath({ weeks: rest, burned: spent, picksPerWeek, weightOf });
    if (continuation.complete && conflictFree(rest, continuation.picks)) {
      const assigned = { ...continuation.picks, [first.week]: opening };
      const assignedSurvival = survivalOfPath({ weeks, path: assigned, buyBackWeeks, buyBacks });
      if (assignedSurvival > season) {
        season = assignedSurvival;
        path = assigned;
      }
    }

    return {
      teams: [...teams],
      path,
      weekWinProb: teams.reduce(
        (product, team) => product * (optionOf(first, team)?.winProb ?? 0.5),
        1,
      ),
      season,
      scenarioMean: mean(survivals),
      scenarioLow: quantile(survivals, 0.2),
      survivals,
    };
  });

  // Robustness: in what share of the futures was each candidate within a
  // whisker of that future's best?
  for (let index = 0; index < futures.length; index += 1) {
    const top = Math.max(...judged.map((candidate) => candidate.survivals[index]));
    for (const candidate of judged) {
      candidate.robust =
        (candidate.robust ?? 0) + (candidate.survivals[index] >= top * (1 - ROBUST_MARGIN) ? 1 : 0);
    }
  }

  // The pool's field over each opening - its leverage, and survival across
  // the futures times that as equity - and the mode's call among them. A week
  // is covered when it is forgiving and this entry still holds a buy back; the
  // field's own cushion is what the pool grants everyone.
  const covered = forgiving.has(first.week) && buyBacks > 0;
  const overlaid = equityOverlay({
    frontier: { week: first.week, candidates: judged },
    options: first.options,
    pool,
    picksPerWeek,
    forgiving: new Set(poolBuyBacks > 0 ? buyBackWeeks : []),
    poolBuyBacks,
    covered,
  });
  const byMode = overlaid.pool
    ? [...overlaid.candidates].sort(overlaid.pool.mode === "safest" ? bySurvival : byEquity)
    : [...judged].sort(bySurvival);
  const chosen =
    (overlaid.pool && overlaid.candidates.find((candidate) => candidate.preferred)) || byMode[0];
  const ordered = [chosen, ...byMode.filter((candidate) => candidate !== chosen)];
  const bestSeason = Math.max(...ordered.map((candidate) => candidate.season));
  const bestMean = Math.max(...ordered.map((candidate) => candidate.scenarioMean));

  return {
    week: first.week,
    scenarios: futures.length,
    chosen: { teams: chosen.teams, path: chosen.path, season: chosen.season },
    pool: overlaid.pool ?? null,
    candidates: ordered.slice(0, FRONTIER_SHOWN).map((candidate, index) => ({
      teams: candidate.teams,
      weekWinProb: candidate.weekWinProb,
      season: candidate.season,
      scenarioMean: candidate.scenarioMean,
      scenarioLow: candidate.scenarioLow,
      robust: candidate.robust / futures.length,
      ...(overlaid.pool
        ? {
            popularity: candidate.popularity,
            fieldSurvival: candidate.fieldSurvival,
            leverage: candidate.leverage,
            equity: candidate.equity,
            equityCost: candidate.equityCost,
          }
        : {}),
      // Against the best on each measure, as a share of it: what the call
      // costs on the numbers as they stand, and across the futures.
      seasonCost: bestSeason > 0 ? 1 - candidate.season / bestSeason : 0,
      scenarioCost: bestMean > 0 ? 1 - candidate.scenarioMean / bestMean : 0,
      chosen: index === 0,
      preferred: index === 0,
    })),
  };
}

/**
 * The weight a team earns in a later week when the rest of the season is
 * planned by assignment, given what this week's opening already risks.
 *
 * An ordinary week is worth the log of the win probability. A forgiving week
 * is not separable, but the cases this pool has are exact:
 *
 *   - every remaining forgiving week can be bought back: the week costs
 *     nothing to lose, so it is worth nothing to win (the team is still spent,
 *     which is the only reason to care which one);
 *   - one buy back, this week forgiving with probability q of holding, one
 *     forgiving week f left: the pair survives with q + (1 - q) p_f, so f is
 *     worth log(q + (1 - q) p_f).
 *
 * Anything else falls back to the credit the beam uses, and the path is
 * still scored exactly afterwards; only the choice of continuation is
 * approximate there.
 *
 * Exported for scripts/validate-recommend.mjs, which checks the exact cases
 * against core/survival.js.
 */
export function continuationWeights({ currentWeek, openingProb, weeks, forgiving, buyBacks }) {
  const remaining = weeks.filter((week) => forgiving.has(week.week)).map((week) => week.week);
  const currentForgiving = forgiving.has(currentWeek);
  const exposure = remaining.length + (currentForgiving ? 1 : 0);

  if (remaining.length === 0) return (week, team, winProb) => logp(winProb);
  if (buyBacks >= exposure) {
    return (week, team, winProb) => (forgiving.has(week) ? 0 : logp(winProb));
  }
  if (buyBacks === 1 && currentForgiving && remaining.length === 1) {
    return (week, team, winProb) =>
      forgiving.has(week) ? logp(openingProb + (1 - openingProb) * winProb) : logp(winProb);
  }
  const credit = Math.min(1, buyBacks / remaining.length);
  return (week, team, winProb) =>
    forgiving.has(week) ? logp(1 - (1 - winProb) * (1 - credit)) : logp(winProb);
}

/** Whether a path ever takes both sides of one game in the same week. */
function conflictFree(weeks, picks) {
  for (const week of weeks) {
    const teams = picks[week.week] ?? [];
    for (const team of teams) {
      const option = week.options.find((o) => o.team === team);
      if (option && teams.includes(option.opponent)) return false;
    }
  }
  return true;
}

/** The discount levels to search at: none, what a buy back is worth, and free. */
function ladder(share) {
  return [...new Set([share, (share + 1) / 2, 1])];
}

/** Exact survival for a finished path, using the same maths as the board. */
function survivalOfPath({ weeks, path, buyBackWeeks, buyBacks }) {
  const picks = [];

  for (const week of weeks) {
    for (const team of path[week.week] ?? []) {
      const option = week.options.find((o) => o.team === team);
      picks.push({ week: week.week, winProb: option?.winProb ?? 0.5, result: null });
    }
  }

  return survival({ picks, buyBackWeeks, buyBacks }).probability;
}

/**
 * Validate a specific path, or null when it breaks the no-repeat rule or names
 * a game that is not there. Scored like every other finalist, on survival.
 */
function scorePath({ weeks, burned, path, picksPerWeek }) {
  const used = new Set(burned);
  const picks = {};

  for (const week of weeks) {
    const teams = path[week.week] ?? [];
    if (teams.length !== picksPerWeek) return null;
    // A locked slot is not the path's to fill: it must carry the locked team,
    // which sits in `burned` for every other week's sake and is let through
    // here for its own.
    const fixed = (week.fixed ?? []).filter(Boolean);
    if (!fixed.every((team) => teams.includes(team))) return null;
    for (const team of teams) {
      if (used.has(team) && !fixed.includes(team)) return null;
      if (!week.options.some((o) => o.team === team)) return null;
      used.add(team);
    }
    picks[week.week] = [...teams];
  }

  return { used, score: 0, picks, shortfalls: [] };
}

/** A candidate extension, cheap enough to make ten thousand of. */
function propose(parent, teams, score, shortfall = false) {
  return { parent, teams, score: parent.score + score, shortfall };
}

/** Turn a surviving proposal into a real beam, paying for the copies now. */
function materialise({ parent, teams, score, shortfall }, week) {
  const used = new Set(parent.used);
  for (const team of teams) used.add(team);

  return {
    used,
    score,
    picks: { ...parent.picks, [week]: teams },
    shortfalls: shortfall ? [...parent.shortfalls, week] : parent.shortfalls,
  };
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sorted = [...b].sort();
  return [...a].sort().every((value, index) => value === sorted[index]);
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function quantile(values, q) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[position];
}

/**
 * Everything a search needs, as plain data, and nothing else.
 *
 * A slot is FIXED when a user locked it - the recommendation has to work
 * around a decision you have committed to, not pretend you can take it back.
 * An unlocked pick is not fixed: the coach plans as if the slot were open, so
 * trying a team out costs nothing, and locking is what makes it re-plan.
 *
 * Pulled out of recommendForBoard so a search can be handed to a worker
 * (core/search.js): what crosses that boundary is this request, which is the
 * weeks from the current one on with their options and their fixed slots, and
 * not the board it came from - a board carries every past week, every slot's
 * annotated copy of the week's list and a plan for each of them, none of which
 * the search reads.
 *
 * @param {object} board From buildBoard, far enough along to carry weeks,
 *   options and locks.
 * @param {object|null} [seed] A path to compete as a finalist.
 * @param {object} [options]
 * @param {boolean|((pick:object) => boolean)} [options.holdPicks] Treat a
 *   picked slot the way a locked one is treated - its team placed and spent -
 *   to see what locking it would do. True holds every picked slot; a function
 *   says which slots are held, locks included, and is what a rehearsal of one
 *   lock passes (core/plan.js). Off, only locks constrain the search.
 * @param {boolean} [options.quick] The assignment alone; see recommendPath.
 * @returns {object} The arguments recommendPath takes.
 */
export function searchRequestFor(board, seed = null, { holdPicks = false, quick = false } = {}) {
  const burned = new Set();
  const upcoming = [];
  const { picksPerWeek, buyBackWeeks, buyBacks } = board.rules;
  const held =
    typeof holdPicks === "function"
      ? holdPicks
      : (pick) => pick.status.locked || (holdPicks && Boolean(pick.team));

  for (const week of board.weeks) {
    const isPast = week.week < board.currentWeek;

    for (const pick of week.picks) {
      if (held(pick)) burned.add(pick.team);
    }

    if (isPast) continue;

    const fixed = week.picks.map((pick) => (held(pick) ? pick.team : null));
    upcoming.push({
      week: week.week,
      // A game already played is not a pick anyone can still make, so it is no
      // candidate: advising it would put a badge on a row the board disables.
      // A locked slot's team stays in the list even once its game is final,
      // because `fixed` places it rather than choosing it and the search still
      // needs its number to score the path.
      options: week.options.filter((option) => !option.result || fixed.includes(option.team)),
      fixed,
    });
  }

  // A team locked in a future week stays in `burned`, which keeps any
  // earlier week from spending it. Its own slot still gets it, because fixed
  // teams are placed directly rather than drawn from the candidate pool.
  // A buy back already spent is gone, so the recommendation stops taking risks
  // it can no longer afford.
  return {
    weeks: upcoming,
    burned,
    picksPerWeek,
    buyBackWeeks,
    buyBacks: board.buyBack?.left ?? buyBacks,
    seed,
    model: board.model ?? DEFAULT_MODEL,
    scenarios: quick ? 0 : (board.scenarioCount ?? SCENARIO_COUNT),
    quick,
    // Every probability on the board is already the chance the pick carries
    // the week, so the search needs this for one thing only: the futures it
    // draws re-price their own spreads.
    objective: board.rules?.objective ?? "win",
    // The pool's field, for the frontier's leverage. The pool's own grant of
    // buy backs is the field's cushion, whatever this entry has left.
    pool: board.pool ?? null,
    poolBuyBacks: buyBacks,
  };
}

/**
 * Search for a board, here and now.
 *
 * What the scripts and the validators call, and what the browser falls back to
 * when there is nowhere to hand the search to.
 *
 * @param {object} board Result of buildBoard().
 * @param {object|null} [seed] A path to compete as a finalist.
 * @param {object} [options] As searchRequestFor.
 * @returns {{picks:Object<number,string[]>, pathProbability:number, shortfalls:number[],
 *            frontier:object|null}}
 */
export function recommendForBoard(board, seed = null, options = {}) {
  return recommendPath(searchRequestFor(board, seed, options));
}
