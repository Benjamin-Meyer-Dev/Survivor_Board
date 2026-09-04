/**
 * Domain model.
 *
 * Three inputs come together here, all scoped to the league that is open:
 *   plan   - data/<league>/plan.json: the pool's rules, the season calendar,
 *            and an authored path that seeds the optimiser
 *   odds   - data/<league>/odds.json, market lines from the refresh workflow
 *   entry  - the shared user state (picks, locks, results) from the store
 *
 * Every slot on the board is user-picked. The coach never fills one: it makes
 * suggestions, and those ride alongside the slot for the UI to badge or ghost.
 * Locking a pick is what commits it, and the coach re-plans the rest of the
 * season around whatever is locked.
 *
 * Everything the UI renders is derived from `buildBoard`, including how many
 * picks a week holds and whether a loss can be bought back. No module below
 * src/js/ui/ should reach into the raw JSON directly, and none of them should
 * know which league is loaded.
 */

import { winProbFromSpread, confidenceTier, projectSpread, DEFAULT_TIERS } from "./probability.js";
import { recommendForBoard } from "./recommend.js";
import { nextRefreshAt } from "./refresh.js";
import { survival } from "./survival.js";

/**
 * Pool rules, read from data/<league>/plan.json.
 *
 * The college pool takes two picks a week and forgives nothing. The NFL pool
 * takes one and grants a single buy back covering weeks 1 and 2. Everything
 * downstream reads these rather than assuming a league.
 */
export function rulesOf(plan) {
  const rules = plan.rules ?? {};
  return {
    picksPerWeek: rules.picksPerWeek ?? 2,
    buyBackWeeks: rules.buyBackWeeks ?? [],
    buyBacks: rules.buyBacks ?? 0,
    // Win probabilities, not spreads: see confidenceTier.
    tiers: plan.tiers ?? DEFAULT_TIERS,
  };
}

/** The shape every store returns when there is nothing saved yet. */
export const EMPTY_ENTRY = Object.freeze({ picks: {}, swaps: {} });

/** A fresh, mutable copy of the empty entry. */
export function emptyEntry() {
  return { picks: {}, swaps: {} };
}

/**
 * Whether two entries hold the same picks, whatever order their keys are in.
 * A round trip through a store can reorder keys (jsonb does) without changing
 * a thing, and the board should not repaint for that.
 */
export function sameEntry(a, b) {
  return canonical(a) === canonical(b);
}

/** JSON with object keys sorted, so equal values serialise identically. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Stable key for a pick slot. Also the key format used in data/odds.json. */
export function slotKey(week, slot) {
  return `${week}-${slot}`;
}

/**
 * Key for a market line in data/odds.json. Keyed by team rather than by slot
 * so a line can be found for any team the users pick, not just the ones the
 * authored plan happened to name.
 */
export function lineKey(week, team) {
  return `${week}|${team}`;
}

/**
 * Resolve one slot into the pick it holds: the team the users put there, priced
 * off the market line when there is one.
 *
 * A slot nobody has picked is empty (`team: null`). The coach's suggestion for
 * it is attached later, once the recommendation has run, and never becomes the
 * pick by itself.
 *
 * @returns {{team:string|null, status:{picked:boolean, locked:boolean,
 *            result:"W"|"L"|null, resultSource:"you"|"final"|null}}} plus, when
 *   a team is held: opponent, site, conference, spread, source, winProb, tier.
 */
function resolvePick({ weekPlan, odds, entry, teams, options, week, slot, tiers }) {
  const key = slotKey(week, slot);
  const saved = entry.picks?.[key] ?? {};
  // `locked` is the persisted name for a committed pick. A result implies one:
  // a game cannot be won or lost by a slot nobody picked.
  const locked = Boolean(saved.locked || saved.result);

  // `swaps` holds the team picked for each slot. The name predates slots being
  // user-picked, when it held only departures from the authored plan, and is
  // kept so saved entries keep loading. Anything that is not a team playing
  // this week counts as no pick, so a stale entry degrades quietly.
  const picked = entry.swaps?.[key];
  let base =
    typeof picked === "string" ? options.find((option) => option.team === picked) : undefined;

  // Entries saved before slots were user-picked could lock the authored plan's
  // team without storing it. That is still a lock on that team.
  if (!base && locked) {
    const planPick = weekPlan.picks?.[slot];
    base = options.find((option) => option.team === planPick?.team) ?? planPick;
  }

  if (!base) {
    return {
      week,
      slot,
      team: null,
      status: { picked: false, locked: false, result: null, resultSource: null },
    };
  }

  const line = odds.lines?.[lineKey(week, base.team)];
  const spread = line?.spread ?? base.spread;
  const winProb = line?.winProb ?? winProbFromSpread(spread);
  // Results are the refresh job's recorded finals, so a locked pick keeps up on
  // its own. A result saved in the entry, from when they were tapped in, is
  // still honoured and still wins. An unlocked pick never receives one: the
  // feed cannot commit a choice for you.
  const fetched = locked ? (odds.results?.[lineKey(week, base.team)] ?? null) : null;

  return {
    week,
    slot,
    team: base.team,
    opponent: base.opponent,
    site: base.site,
    conference: conferenceOf(teams, base.team),
    spread,
    source: line ? "market" : (base.source ?? "projected"),
    winProb,
    tier: confidenceTier(winProb, tiers),
    status: {
      ...saved,
      picked: true,
      locked,
      result: saved.result ?? fetched,
      resultSource: saved.result ? "you" : fetched ? "final" : null,
    },
  };
}

/**
 * Every team a slot could legally hold this week: anyone in an eligible
 * conference with a game against a rated opponent. A team missing from
 * ratings.json is outside the league we price, which in college means FCS and
 * makes that game an invalid pick.
 *
 * Spread comes from the market when odds.json has a line for the team,
 * otherwise it is projected from the power ratings. An option also carries how
 * its game went, once the refresh job has recorded a final: a played game is
 * no longer a choice, so it leaves the coach's pool and the list shows the
 * outcome where the line used to be.
 */
function weekOptions({ schedule, ratings, teams, odds, week }) {
  const games = schedule.weeks?.[String(week)] ?? [];
  const eligible = allTeams(teams);
  const home = ratings.homeFieldPoints ?? 2.5;
  const options = [];

  for (const game of games) {
    for (const [team, opponent] of [
      [game.home, game.away],
      [game.away, game.home],
    ]) {
      if (!(team in eligible)) continue;
      if (!(opponent in ratings.ratings)) continue; // FCS opponent - not a legal pick

      const site = game.neutral ? "Neutral" : team === game.home ? "Home" : "Away";
      const line = odds.lines?.[lineKey(week, team)];
      const spread =
        line?.spread ??
        projectSpread(
          eligible[team].rating,
          ratings.ratings[opponent],
          site === "Home",
          site === "Neutral" ? 0 : home,
        );

      options.push({
        team,
        opponent,
        site,
        spread,
        source: line ? "market" : "projected",
        winProb: line?.winProb ?? winProbFromSpread(spread),
        conference: eligible[team].conference,
        // "W", "L", or null while the game is still to come. Unlike a pick's
        // result this needs no lock: it is a fact about the fixture, not about
        // anyone's entry, which is why it shows on every row in the list.
        result: odds.results?.[lineKey(week, team)] ?? null,
      });
    }
  }

  return options.sort((a, b) => a.spread - b.spread);
}

/** Which conference a team belongs to, or "" if it is not eligible. */
export function conferenceOf(teams, team) {
  for (const [conference, roster] of Object.entries(teams.conferences)) {
    if (team in roster) return conference;
  }
  return "";
}

/** Flat map of every eligible team to its power rating. */
export function allTeams(teams) {
  const out = {};
  for (const [conference, roster] of Object.entries(teams.conferences)) {
    for (const [team, rating] of Object.entries(roster)) {
      out[team] = { rating, conference };
    }
  }
  return out;
}

/** The fields of a pick or an option that describe its game, and nothing else. */
function lineOf(pick) {
  const { team, opponent, site, conference, spread, source, winProb, tier } = pick;
  return { team, opponent, site, conference, spread, source, winProb, tier };
}

/**
 * Build the full derived board the UI renders from.
 *
 * @param {object} args
 * @param {object} args.plan  data/<league>/plan.json
 * @param {object} args.odds  data/<league>/odds.json
 * @param {object} args.teams data/<league>/teams.json
 * @param {object} args.entry shared user state
 * @param {boolean} args.allowSearch Pass false to build without running the
 *   optimiser when its answer is not already cached. The board comes back with
 *   `recommendationPending` set and the previous plan standing in where there
 *   is one (`recommendationStale`), and the caller is expected to paint it and
 *   then build again. The search takes a few hundred milliseconds and blocks
 *   the main thread, so this is what stops a league switch freezing mid-fade.
 */
export function buildBoard({
  plan,
  odds,
  teams,
  schedule,
  ratings,
  entry,
  refreshSchedule,
  allowSearch = true,
}) {
  const rules = rulesOf(plan);
  const slots = Array.from({ length: rules.picksPerWeek }, (_, index) => index);

  // Pass one: resolve what each slot holds. Options for a week are built once
  // and shared by every slot in it.
  const weeks = plan.weeks.map((weekPlan) => {
    const options = weekOptions({ schedule, ratings, teams, odds, week: weekPlan.week });
    const picks = slots.map((slot) =>
      resolvePick({
        weekPlan,
        odds,
        entry,
        teams,
        options,
        week: weekPlan.week,
        slot,
        tiers: rules.tiers,
      }),
    );

    return {
      week: weekPlan.week,
      label: weekPlan.label,
      // Every date shown in the UI carries its year, so a label is never
      // ambiguous once a screenshot leaves the app.
      labelFull: `${weekPlan.label}, ${plan.season}`,
      kickoff: weekPlan.kickoff,
      options,
      picks,
      isBuyBack: rules.buyBackWeeks.includes(weekPlan.week),
    };
  });

  // Only locked picks spend teams. An unlocked pick is still being weighed and
  // the coach's advice is only advice, so neither can burn a team or create a
  // rule conflict.
  const spentTeams = {};
  const conflicts = [];
  for (const week of weeks) {
    for (const pick of week.picks) {
      if (!pick.status.locked) continue;
      if (spentTeams[pick.team] !== undefined) {
        conflicts.push({ team: pick.team, weeks: [spentTeams[pick.team], week.week] });
      } else {
        spentTeams[pick.team] = week.week;
      }
    }
  }

  // Pass two: annotate each slot's options with why one may be unavailable -
  // held by the other slot this week, or locked in another week. Whether the
  // coach likes an option is filled in below, once the recommendation is known.
  for (const week of weeks) {
    for (const pick of week.picks) {
      // Every other slot's team this week. Empty in a one-pick league.
      const siblings = new Set(
        week.picks
          .filter((other) => other.slot !== pick.slot && other.team)
          .map((other) => other.team),
      );
      // Sorted by spread. A team locked in another week sinks to the bottom, so
      // the top of the list is teams you can actually take, and that order only
      // moves on a lock, when a reshuffle is expected. Nothing about an
      // unlocked pick affects the order: the team in the slot and a team held
      // by the other slot this week keep their place, so a tap on the list
      // never rearranges it under the thumb that made it.
      const spentElsewhere = (team) =>
        spentTeams[team] !== undefined && spentTeams[team] !== week.week;
      // A row you cannot take sinks to the bottom, so the top of the list is
      // teams you can actually have. The slot's own team is the exception and
      // keeps its place even once its game is final, so a tap on the list
      // never rearranges it under the thumb that made it.
      const sunk = (option) =>
        !option.isCurrent && (spentElsewhere(option.team) || Boolean(option.result));
      pick.options = week.options
        .map((option) => {
          const takenBySibling = siblings.has(option.team);
          const usedElsewhere = spentElsewhere(option.team);
          // Its game is over, so there is nothing left to pick here. Only for
          // this week: the team's other fixtures are still ahead of it.
          const settled = option.result;
          return {
            ...option,
            tier: confidenceTier(option.winProb, rules.tiers),
            isCurrent: option.team === pick.team,
            isCoach: false,
            disabled: Boolean(settled) || takenBySibling || usedElsewhere,
            reason: settled
              ? settled === "W"
                ? "Won"
                : "Lost"
              : takenBySibling
                ? "other slot this week"
                : usedElsewhere
                  ? `locked week ${spentTeams[option.team]}`
                  : "",
          };
        })
        .sort((a, b) => {
          const aSunk = sunk(a);
          const bSunk = sunk(b);
          if (aSunk !== bSunk) return aSunk ? 1 : -1;
          return a.spread - b.spread;
        });
    }
  }

  // Results live only on locked picks, so the record and the buy backs come
  // from what the users hold. The season number is worked out further down,
  // once the coach has filled in the open slots. core/survival.js owns the
  // maths either way: a buy back week can be lost and played through.
  const outcome = survival({
    picks: weeks.flatMap((week) =>
      week.picks
        .filter((pick) => pick.team)
        .map((pick) => ({
          week: week.week,
          winProb: pick.winProb,
          result: pick.status.result ?? null,
        })),
    ),
    buyBackWeeks: rules.buyBackWeeks,
    buyBacks: rules.buyBacks,
  });

  const currentWeek = clampWeek(odds.currentWeek ?? 1, plan.weeks.length);
  const nextRefresh = nextRefreshAt(Date.now(), refreshSchedule);

  const board = {
    // Which pool this is, for anything in the UI that remembers across renders
    // and must not carry one league's state onto the other's board.
    league: plan.league ?? "cfb",
    weeks,
    rules,
    currentWeek,
    spentTeams,
    spentCount: Object.keys(spentTeams).length,
    totalTeams: Object.keys(allTeams(teams)).length,
    record: outcome.record,
    eliminated: outcome.eliminated,
    // The week of the loss that ended the run, and the loss itself. The UI
    // goes into review on these: nothing more to pick or lock, the deck opened
    // on that week, later weeks marked as never played.
    eliminatedWeek: outcome.eliminatedWeek,
    elimination: eliminationOf(weeks, outcome),
    pathProbability: outcome.probability,
    // Null when the pool grants none, so the UI can simply omit the cell.
    buyBack: rules.buyBacks
      ? {
          total: rules.buyBacks,
          used: outcome.buyBacksUsed,
          left: outcome.buyBacksLeft,
          weeks: rules.buyBackWeeks,
        }
      : null,
    conflicts,
    updatedAt: odds.updatedAt,
    nextRefreshAt: nextRefresh,
  };

  // The recommendation is the expensive part of a build (a beam search over
  // the remaining weeks), and it depends only on the week, what is locked, and
  // the odds - NOT on the unlocked picks you are still weighing. So it is
  // memoised on those: locking or unlocking re-plans, picking does not.
  const {
    value: cached,
    fresh,
    constraints,
  } = memoisedRecommendation(board, plan, odds, allowSearch);
  const recommendation = cached ?? { picks: {}, pathProbability: 0, shortfalls: [] };
  board.recommendation = recommendation;
  // A search is still owed; app.js schedules it once this board is painted.
  board.recommendationPending = !fresh;
  // Meanwhile a recent plan is what is painted, not a blank (see
  // memoisedRecommendation). Its badges always show. Its numbers show only if
  // it still fills every open week: a team it planned for a later week may
  // since have been locked into this one, and a path with a week missing reads
  // higher than any real path, not lower. Settled below, once that is known.
  let standInComplete = !fresh && cached !== null;

  for (const week of board.weeks) {
    const lockedTeams = new Set(
      week.picks.filter((pick) => pick.status.locked).map((pick) => pick.team),
    );
    // Two names a stand-in plan can carry that a fresh search never would: a
    // team locked into another week since the plan was made, and a lock the
    // plan was made around that has since been undone. Neither is the coach's
    // call, so neither wears the badge for the beat before the search lands.
    const planned = (recommendation.picks[week.week] ?? []).filter(
      (team) =>
        (spentTeams[team] === undefined || spentTeams[team] === week.week) &&
        (lockedTeams.has(team) || !constraints.has(`${week.week}:${team}`)),
    );
    // And one name it can miss: a lock made since it was planned. On the path
    // a locked slot holds its team, so the locks go first and the plan's own
    // calls fill what is left. A fresh plan already names its locks, so for it
    // this changes nothing but the order.
    const names = [...lockedTeams, ...planned.filter((team) => !lockedTeams.has(team))].slice(
      0,
      rules.picksPerWeek,
    );
    // The optimizer's path contains locked teams because they are constraints,
    // not because the coach chose them. Keep that path separate from the calls
    // displayed as advice.
    week.pathRecommendation = names.flatMap((team) => {
      const option = week.options.find((o) => o.team === team);
      return option ? [{ ...option, tier: confidenceTier(option.winProb, rules.tiers) }] : [];
    });
    if (week.week >= currentWeek && week.pathRecommendation.length < rules.picksPerWeek) {
      standInComplete = false;
    }
    const liveCalls = week.pathRecommendation.filter((option) => !lockedTeams.has(option.team));
    const weekPlan = plan.weeks.find((candidate) => candidate.week === week.week);
    let next = 0;

    for (const pick of week.picks) {
      if (pick.status.locked) {
        // Snapshot on lock keeps the coach's actual pre-lock call visible. The
        // authored call is a safe fallback for entries locked before snapshots
        // were introduced.
        const historicTeam = pick.status.coachTeam ?? weekPlan?.picks[pick.slot]?.team;
        pick.coachCall = week.options.find((option) => option.team === historicTeam) ?? null;
      } else {
        pick.coachCall = liveCalls[next] ?? null;
        next += 1;
      }
    }

    const liveCoachTeams = new Set(liveCalls.map((option) => option.team));
    const coachCalls = week.picks.map((pick) => pick.coachCall).filter(Boolean);
    const coachTeams = new Set(coachCalls.map((option) => option.team));
    week.recommended = coachCalls.filter(
      (option, index) =>
        coachCalls.findIndex((candidate) => candidate.team === option.team) === index,
    );

    for (const pick of week.picks) {
      pick.isRecommended =
        Boolean(pick.team) && !pick.status.locked && liveCoachTeams.has(pick.team);
      pick.suggestion = pick.team ? null : pick.coachCall;
      for (const option of pick.options) option.isCoach = coachTeams.has(option.team);
    }

    // What the slot holds on the season path: the users' team if there is one,
    // else the coach's suggestion. `kind` tells the UI how solid to draw it.
    for (const pick of week.picks) {
      pick.onPath = pick.team
        ? { ...lineOf(pick), kind: pick.status.locked ? "locked" : "picked" }
        : pick.suggestion
          ? { ...lineOf(pick.suggestion), kind: "coach" }
          : null;
    }
    const onPath = week.picks.map((pick) => pick.onPath).filter(Boolean);
    week.pathWinProb = onPath.length
      ? onPath.reduce((total, pick) => total * pick.winProb, 1)
      : null;
    week.pathTier =
      week.pathWinProb === null ? null : confidenceTier(week.pathWinProb, rules.tiers);
  }

  /** A stand-in plan is painted and covers every open week, so its numbers hold. */
  board.recommendationStale = standInComplete;

  // Cumulative chance of being alive after each week on the visible path.
  // Before the current week only committed history counts; from the current
  // week onward this follows picks being weighed plus the coach's open slots.
  // Running the shared survival model on each prefix keeps buy backs and known
  // results identical to the headline calculation.
  const cumulativePicks = [];
  let pathComplete = true;
  for (const week of board.weeks) {
    const weekPath = week.picks.filter((pick) =>
      week.week < board.currentWeek ? pick.status.locked && pick.onPath : pick.onPath,
    );
    if (week.week >= board.currentWeek && weekPath.length !== rules.picksPerWeek) {
      pathComplete = false;
    }
    cumulativePicks.push(
      ...weekPath.map((pick) => ({
        week: week.week,
        winProb: pick.onPath.winProb,
        result: pick.status.result ?? null,
      })),
    );
    week.seasonWinProb = pathComplete
      ? survival({
          picks: cumulativePicks,
          buyBackWeeks: rules.buyBackWeeks,
          buyBacks: rules.buyBacks,
        }).probability
      : null;
    week.seasonTier =
      week.seasonWinProb === null ? null : confidenceTier(week.seasonWinProb, rules.tiers);
  }

  // First price the visible path, including any unlocked picks. This is a
  // preview only: trying a team must not move the committed headline number.
  const previewOutcome = survival({
    picks: board.weeks.flatMap((week) =>
      week.picks.flatMap((pick) =>
        pick.onPath
          ? [{ week: week.week, winProb: pick.onPath.winProb, result: pick.status.result ?? null }]
          : [],
      ),
    ),
    buyBackWeeks: rules.buyBackWeeks,
    buyBacks: rules.buyBacks,
  });

  // The committed number follows locked history plus the coach's current
  // recommendation. Since that recommendation ignores unlocked picks, this
  // stays still while users compare teams and changes only when one is locked.
  const committedPicks = [];
  for (const week of board.weeks) {
    if (week.week < board.currentWeek) {
      for (const pick of week.picks) {
        if (!pick.status.locked) continue;
        committedPicks.push({
          week: week.week,
          winProb: pick.winProb,
          result: pick.status.result ?? null,
        });
      }
      continue;
    }

    for (const option of week.pathRecommendation) {
      const locked = week.picks.find((pick) => pick.status.locked && pick.team === option.team);
      committedPicks.push({
        week: week.week,
        winProb: option.winProb,
        result: locked?.status.result ?? null,
      });
    }
  }

  const committedOutcome = survival({
    picks: committedPicks,
    buyBackWeeks: rules.buyBackWeeks,
    buyBacks: rules.buyBacks,
  });
  const hasUnlockedPick = board.weeks.some((week) =>
    week.picks.some((pick) => pick.team && !pick.status.locked),
  );
  board.pathProbability = committedOutcome.probability;
  board.previewPathProbability = hasUnlockedPick ? previewOutcome.probability : null;

  // The depth chart carries all three truths: crossed-out teams are locked,
  // outlined teams are picked but not yet locked, and ghosted teams are only
  // in the coach's plan.
  board.pickedTeams = {};
  board.plannedTeams = {};
  for (const week of board.weeks) {
    if (week.week < board.currentWeek) continue;
    for (const pick of week.picks) {
      const candidate = pick.onPath;
      if (!candidate || pick.status.result) continue;
      if (candidate.kind === "picked") board.pickedTeams[candidate.team] ??= week.week;
      if (candidate.kind === "coach" && spentTeams[candidate.team] === undefined) {
        board.plannedTeams[candidate.team] ??= week.week;
      }
    }
  }
  board.pickedCount = Object.keys(board.pickedTeams).length;
  board.plannedCount = Object.keys(board.plannedTeams).length;

  return board;
}

/**
 * The plans the search has produced lately, most recent first, each keyed on
 * everything the search depends on.
 *
 * More than one is kept because a lock and its undo are the common pair: the
 * unlock returns the board to a key that was just seen, so it is answered from
 * here with no search at all. And when the key is new and the caller cannot
 * wait, the closest of these plans stands in (see standInFor). Painting an
 * empty plan there instead made every coach badge, the season number and the
 * gameplan's open rows vanish for the beat between the tap and the search that
 * follows it, then come back.
 */
const CACHE_SIZE = 8;
let recommendationCache = [];

/** No stand-in constraints: every name in the plan is the coach's own call. */
const NO_CONSTRAINTS = new Set();

/**
 * @returns {{value: object|null, fresh: boolean, constraints: Set<string>}}
 *   `fresh` is false when the plan is a stand-in, or there is none, and a
 *   search is still owed. `constraints` lists, as "week:team", the locks the
 *   stand-in was planned around that are no longer locked: the plan's name for
 *   that week is a lock it obeyed, not a call it made, and must not be shown
 *   as one.
 */
function memoisedRecommendation(board, plan, odds, allowSearch) {
  // An eliminated entry has no season left to plan. The coach stands down and
  // the board goes into review: what happened, not what could.
  if (board.eliminated) {
    return {
      value: { picks: {}, pathProbability: 0, shortfalls: [] },
      fresh: true,
      constraints: NO_CONSTRAINTS,
    };
  }

  // The locked slots are the search's constraints. The result rides along in
  // the key because a win or a loss changes the path too.
  const locks = [];
  for (const week of board.weeks) {
    for (const pick of week.picks) {
      if (pick.status.locked) {
        locks.push({
          key: `${week.week}:${pick.slot}:${pick.team}`,
          week: week.week,
          team: pick.team,
          result: pick.status.result ?? "L",
        });
      }
    }
  }

  // Everything but the locks. Two plans with the same base differ only in what
  // is locked, which is what makes one a fair stand-in for the other. The
  // league is part of it: switching swaps every input at once, and two boards
  // must never share a cached path.
  const base = [
    plan.league ?? "cfb",
    board.currentWeek,
    board.buyBack?.left ?? 0,
    odds.updatedAt,
    Object.keys(odds.lines ?? {}).length,
  ].join("|");
  const signature = `${base}|${locks.map((lock) => `${lock.key}:${lock.result}`).join(",")}`;

  const hit = recommendationCache.find((entry) => entry.signature === signature);
  if (hit) {
    // To the front, so the two plans a toggle flips between outlive the rest.
    recommendationCache = [hit, ...recommendationCache.filter((entry) => entry !== hit)];
    return { value: hit.value, fresh: true, constraints: NO_CONSTRAINTS };
  }

  if (!allowSearch) return standInFor(base, locks);

  // The authored plan competes as one more finalist, so the coach never comes
  // back with a path worse than the one in plan.json. A locked slot takes the
  // locked team instead: the plan is only a proposal for the slots still open.
  const seed = {};
  for (const week of board.weeks) {
    if (week.week < board.currentWeek) continue;
    const weekPlan = plan.weeks.find((entry) => entry.week === week.week);
    seed[week.week] = week.picks.map((pick, slot) =>
      pick.status.locked ? pick.team : (weekPlan?.picks[slot]?.team ?? null),
    );
  }

  const value = recommendForBoard(board, seed);
  recommendationCache = [{ signature, base, locks, value }, ...recommendationCache].slice(
    0,
    CACHE_SIZE,
  );
  return { value, fresh: true, constraints: NO_CONSTRAINTS };
}

/**
 * The cached plan that stands in while the search for the current board waits.
 *
 * Preferred is a plan made under a subset of the current locks, the largest
 * such: every slot it planned freely is still free, so each of its calls is a
 * call the coach actually made. That is the plan from before a lock when the
 * lock is undone, or from before the latest lock when another is added. With no
 * subset to hand (the page opened with these locks already in place, say) the
 * most recent plan for the same base stands in, and its former locks come back
 * as constraints so those weeks show no call rather than the wrong one. A plan
 * for another base - another league, other odds - never stands in.
 */
function standInFor(base, locks) {
  const current = new Set(locks.map((lock) => lock.key));
  const candidates = recommendationCache.filter((entry) => entry.base === base);
  if (candidates.length === 0) return { value: null, fresh: false, constraints: NO_CONSTRAINTS };

  // Stable sort, so among equal sizes the more recent plan keeps its place.
  const subsets = candidates
    .filter((entry) => entry.locks.every((lock) => current.has(lock.key)))
    .sort((a, b) => b.locks.length - a.locks.length);
  const chosen = subsets[0] ?? candidates[0];
  const constraints = new Set(
    chosen.locks
      .filter((lock) => !current.has(lock.key))
      .map((lock) => `${lock.week}:${lock.team}`),
  );
  return { value: chosen.value, fresh: false, constraints };
}

/**
 * What ended the run: the week, and the locked loss (or losses, in a two-pick
 * league) in it. Null while the entry is alive.
 */
function eliminationOf(weeks, outcome) {
  if (!outcome.eliminated) return null;
  const week = weeks.find((entry) => entry.week === outcome.eliminatedWeek);
  const losses = (week?.picks ?? [])
    .filter((pick) => pick.status.locked && pick.status.result === "L")
    .map((pick) => ({ team: pick.team, opponent: pick.opponent, site: pick.site }));
  return { week: outcome.eliminatedWeek, losses };
}

function clampWeek(week, total) {
  return Math.min(Math.max(Math.round(week) || 1, 1), total);
}
