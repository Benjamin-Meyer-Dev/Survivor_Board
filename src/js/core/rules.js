/**
 * Pool rules, and the overrides that can change them from the board.
 *
 * A pool ships its rules in `data/<league>/plan.json`: which weeks of the
 * season it plays, how many picks a week, whether a loss can be bought back
 * and where, and whether a pick has to win or lose. Those are the defaults,
 * and for a pool nobody has touched they are the whole story.
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
 * week the pool does not play is dropped, an end week before the start week is
 * pulled up to it, and more buy backs than forgiving weeks is impossible to
 * express - the same rule validate-plan enforces on the files.
 *
 * Pure, and imported by both the board and the settings sheet, so the bounds
 * the UI offers are the bounds the model applies.
 */

import { objectiveOf } from "./objective.js";

/**
 * The most picks a week can hold. Two is as many as any pool here takes, and
 * every week's card, every slot on the field and the coach's call are laid out
 * for at most a pair.
 */
export const MAX_PICKS_PER_WEEK = 2;

/** The most buy backs a pool can grant. Also capped by the forgiving weeks. */
export const MAX_BUY_BACKS = 4;

/**
 * The rules the settings sheet can change, in the order it shows them. Every
 * other rule is either a fact about the schedule (which weeks it has games in)
 * or a property of the model (the confidence tiers), and neither is a pool's to
 * set from the board.
 *
 * The start and end week are the pool's, not the schedule's: a pool runs some
 * run of the weeks the season has - all eighteen of the NFL's, or the last ten
 * of them - and the weeks outside it are no more part of the board than a week
 * the season does not have.
 */
export const EDITABLE_RULES = Object.freeze([
  "objective",
  "startWeek",
  "endWeek",
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
 *   clamping the range and the buy back weeks. Empty means "do not know", and
 *   then the range the plan names stands in for the calendar - which is what
 *   lets the scripts and the home page read rules without one.
 * @returns {{objective:"win"|"lose", startWeek:number, endWeek:number,
 *            picksPerWeek:number, buyBacks:number,
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

  // How much season there is to play: the calendar when the caller has one,
  // and otherwise the range the plan itself names. The pool's own range is cut
  // out of this and can never reach past it.
  const calendar = [...season].sort((a, b) => a - b);
  const ceilingWeek = Number.MAX_SAFE_INTEGER;
  const first = calendar[0] ?? bounded(planRules.startWeek, 1, ceilingWeek, 1);
  const last = Math.max(
    first,
    calendar.at(-1) ??
      bounded(
        planRules.endWeek,
        first,
        ceilingWeek,
        bounded(planRules.weeks, first, ceilingWeek, first),
      ),
  );

  // The start is settled first and the end measured from it, so a range given
  // back to front collapses onto its start rather than onto nothing: a pool
  // always plays at least the week it begins in.
  const startWeek = bounded(
    saved.startWeek,
    first,
    last,
    bounded(planRules.startWeek, first, last, first),
  );
  const endWeek = bounded(
    saved.endWeek,
    startWeek,
    last,
    bounded(planRules.endWeek, startWeek, last, last),
  );

  const weeksIn = (value) =>
    [
      ...new Set(
        value
          .map((week) => integer(week, null))
          .filter(
            (week) =>
              week !== null &&
              week >= startWeek &&
              week <= endWeek &&
              (season.size === 0 || season.has(week)),
          ),
      ),
    ].sort((a, b) => a - b);

  const planWeeks = weeksIn(Array.isArray(planRules.buyBackWeeks) ? planRules.buyBackWeeks : []);
  const buyBackWeeks = Array.isArray(saved.buyBackWeeks) ? weeksIn(saved.buyBackWeeks) : planWeeks;

  // A buy back needs a week it can cover, so the weeks are the ceiling: with
  // none listed the count is zero however many either side asks for. This is
  // what stops "one buy back, no forgiving weeks" - a cushion that reads as
  // real on the strip and can never once apply.
  const ceiling = Math.min(MAX_BUY_BACKS, buyBackWeeks.length);
  const buyBacks = bounded(saved.buyBacks, 0, ceiling, bounded(planRules.buyBacks, 0, ceiling, 0));

  return {
    objective:
      saved.objective === "win" || saved.objective === "lose"
        ? saved.objective
        : objectiveOf(planRules),
    startWeek,
    endWeek,
    picksPerWeek: bounded(
      saved.picksPerWeek,
      1,
      MAX_PICKS_PER_WEEK,
      bounded(planRules.picksPerWeek, 1, MAX_PICKS_PER_WEEK, 2),
    ),
    buyBacks,
    // And the other way: a pool that grants no buy back covers no week. The
    // sheet shows the weeks only once there is a count to cover one, so weeks
    // left lit under a zero would be a rule nobody can see - and the deck
    // would badge them as forgiving all the same.
    buyBackWeeks: buyBacks > 0 ? buyBackWeeks : [],
  };
}

/**
 * The weeks a buy back can cover, with enough of them lit to hold the count.
 *
 * The weeks are the count's ceiling in mergeRules, and that is the right way
 * round for a document nobody is looking at: a hand-edited "three buy backs,
 * one week" quietly becomes one. But the settings sheet asks for the count
 * first and shows the weeks only once there is one, so a pool that grants none
 * has no weeks to step the count up against - and the clamp would put every
 * step straight back to zero. This is the other direction, for the sheet: a
 * count stepped past the weeks chosen lights the earliest open weeks of the
 * run until it fits, and the pills show which. Earliest because that is where
 * every pool that forgives a loss forgives it - the opening weeks, before the
 * field has thinned - and because the person at the sheet can move them.
 *
 * Weeks already chosen are kept. A count that already fits changes nothing,
 * and so does a run too short to hold it: the clamp takes the rest.
 *
 * @param {{startWeek:number, endWeek:number, buyBacks:number,
 *          buyBackWeeks:number[]}} rules
 * @param {number[]} seasonWeeks Every week the calendar has.
 * @returns {number[]} The weeks, in order.
 */
export function coverWeeks(rules, seasonWeeks = []) {
  const chosen = new Set(rules.buyBackWeeks ?? []);
  const wanted = integer(rules.buyBacks, 0);
  const run = seasonWeeks
    .map(Number)
    .filter((week) => week >= rules.startWeek && week <= rules.endWeek)
    .sort((a, b) => a - b);
  for (const week of run) {
    if (chosen.size >= wanted) break;
    chosen.add(week);
  }
  return [...chosen].sort((a, b) => a - b);
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
