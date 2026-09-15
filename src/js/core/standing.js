/**
 * Whether a pool's run is still alive, without building its board.
 *
 * The board knows this already - buildBoard prices every week, ranks every
 * team, runs the optimiser and reports `eliminated` at the end of it. That is
 * the right answer for the pool you are looking at and far too much work for
 * the ones you are not: the pool picker lists a league's other pools, and it
 * wants one fact about each of them.
 *
 * So this reads the three things that fact actually depends on - the pool's
 * rules, the slots the entry has locked, and the finals the refresh job
 * recorded - and leaves the season itself alone. No pricing, no model, no
 * search: a locked pick either won its week or lost it, and a loss no buy back
 * covers is the end of the run. The arithmetic of which losses are covered is
 * survival()'s, the same function the board's own elimination comes out of, so
 * the two can never disagree about a pool that grants buy backs.
 *
 * Pure, like everything else in core: the caller brings the files.
 */

import { advanceResult } from "./objective.js";
import { lineKey, slotKey } from "./plan.js";
import { mergeRules } from "./rules.js";
import { survival } from "./survival.js";

/**
 * @param {object} args
 * @param {object} args.plan data/<sport>/plan.json - for the pool's default
 *   rules, the weeks the season has, and the teams a legacy lock left unnamed.
 * @param {object} args.odds data/<sport>/odds.json - for the recorded finals.
 * @param {object|null} args.entry The pool's shared state: its picks, the teams
 *   in its slots, and any rules it overrides.
 * @param {"win"|"lose"} args.objective The pool's, which is fixed when the
 *   league is made and is not the stored rules' to change (see sports.js). A
 *   losers pool advances on a loss, so the recorded final is swapped for it.
 * @returns {{eliminated:boolean, eliminatedWeek:number|null,
 *            record:{won:number, lost:number}}}
 */
export function poolStanding({ plan, odds, entry, objective }) {
  const weeks = plan?.weeks ?? [];
  // The objective is the kind's whatever is stored against the pool - it was
  // fixed when the league was made - so it is laid back over the merge, the
  // same way the home page reads a pool's rules (poolRules in
  // store/directory.js).
  const rules = {
    ...mergeRules(
      plan?.rules,
      entry?.rules,
      weeks.map((week) => week.week),
    ),
    objective,
  };

  const authored = new Map(weeks.map((week) => [week.week, week.picks ?? []]));
  const picks = [];

  for (let week = rules.startWeek; week <= rules.endWeek; week += 1) {
    for (let slot = 0; slot < rules.picksPerWeek; slot += 1) {
      const settled = settledPick(week, slot, { rules, entry, odds, authored });
      if (settled) picks.push(settled);
    }
  }

  // Every pick here has a result, so the probability survival() works out for
  // what is left is 1 and means nothing. Only the three facts about what has
  // already happened come back.
  const { eliminated, eliminatedWeek, record } = survival({
    picks,
    buyBackWeeks: rules.buyBackWeeks,
    buyBacks: rules.buyBacks,
  });
  return { eliminated, eliminatedWeek, record };
}

/**
 * One slot, where it holds a pick that has been settled - and nothing
 * otherwise, because a week still to come cannot end a run.
 *
 * The same reading of the entry core/plan.js does (resolvePick): `locked` is
 * the persisted name for a committed pick and a saved result implies one, the
 * team is in `swaps` under the slot's key, and a lock saved before slots were
 * user-picked names no team and means the plan's own. A result the users typed
 * in wins over the feed's; an unlocked slot takes neither, since the feed
 * cannot commit a choice for anybody.
 */
function settledPick(week, slot, { rules, entry, odds, authored }) {
  const key = slotKey(week, slot);
  const saved = entry?.picks?.[key] ?? {};
  if (!saved.locked && !saved.result) return null;

  const picked = entry?.swaps?.[key];
  const team = typeof picked === "string" ? picked : (authored.get(week)?.[slot]?.team ?? null);
  const result =
    saved.result ??
    (team ? advanceResult(odds?.results?.[lineKey(week, team)], rules.objective) : null);

  return result ? { week, winProb: 1, result } : null;
}
