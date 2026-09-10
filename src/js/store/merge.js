/**
 * Merging two devices' writes to one pool.
 *
 * A pool's whole shared state is one JSON document in one row (see
 * store/supabase.js), so a save is a write of the entire thing. Two people
 * locking their picks in the same moment therefore both send a complete
 * document, and the second one to land was the one that stood: the first
 * person's lock was not overwritten by a decision anybody made, it was
 * overwritten by a copy of the row that was fetched before it existed.
 *
 * The version check that already existed does not help here. It is about what
 * reaches the screen - a stale row must not repaint the board - and by the time
 * a save is on the wire the damage is a fact about the database.
 *
 * So a save is conditional on the row still holding the version it was built
 * from, and when it does not, this is what decides what the row should hold
 * instead: our own changes, applied to what is actually there. Per slot, per
 * rule and per member, because that is the grain at which people actually
 * disagree - one person locking week 3 while another picks week 9 is not a
 * conflict at all, and the two writes should both survive.
 *
 * The rule is the same throughout: a key we did not touch keeps whatever the
 * row has. A key we did touch takes what we made it, including our removing it.
 * Last write wins, but only over the parts that were actually written.
 */

import { emptyEntry, stableJson } from "../core/plan.js";

/**
 * @param {object|null} base The entry our copy was built from - the row as this
 *   device last saw it. Null (a device that never read the row) means every key
 *   of ours counts as a change, which is the safest reading of "we do not know
 *   what we started from".
 * @param {object} ours What this device is trying to save.
 * @param {object} theirs The row as it actually stands now.
 * @returns {object} What to write instead.
 */
export function mergeEntries(base, ours, theirs) {
  const from = base ?? emptyEntry();
  const merged = {
    ...theirs,
    picks: mergeKeyed(from.picks, ours.picks, theirs.picks),
    swaps: mergeKeyed(from.swaps, ours.swaps, theirs.swaps),
  };

  // The rules are the pool's, one set of them, and there is no finer grain to
  // merge at: whoever last changed them meant the set they submitted.
  if (changed(from.rules, ours.rules)) {
    if (ours.rules === undefined) delete merged.rules;
    else merged.rules = ours.rules;
  }

  const members = mergeMembers(from.members, ours.members, theirs.members);
  if (members) merged.members = members;

  return merged;
}

/**
 * One object of keys - the picks, the swaps - merged key by key.
 *
 * Every key either of us has an opinion about is considered; the rest of the
 * row comes through untouched.
 */
function mergeKeyed(base = {}, ours = {}, theirs = {}) {
  const merged = { ...theirs };
  for (const key of new Set([...Object.keys(base ?? {}), ...Object.keys(ours ?? {})])) {
    if (!changed(base?.[key], ours?.[key])) continue;
    if (ours?.[key] === undefined) delete merged[key];
    else merged[key] = ours[key];
  }
  return merged;
}

/**
 * The members list, merged by id.
 *
 * An array, but a set really: who is in this league. Two people joining at once
 * should both be in it, which appending a whole list cannot manage. Order is
 * the row's, with anyone we are adding on the end, so a list does not reshuffle
 * under a merge.
 */
function mergeMembers(base, ours, theirs) {
  if (!Array.isArray(ours) && !Array.isArray(theirs)) return null;
  const byId = (list) => new Map((list ?? []).map((member) => [member?.id, member]));
  const was = byId(base);
  const mine = byId(ours);
  const now = byId(theirs);

  const merged = [];
  for (const [id, member] of now) {
    if (!changed(was.get(id), mine.get(id))) merged.push(member);
    else if (mine.has(id)) merged.push(mine.get(id));
    // Anything else is a member we took out, and it stays out.
  }
  for (const [id, member] of mine) {
    if (!now.has(id) && changed(was.get(id), member)) merged.push(member);
  }
  return merged;
}

function changed(before, after) {
  return stableJson(before) !== stableJson(after);
}
