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
 * Method: beam search over weeks. Exact search is infeasible - the state is
 * the set of teams already spent, so the space is 2^50 - but a beam keeps the
 * coupling between weeks that a greedy pass throws away.
 */

import { survival } from "./survival.js";

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

/** Probabilities multiply, so we add logs and avoid underflow across 26 picks. */
const logp = (p) => Math.log(Math.max(p, 1e-9));

/**
 * @param {object} args
 * @param {Array} args.weeks  [{week, options:[{team,winProb,...}], fixed:[teamOrNull,teamOrNull]}]
 * @param {Set<string>} args.burned Teams already spent and unavailable.
 * @param {number} args.picksPerWeek
 * @param {number[]} args.buyBackWeeks Weeks where a loss is forgiven.
 * @param {number} args.buyBacks How many losses the pool forgives in total.
 * @returns {{picks:Object<number,string[]>, pathProbability:number, shortfalls:number[]}}
 */
export function recommendPath({
  weeks,
  burned,
  picksPerWeek = 2,
  buyBackWeeks = [],
  buyBacks = 0,
  seed = null,
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
    finalists.push(...search(credit).slice(0, FINALISTS));
  }

  // The path already on the board competes on equal terms, so the
  // recommendation can never come back worse than what you already have.
  if (seed) {
    const seeded = scorePath({ weeks, burned, path: seed, picksPerWeek });
    if (seeded) finalists.push(seeded);
  }

  if (finalists.length === 0) return { picks: {}, pathProbability: 0, shortfalls: [] };

  let best = null;
  for (const beam of finalists) {
    beam.survival = survivalOfPath({ weeks, path: beam.picks, buyBackWeeks, buyBacks });
    if (!best || beam.survival > best.survival) best = beam;
  }

  return {
    picks: best.picks,
    pathProbability: best.survival,
    shortfalls: best.shortfalls,
  };

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

    const estimateRemaining = (used, fromIndex) => {
      let total = 0;
      for (let i = fromIndex; i < pools.length; i += 1) {
        let taken = 0;
        for (const entry of pools[i]) {
          if (used.has(entry.team)) continue;
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

      const ranked = [...week.options]
        .filter((option) => !fixed.includes(option.team))
        .sort((a, b) => b.winProb - a.winProb);

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

        for (let i = 0; i < available.length; i += 1) {
          for (let j = i + 1; j < available.length; j += 1) {
            const a = available[i];
            const b = available[j];
            next.push(
              propose(beam, [...fixed, a.team, b.team], fixedScore + lp(a.winProb) + lp(b.winProb)),
            );
          }
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
    for (const team of teams) {
      if (used.has(team)) return null;
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

/**
 * Shape a built board into the recommender's input and run it.
 *
 * A slot is FIXED when a user selected it or it is already resolved - the recommendation
 * has to work around a decision you have already committed to, not pretend
 * you can take it back.
 *
 * @param {object} board Result of buildBoard().
 * @returns {{picks:Object<number,string[]>, pathProbability:number, shortfalls:number[]}}
 */
export function recommendForBoard(board, seed = null) {
  const burned = new Set();
  const upcoming = [];
  const { picksPerWeek, buyBackWeeks, buyBacks } = board.rules;

  for (const week of board.weeks) {
    const isPast = week.week < board.currentWeek;

    for (const pick of week.picks) {
      const committed = pick.status.selected;
      if (committed) burned.add(pick.team);
    }

    if (isPast) continue;

    upcoming.push({
      week: week.week,
      options: week.options,
      fixed: week.picks.map((pick) => (pick.status.selected ? pick.team : null)),
    });
  }

  // A team selected in a future week stays in `burned`, which keeps any
  // earlier week from spending it. Its own slot still gets it, because fixed
  // teams are placed directly rather than drawn from the candidate pool.
  // A buy back already spent is gone, so the recommendation stops taking risks
  // it can no longer afford.
  return recommendPath({
    weeks: upcoming,
    burned,
    picksPerWeek,
    buyBackWeeks,
    buyBacks: board.buyBack?.left ?? buyBacks,
    seed,
  });
}
