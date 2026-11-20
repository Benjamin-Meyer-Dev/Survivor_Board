/**
 * Putting a played week right.
 *
 * A lock is a commitment made before the game, and the board treats a played
 * week as history: an unlocked pick on a final is dropped (core/plan.js,
 * resolvePick), a final's row cannot be picked, and a locked pick with a result
 * has no controls. That is right for the week being played and wrong for the
 * two things that happen to a real pool anyway - a pick that was made but never
 * locked in here, and a lock on the wrong team. The pool itself was played on
 * what was actually picked, so the board has to be able to say so after the
 * fact.
 *
 * A correction is a lock written into a played (or partly played) week, on a
 * team the slot could not normally take. It replaces whatever the slot held,
 * and the result comes from the feed like any other lock's - a result tapped
 * in by hand belonged to the team it was tapped against, so it goes with it.
 *
 * Teams are spent once. A correction onto a team a LATER week has picked takes
 * the team from that week: the earlier week is the one that was played, so it
 * is the one that holds. Those later slots are cleared and handed back to the
 * caller, which asks for them to be picked again. A team an EARLIER week holds
 * cannot be corrected onto at all - that would be the correction breaking the
 * rule rather than repairing the record.
 */
import { slotKey } from "./plan.js";

/**
 * Whether the week can be corrected on this board.
 *
 * Any week of a live pool, and a finished pool up to the week its run ended:
 * the loss that ended it may be the wrong lock, and putting it right is the
 * way back into the season. A week after the end was never played.
 *
 * @param {object} board Result of buildBoard().
 * @param {number} week
 */
export function fixableWeek(board, week) {
  return !board.eliminated || week <= board.eliminatedWeek;
}

/**
 * Whether a slot is still owed its pick: the season has moved on past its
 * week and nothing was ever locked into it, in a week the board can still put
 * right. The pool was played on something, so the board is short of a fact -
 * the field and the chart mark it, and the week's list is where it is
 * recorded (amendEntry).
 *
 * @param {object} board Result of buildBoard().
 * @param {object} pick A slot from board.weeks[].picks.
 */
export function missedSlot(board, pick) {
  return !pick.status.locked && pick.week < board.currentWeek && fixableWeek(board, pick.week);
}

/**
 * Whether a team in a slot's list can be corrected onto: not the slot's own
 * team, not one the week's other slot holds, and not one an earlier week has
 * already spent.
 *
 * @param {object} pick A slot from board.weeks[].picks.
 * @param {object} option One of pick.options.
 */
export function amendable(pick, option) {
  if (option.isCurrent || option.heldBySibling) return false;
  return !(option.spentWeek && option.spentWeek < pick.week);
}

/**
 * What a correction would do, without doing it: the team the slot loses, and
 * the later slots that hold the incoming team. For the confirmation to read
 * out before anything is written.
 *
 * @param {object} board
 * @param {{week:number, slot:number, team:string}} change
 * @returns {{replacing:string|null, displaced:Array<{week:number, slot:number,
 *   team:string, locked:boolean}>}}
 */
export function amendImpact(board, { week, slot, team }) {
  const here = board.weeks.find((entry) => entry.week === week);
  const replacing = here?.picks[slot]?.team ?? null;
  const displaced = [];
  for (const later of board.weeks) {
    if (later.week <= week) continue;
    for (const pick of later.picks) {
      if (pick.team === team) {
        displaced.push({
          week: later.week,
          slot: pick.slot,
          team,
          locked: Boolean(pick.status.locked),
        });
      }
    }
  }
  return { replacing: replacing === team ? null : replacing, displaced };
}

/**
 * The entry with the correction written in.
 *
 * Read off the board as well as the entry, because a slot's team is not always
 * in the entry: locks saved before slots were user-picked hold the plan's team
 * without naming it, and those have to be found and cleared like any other.
 *
 * @param {object} entry The shared entry ({picks, swaps, ...}).
 * @param {object} board The board the correction was asked for on.
 * @param {{week:number, slot:number, team:string, spread?:number|null,
 *   by?:string|null, at?:number}} change
 * @returns {{entry:object, displaced:Array<{week:number, slot:number,
 *   team:string, locked:boolean}>}}
 */
export function amendEntry(
  entry,
  board,
  { week, slot, team, spread = null, by = null, at = Date.now() },
) {
  const { replacing, displaced } = amendImpact(board, { week, slot, team });
  const picks = { ...(entry.picks ?? {}) };
  const swaps = { ...(entry.swaps ?? {}) };
  for (const gone of displaced) {
    const key = slotKey(gone.week, gone.slot);
    delete picks[key];
    delete swaps[key];
  }

  const key = slotKey(week, slot);
  const was = picks[key] ?? {};
  swaps[key] = team;
  // Built fresh rather than spread over the old lock: its result, its line and
  // its time belong to the team it was made on.
  picks[key] = {
    locked: true,
    coachTeam: was.coachTeam ?? null,
    coachRanked: was.coachRanked ?? null,
    spread: Number.isFinite(spread) ? spread : null,
    by,
    at,
    // Said on the lock so the record shows it was put right after the fact,
    // and what it replaced.
    amended: { from: replacing, by, at },
  };
  return { entry: { ...entry, picks, swaps }, displaced };
}
