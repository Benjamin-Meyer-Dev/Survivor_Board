/**
 * The ghost run: what the coach would have done with a pool after it went out.
 *
 * A pool that loses is done, but the coach is not, and the season it would
 * have played is the honest test of it - one the pool's own run, ended by one
 * bad week, cannot give. So from the week after the loss the coach keeps a run
 * of its own for the pool: each week its call is frozen, kept in the pool's
 * shared entry under `ghost`, spends its team the way a lock would - no team
 * twice, the pool's own locks included - and is graded by the same finals the
 * real picks are. It plays to the end of the run whatever happens to it, so the
 * board can say both its record and the week it would itself have gone out.
 *
 * The one thing a ghost must not have is hindsight. Every call is made from the
 * board as it stood when the week began (`ghostInputs`): the lines the books
 * posted before the games, the weeks after it projected rather than priced, and
 * no result anywhere - not this week's, and not any week's, since a loss
 * earlier on would only put the board back into review. A call made while its
 * game is still to kick off is live, and is made again on every open until it
 * does, so the frozen call is the last one the coach made before the game. A
 * week nobody opened the app in is made afterwards the same way and marked as
 * rebuilt: the lines are the ones it would have had, but the ratings that
 * project the weeks after it are today's.
 *
 * Pure: the caller builds the boards and keeps the calls (app.js).
 */

import { slotKey } from "./plan.js";

/**
 * The weeks a knocked-out pool is owed a ghost call for, in order: every week
 * of its run after the loss up to the week on the clock with no call kept, and
 * the week on the clock again while its call has not kicked off.
 *
 * @param {object} board From buildBoard, for the pool as it really stands.
 * @param {object} entry The pool's shared entry.
 * @param {number} [now] For the kickoff check.
 * @returns {number[]}
 */
export function ghostOwed(board, entry, now = Date.now()) {
  if (!board?.eliminated || !Number.isFinite(board.eliminatedWeek)) return [];
  const kept = entry?.ghost ?? {};
  return board.weeks
    .map((week) => week.week)
    .filter((week) => week > board.eliminatedWeek && week <= board.currentWeek)
    .filter((week) => {
      const call = kept[week];
      if (!validCall(call)) return true;
      return week === board.currentWeek && !kickedOff(call, now);
    });
}

/**
 * Whether a call's game has kicked off: from then it is what the coach said,
 * not what it is saying.
 */
export function kickedOff(call, now = Date.now()) {
  if (!call?.live) return true;
  const at = Date.parse(call.kickoff ?? "");
  return !Number.isFinite(at) || at <= now;
}

/** A kept call that is a call: a week's teams, as text. */
export function validCall(call) {
  return (
    Boolean(call) &&
    Array.isArray(call.teams) &&
    call.teams.length > 0 &&
    call.teams.every((team) => typeof team === "string")
  );
}

/**
 * The board as it stood when a week began, for the ghost's call that week.
 *
 * The lines the books had posted by then - this week's and every week's
 * before it, which are what the games were played on - and none after it, so
 * the weeks ahead are projected the way they were. No results at all. The
 * pool's own locks and the ghost's calls before this week are locks, so their
 * teams are spent and the search plans around them; this week's ghost call,
 * if there is one, is not held, so the coach makes it again.
 *
 * @param {object} inputs What buildBoard takes for the pool.
 * @param {number} week
 * @returns {object} The same, as of the week.
 */
export function ghostInputs(inputs, week) {
  const { odds, entry } = inputs;
  const lines = Object.fromEntries(
    Object.entries(odds.lines ?? {}).filter(([key]) => Number(key.split("|")[0]) <= week),
  );
  const asOf = {
    ...odds,
    currentWeek: week,
    lines,
    results: {},
    scores: {},
    // Part of what the search is keyed on, so a ghost's board never stands in
    // for the pool's own.
    updatedAt: `${odds.updatedAt ?? ""}|ghost ${week}`,
  };

  const picks = {};
  const swaps = {};
  // The pool's locks: spent, and planned around. What the lock was saved with
  // beyond the team - a result typed in, the coach's board at the time - is
  // nothing the ghost's board should know.
  for (const [key, saved] of Object.entries(entry?.picks ?? {})) {
    if (!saved?.locked && !saved?.result) continue;
    picks[key] = { locked: true };
    if (typeof entry.swaps?.[key] === "string") swaps[key] = entry.swaps[key];
  }
  for (const [at, call] of Object.entries(entry?.ghost ?? {})) {
    const calledIn = Number(at);
    if (!(calledIn < week) || !validCall(call)) continue;
    call.teams.forEach((team, slot) => {
      const key = slotKey(calledIn, slot);
      if (picks[key]) return;
      picks[key] = { locked: true };
      swaps[key] = team;
    });
  }

  return {
    ...inputs,
    odds: asOf,
    entry: { picks, swaps, ...(entry?.rules ? { rules: entry.rules } : {}) },
    inHand: null,
  };
}

/**
 * The call a board as of a week makes that week, ready to keep: the teams,
 * what the coach put each at, when the first of them kicks off, and whether it
 * was made before then. Null when the coach has no call there.
 *
 * @param {object} board From buildBoard(ghostInputs(...)), with its plan.
 * @param {number} week
 * @param {number} [now]
 */
export function ghostCallFrom(board, week, now = Date.now()) {
  // A plan standing in for one still being worked out is an older board's
  // answer: a call is only kept from the search made for this one.
  if (board.recommendationPending) return null;
  const on = board.weeks.find((entry) => entry.week === week);
  const teams = (board.recommendation?.picks?.[week] ?? [])
    .filter((team) => on?.optionByTeam.has(team))
    .slice(0, board.rules.picksPerWeek);
  if (!on || teams.length === 0) return null;
  const options = teams.map((team) => on.optionByTeam.get(team));
  const kickoffs = options
    .map((option) => Date.parse(option.kickoff ?? ""))
    .filter(Number.isFinite);
  const first = kickoffs.length ? Math.min(...kickoffs) : null;
  return {
    teams,
    probs: options.map((option) => Number(option.winProb.toFixed(4))),
    kickoff: first === null ? null : new Date(first).toISOString(),
    live: first !== null && first > now,
    at: new Date(now).toISOString(),
  };
}
