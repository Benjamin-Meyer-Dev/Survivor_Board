/**
 * The pool rows this session has seen, by league code and kind of pool.
 *
 * The home page's refresh reads every one of its leagues' rows whole - the
 * entry and its version included - and used to keep the name and the rules and
 * drop the rest, so opening a league went back for a row the app had been
 * holding a moment before. This is where the rest is kept: the store opens on
 * the copy in hand (createSupabaseStore's `seed`) and checks it behind the
 * board rather than in front of it, and the board is one round trip nearer the
 * tap.
 *
 * Memory only. A row here is a head start, not a record: the row in the
 * database is the truth, the store still reads it, and a launch starts empty.
 * The store writes back what it learns - a save, a push, a poll - so a board
 * reopened after a lock opens on the lock and not on the row from before it.
 */

const rows = new Map();

const keyOf = (code, kind) => `${code}/${kind}`;

/** A version as an instant, or null for one that does not parse (or is not there). */
function stamp(version) {
  const parsed = Date.parse(version ?? "");
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Keep a row as the copy to open with.
 *
 * A row older than the one in hand is a read that was overtaken - a directory
 * refresh answered from before a save that has since landed - and the copy in
 * hand stands. Versions only ever move forward, so newer is what counts.
 *
 * @param {string} code
 * @param {string} kind
 * @param {{entry:object, version:string|null}} row
 */
export function rememberRow(code, kind, { entry, version = null }) {
  if (!entry || typeof entry !== "object") return;
  const key = keyOf(code, kind);
  const held = rows.get(key);
  const incoming = stamp(version);
  const known = stamp(held?.version);
  if (held && incoming !== null && known !== null && incoming < known) return;
  rows.set(key, { entry: structuredClone(entry), version: version ?? null });
}

/**
 * The row as last seen, as a copy of its own, or null when this session has
 * not seen it.
 *
 * @returns {{entry:object, version:string|null}|null}
 */
export function knownRow(code, kind) {
  const held = rows.get(keyOf(code, kind));
  return held ? { entry: structuredClone(held.entry), version: held.version } : null;
}

/**
 * Forget a league's rows: the kinds named, or every kind when none are.
 *
 * @param {string} code
 * @param {string[]|null} [kinds]
 */
export function forgetRows(code, kinds = null) {
  for (const key of [...rows.keys()]) {
    const [heldCode, heldKind] = key.split("/");
    if (heldCode !== code) continue;
    if (kinds === null || kinds.includes(heldKind)) rows.delete(key);
  }
}
