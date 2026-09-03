/**
 * Domain model.
 *
 * Three inputs come together here, all scoped to the league that is open:
 *   plan   - data/<league>/plan.json, the season path and the pool's rules
 *   odds   - data/<league>/odds.json, market overrides from the refresh workflow
 *   entry  - the shared user state (locks, results, swaps) from the store
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

/** Stable key for a pick slot. Also the key format used in data/odds.json. */
export function slotKey(week, slot) {
  return `${week}-${slot}`;
}

/**
 * Key for a market line in data/odds.json. Keyed by team rather than by slot
 * so a line can be found for any team the user swaps to, not just the two the
 * plan happened to name.
 */
export function lineKey(week, team) {
  return `${week}|${team}`;
}

/**
 * Resolve one slot into the pick that is actually live, applying any market
 * line and any backup the users have swapped in.
 *
 * @returns {{team:string, opponent:string, site:string, spread:number,
 *            source:string, winProb:number, tier:string, rationale:string,
 *            isSwapped:boolean, conference:string}}
 */
function resolvePick({ weekPlan, odds, entry, teams, options, week, slot, tiers }) {
  // A swap stores the chosen TEAM. Anything else (including the old numeric
  // backup index) is treated as "no swap", so stale entries degrade quietly.
  const swapped = entry.swaps?.[slotKey(week, slot)];
  const chosen =
    typeof swapped === "string" ? options.find((option) => option.team === swapped) : null;
  const isSwapped = Boolean(chosen);

  const planPick = weekPlan.picks[slot];
  const base = chosen ?? options.find((option) => option.team === planPick.team) ?? planPick;

  const line = odds.lines?.[lineKey(week, base.team)];
  const spread = line?.spread ?? base.spread;
  const source = line ? "market" : (base.source ?? "projected");
  const winProb = line?.winProb ?? winProbFromSpread(spread);

  return {
    week,
    slot,
    team: base.team,
    opponent: base.opponent,
    site: base.site,
    conference: conferenceOf(teams, base.team),
    spread,
    source,
    winProb,
    tier: confidenceTier(winProb, tiers),
    isSwapped,
  };
}

/**
 * Every team a slot could legally hold this week: anyone in an eligible
 * conference with a game against a rated opponent. A team missing from
 * ratings.json is outside the league we price, which in college means FCS and
 * makes that game an invalid pick.
 *
 * Spread comes from the market when odds.json has a line for the team,
 * otherwise it is projected from the power ratings.
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
 *   `recommendationPending` set, and the caller is expected to paint it and
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

  // Pass one: resolve what each slot actually holds. Options for a week are
  // built once and shared by every slot in it.
  const weeks = plan.weeks.map((weekPlan) => {
    const options = weekOptions({ schedule, ratings, teams, odds, week: weekPlan.week });

    const picks = slots.map((slot) => {
      const pick = resolvePick({
        weekPlan,
        odds,
        entry,
        teams,
        options,
        week: weekPlan.week,
        slot,
        tiers: rules.tiers,
      });
      const saved = entry.picks?.[slotKey(weekPlan.week, slot)] ?? {};
      // A result you set by hand always wins. Otherwise the refresh job's
      // recorded final stands, so the board keeps up on its own.
      const fetched = odds.results?.[lineKey(weekPlan.week, pick.team)] ?? null;
      const status = {
        ...saved,
        result: saved.result ?? fetched,
        resultSource: saved.result ? "you" : fetched ? "final" : null,
      };
      return { ...pick, status, planTeam: weekPlan.picks[slot].team };
    });

    return {
      week: weekPlan.week,
      label: weekPlan.label,
      // Every date shown in the UI carries its year, so a label is never
      // ambiguous once a screenshot leaves the app.
      labelFull: `${weekPlan.label}, ${plan.season}`,
      kickoff: weekPlan.kickoff,
      options,
      picks,
      // Chance the week is survived outright. With one pick that is just the
      // pick; with two it is both holding.
      weekWinProb: picks.reduce((total, pick) => total * pick.winProb, 1),
      isBuyBack: rules.buyBackWeeks.includes(weekPlan.week),
    };
  });

  // A swap can put the same team in two weeks, which breaks the pool's core
  // rule. Detect it rather than letting the burn board quietly under-count.
  const spentTeams = {};
  const conflicts = [];
  for (const week of weeks) {
    for (const pick of week.picks) {
      if (spentTeams[pick.team] !== undefined) {
        conflicts.push({ team: pick.team, weeks: [spentTeams[pick.team], week.week] });
      } else {
        spentTeams[pick.team] = week.week;
      }
    }
  }

  // Pass two: now that every week is resolved, annotate each option with why
  // it may not be available - taken by the other slot, or spent another week.
  for (const week of weeks) {
    for (const pick of week.picks) {
      // Every other slot this week. Empty in a one-pick league.
      const siblings = new Set(
        week.picks.filter((other) => other.slot !== pick.slot).map((other) => other.team),
      );
      // Sorted by spread, but anything unavailable sinks to the bottom - the
      // top of the list should be teams you can actually take.
      pick.options = week.options
        .map((option) => {
          const spentWeek = spentTeams[option.team];
          const takenBySibling = siblings.has(option.team);
          const usedElsewhere = spentWeek !== undefined && spentWeek !== week.week;
          return {
            ...option,
            tier: confidenceTier(option.winProb, rules.tiers),
            isCurrent: option.team === pick.team,
            isPlan: option.team === pick.planTeam,
            disabled: takenBySibling || usedElsewhere,
            reason: takenBySibling
              ? "other slot this week"
              : usedElsewhere
                ? `used week ${spentWeek}`
                : "",
          };
        })
        .sort((a, b) => {
          if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
          if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
          return a.spread - b.spread;
        });
    }
  }

  // Survival is not just the product of what is left: a buy back week can be
  // lost and played through. core/survival.js owns that maths.
  const outcome = survival({
    picks: weeks.flatMap((week) =>
      week.picks.map((pick) => ({
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
  const threshold = plan.dangerThreshold ?? -10;

  const flagged = [];
  for (const week of weeks) {
    if (week.week < currentWeek) continue;
    for (const pick of week.picks) {
      if (pick.status.result) continue;
      if (pick.spread > threshold)
        flagged.push({ week: week.week, team: pick.team, spread: pick.spread });
    }
  }

  const board = {
    weeks,
    rules,
    currentWeek,
    spentTeams,
    spentCount: Object.keys(spentTeams).length,
    totalTeams: Object.keys(allTeams(teams)).length,
    record: outcome.record,
    eliminated: outcome.eliminated,
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
    flagged,
    conflicts,
    updatedAt: odds.updatedAt,
    nextRefreshAt: nextRefresh,
  };

  // The recommendation is the expensive part of a build (a beam search over
  // the remaining weeks), and it depends only on the week, what is committed,
  // and the odds - NOT on the free selections you are still moving around. So
  // it is memoised on those, and a swap re-renders instantly.
  const cached = memoisedRecommendation(board, plan, odds, allowSearch);
  const recommendation = cached ?? { picks: {}, pathProbability: 0, shortfalls: [] };
  board.recommendation = recommendation;
  board.recommendationPending = cached === null;

  for (const week of board.weeks) {
    const teams = recommendation.picks[week.week] ?? [];
    week.recommended = teams.map((team) => week.options.find((o) => o.team === team) ?? { team });
    // Compare as a set: slot order carries no meaning.
    const chosen = week.picks.map((pick) => pick.team).sort();
    week.matchesRecommendation =
      teams.length === chosen.length && [...teams].sort().every((t, i) => t === chosen[i]);

    for (const pick of week.picks) {
      pick.isRecommended = teams.includes(pick.team);
    }
  }

  return board;
}

let recommendationCache = { signature: null, value: null };

function memoisedRecommendation(board, plan, odds, allowSearch) {
  const committed = [];
  for (const week of board.weeks) {
    for (const pick of week.picks) {
      if (pick.status.locked || pick.status.result) {
        committed.push(`${week.week}:${pick.slot}:${pick.team}:${pick.status.result ?? "L"}`);
      }
    }
  }

  const signature = [
    // The league is part of the key: switching swaps every input at once, and
    // two boards must never share a cached path.
    plan.league ?? "cfb",
    board.currentWeek,
    board.buyBack?.left ?? 0,
    odds.updatedAt,
    Object.keys(odds.lines ?? {}).length,
    committed.join(","),
  ].join("|");
  if (recommendationCache.signature === signature) return recommendationCache.value;
  // Nothing cached for this board and the caller does not want to wait.
  if (!allowSearch) return null;

  // Seeded with the authored plan rather than the live selection, so the
  // result stays stable while you try swaps out.
  const seed = {};
  for (const weekPlan of plan.weeks) {
    if (weekPlan.week < board.currentWeek) continue;
    seed[weekPlan.week] = weekPlan.picks.map((pick) => pick.team);
  }

  const value = recommendForBoard(board, seed);
  recommendationCache = { signature, value };
  return value;
}

function clampWeek(week, total) {
  return Math.min(Math.max(Math.round(week) || 1, 1), total);
}
