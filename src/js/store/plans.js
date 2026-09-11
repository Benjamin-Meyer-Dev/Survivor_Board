/**
 * The coach's plans, kept on the device between launches.
 *
 * A plan is a beam search over the whole remaining season and it is the one
 * piece of this app that costs real time. Everything else about a cold board
 * is now warmed ahead of the tap - the season's files as soon as the league
 * list is read, the plan itself while the home page is idle (warmBoardData and
 * warmPools in app.js) - but a launch starts with neither, so the first board
 * of a session is planned behind the startup layer while the person waits.
 *
 * A plan is a pure function of its signature, though: the league, the week,
 * the pool's rules, the stamps on every file it was priced off, and what is
 * locked (signatureBase and signatureOf in core/plan.js). So a plan from the
 * last launch is the same plan this launch would compute, for exactly as long
 * as that signature still describes the board - and the moment anything moves,
 * the signature changes and it is simply not found.
 *
 * The one thing the signature cannot carry is the search itself. A deploy that
 * changes core/recommend.js would be answered out of here with the previous
 * version's plan until the next lock or the next odds pull moved the signature
 * on. So the key carries a version, and it is bumped when the search changes,
 * exactly as sw.js's CACHE is bumped when the assets do. The two rituals are
 * the same ritual; do them together.
 *
 * Deliberately quiet, and bounded. Nothing here is load-bearing: a read that
 * fails, a quota that is full, a device in private mode all mean one thing,
 * which is that the first board of the session is planned the way it always
 * was.
 */

import { CONFIG } from "../config.js";

/**
 * How many plans to keep. One per pool a device can open is the point of it -
 * four kinds of pool is the most a league runs - and a couple over so the
 * board somebody actually locked on last night is still here this morning.
 */
const KEEP = 6;

/**
 * How much of the device's storage this may have, in characters of JSON.
 *
 * A plan carries the season's picks, the frontier for the week on the clock
 * and the ranked calls behind every week, so it is tens of kilobytes; the
 * budget is what stops a college board with eighteen weeks of them crowding
 * out the thing that actually matters here, which is the picks people made.
 * Over it, the oldest go until it fits.
 */
const BUDGET = 512 * 1024;

export function readPlans() {
  try {
    const raw = localStorage.getItem(CONFIG.storage.plans);
    if (!raw) return [];
    const held = JSON.parse(raw);
    return Array.isArray(held) ? held : [];
  } catch {
    // Unreadable is the same as absent: core/plan.js drops anything malformed
    // anyway (importPlans), and this is only the outer wrapper failing.
    return [];
  }
}

/**
 * Keep what this session has worked out, newest first, as much of it as fits.
 *
 * @param {Array<{signature:string, base:string, locks:Array, value:object}>} entries
 */
export function writePlans(entries) {
  const kept = [];
  let size = 2;
  for (const entry of entries.slice(0, KEEP)) {
    let json;
    try {
      json = JSON.stringify(entry);
    } catch {
      // A plan that will not serialise is a plan this cannot keep. The next
      // launch searches for it, which is what it would have done anyway.
      continue;
    }
    if (size + json.length + 1 > BUDGET) break;
    size += json.length + 1;
    kept.push(entry);
  }

  try {
    if (kept.length === 0) localStorage.removeItem(CONFIG.storage.plans);
    else localStorage.setItem(CONFIG.storage.plans, JSON.stringify(kept));
  } catch {
    /* private mode, quota, or blocked storage: the next launch plans its own */
  }
}
