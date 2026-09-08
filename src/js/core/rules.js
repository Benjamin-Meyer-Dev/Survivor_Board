/**
 * Pool rules, and the overrides that can change them from the board.
 *
 * A pool ships its rules in `data/<league>/plan.json`: how many picks a week,
 * whether a loss can be bought back and where, and whether a pick has to win
 * or lose. Those are the defaults, and for a pool nobody has touched they are
 * the whole story.
 *
 * The settings sheet writes overrides into the shared entry, under `rules`.
 * That is deliberately the same document the picks live in: rules belong to the
 * pool rather than to a device, so both phones must see the same ones, and the
 * entry is already the thing that syncs. A pool with no overrides saved has no
 * `rules` key at all, which is what "follows the plan" looks like on disk.
 *
 * Everything here is clamped rather than trusted. An override arrives from a
 * shared document that another device wrote, an older version of this app may
 * have written, or a person may have edited by hand in the Supabase table, and
 * a board that cannot be broken by any of that is worth more than one that
 * reports the problem. So a picks-per-week of 0 becomes 1, a buy back on a
 * week the season does not have is dropped, and more buy backs than forgiving
 * weeks is impossible to express - the same rule validate-plan enforces on the
 * files.
 *
 * Pure, and imported by both the board and the settings sheet, so the bounds
 * the UI offers are the bounds the model applies.
 */

import { objectiveOf } from "./objective.js";

/**
 * The most picks a week can hold. Four is past any survivor pool anyone runs
 * and short of the point where a week's card stops fitting a phone.
 */
export const MAX_PICKS_PER_WEEK = 4;

/** The most buy backs a pool can grant. Also capped by the forgiving weeks. */
export const MAX_BUY_BACKS = 4;

/**
 * The rules the settings sheet can change, in the order it shows them. Every
 * other rule is either a fact about the schedule (how many weeks there are) or
 * a property of the model (the confidence tiers), and neither is a pool's to
 * set from the board.
 */
export const EDITABLE_RULES = Object.freeze([
  "objective",
  "picksPerWeek",
  "buyBacks",
  "buyBackWeeks",
]);

/**
 * The rules a board runs on: what the plan ships, with the pool's saved
 * overrides laid over it, clamped into a set that is always coherent.
 *
 * @param {object} [planRules] plan.rules, the pool's own defaults.
 * @param {object|null} [overrides] entry.rules, the shared overrides. Any key
 *   missing or unusable falls back to the plan's.
 * @param {Array<number>} [weekNumbers] The weeks the season actually has, for
 *   clamping the buy back weeks. Empty means "do not know", and then a listed
 *   week is kept as given rather than dropped - which is what lets the scripts
 *   read rules without a calendar.
 * @returns {{objective:"win"|"lose", picksPerWeek:number, buyBacks:number,
 *            buyBackWeeks:Array<number>}}
 */
export function mergeRules(planRules = {}, overrides = null, weekNumbers = []) {
  const saved = pick(overrides);
  const season = new Set(weekNumbers.map(Number));

  // One rule for every field: an override that can be used is used, and an
  // override that cannot falls back to what the plan ships - never to a
  // constant. A pool that has said nothing and a pool that has said something
  // unusable are the same pool, and it is the losers pool's plan, not a
  // default somewhere in here, that knows its picks are meant to lose.
  const weeksIn = (value) =>
    [
      ...new Set(
        value
          .map((week) => integer(week, null))
          .filter((week) => week !== null && (season.size === 0 || season.has(week))),
      ),
    ].sort((a, b) => a - b);

  const planWeeks = weeksIn(Array.isArray(planRules.buyBackWeeks) ? planRules.buyBackWeeks : []);
  const buyBackWeeks = Array.isArray(saved.buyBackWeeks) ? weeksIn(saved.buyBackWeeks) : planWeeks;

  // A buy back needs a week it can cover, so the weeks are the ceiling: with
  // none listed the count is zero however many either side asks for. This is
  // what stops "one buy back, no forgiving weeks" - a cushion that reads as
  // real on the strip and can never once apply.
  const ceiling = Math.min(MAX_BUY_BACKS, buyBackWeeks.length);

  return {
    objective:
      saved.objective === "win" || saved.objective === "lose"
        ? saved.objective
        : objectiveOf(planRules),
    picksPerWeek: bounded(
      saved.picksPerWeek,
      1,
      MAX_PICKS_PER_WEEK,
      bounded(planRules.picksPerWeek, 1, MAX_PICKS_PER_WEEK, 2),
    ),
    buyBacks: bounded(saved.buyBacks, 0, ceiling, bounded(planRules.buyBacks, 0, ceiling, 0)),
    buyBackWeeks,
  };
}

/**
 * Whether two rule sets say the same thing. Used to tell a pool running its
 * plan's rules from one running its own, and to drop a save that changes
 * nothing.
 */
export function sameRules(a, b) {
  if (!a || !b) return a === b;
  return EDITABLE_RULES.every((key) => {
    if (key === "buyBackWeeks") {
      const left = a.buyBackWeeks ?? [];
      const right = b.buyBackWeeks ?? [];
      return left.length === right.length && left.every((week, index) => week === right[index]);
    }
    return a[key] === b[key];
  });
}

/**
 * Just the editable rules, as a set to save. Nothing else is anyone's to
 * store, and the weeks come out as a copy: this is what a draft in the
 * settings sheet is built from, and a draft must not be able to write through
 * to the rules the board is currently running.
 */
export function onlyEditable(rules) {
  return Object.fromEntries(
    EDITABLE_RULES.map((key) => [
      key,
      key === "buyBackWeeks" ? [...(rules[key] ?? [])] : rules[key],
    ]),
  );
}

/** The editable keys of an override object, ignoring anything else in it. */
function pick(overrides) {
  if (!overrides || typeof overrides !== "object") return {};
  return Object.fromEntries(
    EDITABLE_RULES.filter((key) => overrides[key] !== undefined).map((key) => [
      key,
      overrides[key],
    ]),
  );
}

/** A whole number, or `fallback` for anything that is not one. */
function integer(value, fallback) {
  const number = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

/** A whole number inside [min, max]. Anything unusable takes `fallback`. */
function bounded(value, min, max, fallback) {
  const number = integer(value, integer(fallback, min));
  return Math.min(Math.max(number, min), Math.max(min, max));
}
