/**
 * Shared store backed by Supabase.
 *
 * One row in `leagues` holds one pool's whole shared state as JSON - its
 * picks, its locks, its rules and its members - keyed by the league's code,
 * the season the pool plays and what its picks have to do, so a league of two
 * pools is two rows and two of these stores. Realtime pushes the row to every
 * open device on change, which is what makes everyone in a league see the same
 * board. See supabase/schema.sql for the table and its policies, and for what
 * a code does and does not protect.
 *
 * The client library is loaded from the CDN on demand so the app has no
 * build step and no npm dependency at runtime.
 *
 * What reaches the board is gated by version, because rows do not arrive in
 * order. A poll can be answered with the row as it stood before a tap that
 * happened while the request was out; realtime can deliver the echo of one
 * save after the next one has gone. Either one, let through, puts the old
 * state back on screen for a beat before the right one lands again, and that
 * is how a lock read as lock, unlock, lock. The rules that stop it:
 *
 *   - a row carrying a version this device saved is our own echo, however
 *     late it comes back, and is dropped;
 *   - nothing is applied while one of our saves is on the wire, since that
 *     save decides what the row holds next;
 *   - a poll whose answer arrives after the version moved on is stale and is
 *     dropped, the next poll will ask again;
 *   - and, as before, a row with the version already on screen is not news.
 *
 * The rare change from another device that commits during one of our saves is
 * held back like the rest, and noted: once the saves are done the row is read
 * once more, so it lands even with the socket up and no poll running.
 *
 * All of which is about what reaches the screen. What reaches the ROW is a
 * separate promise, and the one this store makes is that a save never
 * overwrites a change it never saw: the write is conditional on the row still
 * holding the version it was built from, and when it does not, our own changes
 * are merged onto what is actually there and the write is tried again (see
 * store/merge.js). Two people locking different weeks in the same second both
 * end up in the row, which sending the whole document unconditionally could
 * not manage - the second one to land simply stood.
 */

import { CONFIG, scopeFor } from "../config.js";
import { emptyEntry, stableJson } from "../core/plan.js";
import { POOL_KINDS } from "../sports.js";
import { supabaseClient } from "./client.js";
import { mergeEntries } from "./merge.js";
import { rememberRow } from "./rows.js";

/**
 * How often to read the row directly while realtime is not carrying it.
 *
 * A poll every second and a half, whatever the socket was doing, was forty
 * queries a minute per open board for the sake of the rare moment realtime is
 * down - and realtime is the thing that is meant to deliver these. So the read
 * is a recovery rather than a heartbeat: it runs while the channel is not
 * connected, backs off while it stays that way, and stops entirely behind a
 * hidden tab, where nobody is looking at the board anyway.
 */
const RECOVERY_MS = 15000;

/** The longest that backs off to while the channel stays down. */
const RECOVERY_MAX_MS = 60000;

/** How many times a save re-reads, merges and tries again before giving up. */
const SAVE_ATTEMPTS = 3;

/**
 * How long a board opened on a copy of its row waits for the channel to come
 * up and read the row for it, before reading it itself (see subscribe).
 */
const CHECK_WAIT_MS = 2500;

/** A point on the performance timeline, for a trace taken on a phone. */
function mark(name) {
  try {
    globalThis.performance?.mark?.(name);
  } catch {
    /* nothing lost but the mark */
  }
}

/** How many of this device's own versions to remember for the echo check. */
const OWN_VERSIONS_KEPT = 50;

/**
 * A version as a number, so the two renderings of one instant compare equal.
 *
 * Ours goes out as JavaScript's ISO string (`...789Z`) and comes back, from
 * realtime and from a poll alike, in Postgres's rendering of a timestamptz
 * (`...789+00:00`). Compared as text they never matched, so every save's own
 * echo was let through as though it were someone else's change and the board
 * rendered twice for each tap. Anything that does not parse is kept as text.
 */
function versionKey(version) {
  if (!version) return null;
  const parsed = Date.parse(version);
  return Number.isNaN(parsed) ? version : parsed;
}

function sameVersion(a, b) {
  const [left, right] = [versionKey(a), versionKey(b)];
  return left !== null && left === right;
}

/** Whether a merge changed anything about what we were trying to save. */
function sameDocument(a, b) {
  return stableJson(a) === stableJson(b);
}

/**
 * @param {string} code Which league's row to open.
 * @param {string} kind Which of the league's pools, as a kind id (see
 *   src/js/sports.js): one row per pool.
 * @param {{client?: object, seed?: {entry:object, version:string|null}|null}}
 *   [options] `client` is a ready client, for tests that cannot load the CDN;
 *   production leaves it out and loads the library. `seed` is the row as the
 *   app last saw it (store/rows.js): init() opens on it without a read, and
 *   the first subscribe reads the row behind the board to catch anything it
 *   missed. Without one, init() reads the row as it always did.
 */
export async function createSupabaseStore(code, kind, { client: given, seed = null } = {}) {
  const { table } = CONFIG.supabase;

  // One row per pool, keyed by the league's code, the season and what the
  // picks have to do, so no two leagues - and no two pools of one league - can
  // land on each other's board however many a device is in.
  const { entryId } = scopeFor(code, kind);
  const { sport, objective } = POOL_KINDS[kind] ?? {};

  // The same client the directory used to find this league, so the app holds
  // one library and one socket however many leagues it opens.
  const client = given ?? (await supabaseClient());
  if (!client) return null;

  const listeners = new Set();
  // Holding the code IS the credential (see supabase/schema.sql), and this
  // store is only reachable through one, so a device that got here can write.
  const canWrite = true;

  /** The version of the row the board is showing. */
  let lastVersion = null;
  /**
   * And the entry that came with it: what this device believes the row holds,
   * which is the base a merge measures our own changes against.
   *
   * Always a copy of its own. The board is handed a shallow copy of whatever
   * arrives and edits it in place - a lock writes into `entry.picks` - so a
   * base that shared those objects would quietly grow our own changes, and a
   * merge would then find nothing of ours to apply.
   */
  let lastEntry = null;
  /** Versions this device has saved, newest last. */
  const ownVersions = [];
  /** Saves on the wire right now. */
  let saving = 0;
  /** Whether a row from somebody else arrived during one and was held back (publish). */
  let missed = false;
  /** Whether the board opened on a copy of the row that has yet to be checked (see init). */
  let unchecked = false;
  /**
   * Whether the board opened without the row at all: no copy to open on, and
   * the read that should have brought one would not go. The board is then
   * showing an empty pool that is nobody's, and nothing on it was chosen
   * against what the row holds - so the first save reads the row and hands it
   * over rather than writing (see save). It used to look exactly like a pool
   * nobody had picked in, and a pick made on it took the slot over in the row,
   * a lock somebody else had made there included.
   */
  let blind = false;

  const isOwn = (version) => ownVersions.includes(versionKey(version));

  /** What the row holds, as far as this device knows: kept for the next open (store/rows.js). */
  const learned = (entry, version) => rememberRow(code, kind, { entry, version });

  /**
   * Hand a row to the board if it is news. `seenBefore` is the version that
   * was current when a poll asked for the row; a poll whose answer lands after
   * the version has moved on is out of date, whatever it says.
   *
   * Every listener, not the one that asked: the socket, the recovery poll and
   * the refresh button all read the same row, and a change is a change whoever
   * went and got it. Each gets its own object, because the board edits the one
   * it is handed in place (a lock writes into `entry.picks`).
   */
  function publish(row, seenBefore = lastVersion) {
    const entry = row?.entry;
    if (!entry) return;
    // Realtime takes one filter, the code, so the league's other pools come
    // through the same channel; they are somebody else's board.
    if (row.sport && row.sport !== sport) return;
    if (row.objective && row.objective !== objective) return;
    if (saving > 0) {
      // Held back while our own save decides the row - but somebody else's
      // change is owed a read once it has (see save), not left for a poll
      // that, with the socket up, nothing was going to run.
      if (!isOwn(row.updated_at)) missed = true;
      return;
    }
    if (seenBefore !== lastVersion) return;
    if (isOwn(row.updated_at) || sameVersion(row.updated_at, lastVersion)) return;
    adopt(entry, row.updated_at ?? lastVersion);
  }

  /** Take a row as what the board shows, and tell the board. */
  function adopt(entry, version) {
    blind = false;
    lastVersion = version;
    lastEntry = structuredClone(entry);
    learned(entry, lastVersion);
    for (const listener of listeners) listener({ ...emptyEntry(), ...entry });
  }

  /** This pool's row, narrowed the way every query here is. */
  const onPool = (query) => query.eq("code", entryId).eq("sport", sport).eq("objective", objective);

  /**
   * Read the row as it stands. Null where it is not there; throws where it
   * could not be read, for the one caller with somewhere to say so.
   */
  async function fetchRow() {
    const { data, error } = await onPool(
      client.from(table).select("entry, updated_at"),
    ).maybeSingle();
    if (error) throw new Error(error.message || "the board could not be read");
    if (!data) return null;
    return { entry: data.entry ?? emptyEntry(), version: data.updated_at ?? null };
  }

  /**
   * The same read for everything that runs on its own - the recovery poll, the
   * check behind a board opened on a copy, the re-read a contended save owes.
   * None of them was asked for, so none of them has a failure worth a banner:
   * the next one asks again.
   */
  const readRow = () => fetchRow().catch(() => null);

  return {
    kind: "supabase",
    shared: true,
    canWrite,

    async init() {
      // The row as the app last saw it, when it has: the board opens on that
      // and the read goes out behind it (subscribe), where a copy a rename or
      // another device's lock has moved past is caught and pushed like any
      // other change. A save in between carries this version, so it cannot
      // write over what it has not seen (see save).
      if (seed?.entry) {
        lastVersion = seed.version ?? null;
        lastEntry = structuredClone(seed.entry);
        unchecked = true;
        return { ...emptyEntry(), ...seed.entry };
      }
      let row = null;
      try {
        row = await fetchRow();
      } catch {
        // Not there to read, as opposed to not there: the channel's first read
        // and the recovery poll go on asking (subscribe), and a save asks too.
        blind = true;
        return emptyEntry();
      }
      if (!row) return emptyEntry();
      lastVersion = row.version;
      lastEntry = structuredClone(row.entry);
      learned(row.entry, row.version);
      return { ...emptyEntry(), ...row.entry };
    },

    /**
     * Read the row now, whatever realtime thinks of itself.
     *
     * The refresh button in the topline (ui/league-bar.js): somebody has asked
     * in so many words whether anything has changed, and the answer has to be
     * this second's rather than the socket's opinion of it. What comes back
     * goes out through the same publish the socket and the recovery poll use,
     * so a lock made on another phone lands on the board the way it would have
     * landed anyway - one repaint, with the same settle.
     *
     * Quiet where there is nothing to say: a row that has not moved publishes
     * nothing, and the board is left exactly as it was. It throws where the
     * read failed, because this one was asked for and the person who asked is
     * owed the reason.
     */
    async refresh() {
      const seenBefore = lastVersion;
      const row = await fetchRow();
      if (row) publish({ entry: row.entry, updated_at: row.version }, seenBefore);
    },

    subscribe(listener) {
      listeners.add(listener);

      /** Whether realtime is carrying this row at the moment. */
      let connected = false;
      /**
       * Whether this subscription has been let go of. Not the same as the
       * channel being down: removing the channel reports CLOSED like a socket
       * that dropped, and taken for one it started the recovery poll for a
       * board nobody had open any more, rescheduling itself for the rest of the
       * session.
       */
      let closed = false;
      let timer = null;
      let wait = RECOVERY_MS;
      let polling = false;

      const hidden = () => globalThis.document?.hidden === true;

      const poll = async () => {
        if (polling || closed) return;
        polling = true;
        mark("sudden-death:store:poll");
        const seenBefore = lastVersion;
        try {
          const row = await readRow();
          if (row) publish({ entry: row.entry, updated_at: row.version }, seenBefore);
        } finally {
          polling = false;
        }
      };

      const rest = () => {
        clearTimeout(timer);
        timer = null;
        wait = RECOVERY_MS;
      };

      // The board opened on a copy (init) and owes the row one read behind it.
      // The channel's own first read is that read - it comes with SUBSCRIBED,
      // or with the first error - so the copy is checked once rather than
      // twice on a launch that has enough else to do. Only a channel that says
      // nothing for a while is not waited on.
      let check = null;
      if (unchecked) {
        unchecked = false;
        check = setTimeout(() => {
          check = null;
          poll();
        }, CHECK_WAIT_MS);
      }
      const checked = () => {
        clearTimeout(check);
        check = null;
      };

      /** Keep reading while the channel is down, more slowly as it stays down. */
      const recover = () => {
        if (timer || connected || closed || hidden()) return;
        timer = setTimeout(async () => {
          timer = null;
          await poll();
          wait = Math.min(wait * 2, RECOVERY_MAX_MS);
          recover();
        }, wait);
      };

      const channel = client
        .channel(`leagues:${entryId}:${kind}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table, filter: `code=eq.${entryId}` },
          (payload) => {
            mark("sudden-death:store:realtime");
            publish(payload.new);
          },
        )
        .subscribe((status) => {
          if (closed) return;
          if (status === "SUBSCRIBED") {
            connected = true;
            rest();
            checked();
            mark("sudden-death:store:subscribed");
            // Once, now: whatever committed while the socket was down was
            // never pushed to anybody - and the copy the board opened on, if
            // it did, is checked by the same read.
            poll();
            return;
          }
          // A dropped websocket should not leave an open board stale until its
          // next reload. Read it now, then keep reading until it is back.
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            connected = false;
            checked();
            poll();
            recover();
          }
        });

      /**
       * A tab nobody is looking at is not worth a query, and a socket the
       * platform suspended while it was away is not worth trusting either - so
       * coming back is a read, whatever the channel says about itself.
       */
      const onVisibility = () => {
        if (hidden()) {
          rest();
          return;
        }
        poll();
        recover();
      };
      globalThis.document?.addEventListener?.("visibilitychange", onVisibility);

      return () => {
        closed = true;
        listeners.delete(listener);
        rest();
        checked();
        globalThis.document?.removeEventListener?.("visibilitychange", onVisibility);
        client.removeChannel(channel);
      };
    },

    /**
     * Write the entry, over the row we believe we are writing over.
     *
     * The update carries the version the entry was built from as a filter, so
     * the database itself decides whether it still applies. Nothing matched
     * means somebody committed between our last read and this write: their row
     * is read back, our own changes are merged onto it (store/merge.js), and
     * the write goes again against the version they left behind.
     *
     * Bounded, because the alternative is a save that never returns while a
     * league is busy. Three rounds is enough for any real contention - a save
     * is a tap, and the retry is a millisecond of merging - and giving up says
     * so on screen rather than silently dropping the change.
     */
    async save(entry) {
      saving += 1;
      try {
        // Made on a board that never had the row: read it, put it on the board,
        // and send nothing. Whatever the change was, it was made without
        // seeing what is there, and the person can make it again against the
        // pool as it stands.
        if (blind) {
          let row = null;
          try {
            row = await fetchRow();
          } catch {
            throw new Error("This pool has not loaded yet. Try that again in a moment.");
          }
          if (!row) throw new Error("That pool could not be found to save to.");
          adopt(row.entry, row.version);
          throw new Error(
            "This pool had not loaded when that was made, so it was not saved. The board is up to date now.",
          );
        }

        let mine = entry;
        let base = lastEntry;
        let expected = lastVersion;
        let merged = false;

        for (let attempt = 1; ; attempt += 1) {
          // Nothing to write over, as far as this device knows: a board that
          // opened offline, or a save whose last attempt was beaten. Read the
          // row and merge onto what it actually holds.
          if (!expected) {
            const row = await readRow();
            if (!row) throw new Error("That pool could not be found to save to.");
            const next = mergeEntries(base, mine, row.entry);
            merged = merged || !sameDocument(next, mine);
            mine = next;
            base = row.entry;
            expected = row.version;
          }

          const previousVersion = lastVersion;
          const version = new Date().toISOString();
          // Mark this version before sending it. Supabase can deliver our own
          // realtime event before the update promise resolves, and remembering
          // the version is what lets that echo be recognised whenever it
          // arrives.
          lastVersion = version;
          ownVersions.push(versionKey(version));
          if (ownVersions.length > OWN_VERSIONS_KEPT) ownVersions.shift();

          // An update rather than an upsert: the row is created when the league
          // is (see store/directory.js), and a save that could insert one would
          // quietly make a league out of a mistyped code. The select is how
          // many rows it actually changed, which is the whole answer here.
          const { data, error } = await onPool(
            client.from(table).update({ entry: mine, updated_at: version }),
          )
            .eq("updated_at", expected)
            .select("updated_at");

          if (error) {
            lastVersion = previousVersion;
            throw error;
          }
          if (data?.length) {
            lastEntry = structuredClone(mine);
            learned(mine, version);
            // A merge means the row now holds somebody else's change as well
            // as ours - and the realtime event for this write is our own echo,
            // which is dropped. So the board is told here, or it goes on
            // showing a pool that is missing a lock somebody else made.
            if (merged) for (const each of listeners) each({ ...emptyEntry(), ...mine });
            return;
          }

          lastVersion = previousVersion;
          if (attempt >= SAVE_ATTEMPTS) {
            throw new Error("Somebody else is saving to this pool. Try that again.");
          }
          // Read it again and merge onto whatever they left.
          expected = null;
        }
      } finally {
        saving -= 1;
        if (saving === 0 && missed) {
          missed = false;
          const seenBefore = lastVersion;
          readRow().then((row) => {
            if (row) publish({ entry: row.entry, updated_at: row.version }, seenBefore);
          });
        }
      }
    },
  };
}
