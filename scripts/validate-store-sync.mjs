#!/usr/bin/env node
/**
 * Regression checks for how the shared store decides what reaches the board.
 *
 * Rows from Supabase do not arrive in order: a poll can answer with the row as
 * it stood before a tap, and realtime can deliver the echo of one save after
 * the next has gone. Each of those, let through, put the old state back on
 * screen for a beat, which is how a lock read as lock, unlock, lock. These
 * replays drive the store with a fake client whose timing the test controls
 * and check that only news reaches the listener.
 */

import assert from "node:assert/strict";
import { createSupabaseStore } from "../src/js/store/supabase.js";

const LOCKED = { picks: { "1-0": { locked: true } }, swaps: {} };
const OPEN = { picks: {}, swaps: {} };

/** Postgres renders a timestamptz with an offset; the client sends a Z. */
const pg = (iso) => iso.replace("Z", "+00:00");

/**
 * And it compares them as instants, not as text, which is what makes a filter
 * on `updated_at` work at all: the version the store sends back came off a read
 * in Postgres's rendering, and the row holds the one the client wrote.
 */
const sameStamp = (a, b) => Date.parse(a) === Date.parse(b);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Enough of the supabase-js client for the store, with every request held
 * until the test answers it, so replies can land in any order.
 */
function fakeClient() {
  const state = { row: { entry: LOCKED, updated_at: "2026-09-04T10:00:00.000Z" } };
  let realtime = null;
  let onStatus = null;
  const pending = [];
  const later = (label, produce) =>
    new Promise((resolve) => pending.push({ label, resolve: () => resolve(produce()) }));

  const client = {
    echoes: [],
    state,
    from() {
      return {
        // Filters chain - the store narrows by code, season and objective - and
        // the request goes out when the chain is read.
        select() {
          const chain = {
            eq: () => chain,
            maybeSingle: () => {
              // A read sees the row as it stands when the request is issued.
              const snapshot = { ...state.row, updated_at: pg(state.row.updated_at) };
              return later("read", () => ({ data: snapshot, error: null }));
            },
          };
          return chain;
        },
        // The store writes with update().eq()...eq("updated_at", seen).select():
        // a pool's row is created when the league is, so a save that could
        // insert one would make a league out of a mistyped code, and the
        // version filter is what stops it writing over a change it never saw.
        update(values) {
          let request = null;
          const filters = [];
          const chain = {
            eq: (column, value) => {
              filters.push([column, value]);
              return chain;
            },
            select: () => chain,
            then: (resolve, reject) => {
              request ??= later("upsert", () => {
                const expected = filters.find(([column]) => column === "updated_at")?.[1];
                // The row has moved on since the entry being written was read.
                // Postgres changes nothing and says so; nothing is committed,
                // so there is no realtime event either.
                if (expected !== undefined && !sameStamp(state.row.updated_at, expected)) {
                  return { data: [], error: null };
                }
                state.row = { entry: values.entry, updated_at: values.updated_at };
                // Realtime fires on commit; the test decides when it is heard.
                client.echoes.push({
                  new: { ...state.row, updated_at: pg(state.row.updated_at) },
                });
                return { data: [{ updated_at: pg(state.row.updated_at) }], error: null };
              });
              return request.then(resolve, reject);
            },
          };
          return chain;
        },
      };
    },
    channel() {
      const channel = {
        on(_event, _filter, handler) {
          realtime = handler;
          return channel;
        },
        subscribe(callback) {
          onStatus = callback;
          return channel;
        },
      };
      return channel;
    },
    removeChannel() {},
    /** Deliver one queued realtime event. */
    hear(index = 0) {
      const [event] = client.echoes.splice(index, 1);
      realtime(event);
    },
    /** A realtime event from another device. */
    hearOther(row) {
      realtime({ new: { ...row, updated_at: pg(row.updated_at) } });
    },
    /** Make the store poll now, as it does after a channel error. */
    poll() {
      onStatus("CHANNEL_ERROR");
    },
    /** Answer the oldest pending request of a kind. */
    answer(label) {
      const index = pending.findIndex((request) => request.label === label);
      assert.notEqual(index, -1, `no pending ${label}`);
      const [request] = pending.splice(index, 1);
      request.resolve();
    },
  };
  return client;
}

const shown = (heard) => heard.map((entry) => (entry.picks["1-0"]?.locked ? "locked" : "open"));

async function scenario(name, expected, run) {
  const client = fakeClient();
  // A league code and one of its pools, which is the only way to this store
  // now: holding the code is what says a device may write (see
  // supabase/schema.sql), so there is no unlock step any more.
  const store = await createSupabaseStore("BXQK7HRTM4WD", "nfl-win", { client });
  const init = store.init();
  client.answer("read");
  await init;
  const heard = [];
  const stop = store.subscribe((entry) => heard.push(entry));
  await run({ client, store });
  stop();
  assert.deepEqual(shown(heard), expected, name);
}

// A poll is out when the user unlocks. Its answer, the row before the unlock,
// arrives while the save is still on the wire.
await scenario("stale poll answered during the save", [], async ({ client, store }) => {
  client.poll();
  await tick();
  const save = store.save(OPEN);
  await tick();
  client.answer("read");
  await tick();
  client.answer("upsert");
  await save;
  client.hear();
  await tick();
});

// The same poll, answered after the save has completed.
await scenario("stale poll answered after the save", [], async ({ client, store }) => {
  client.poll();
  await tick();
  const save = store.save(OPEN);
  await tick();
  client.answer("upsert");
  await save;
  client.answer("read");
  await tick();
  client.hear();
  await tick();
});

// Two quick taps, lock then unlock. The lock's echo is heard only after the
// unlock has been saved.
await scenario("late echo of an earlier tap", [], async ({ client, store }) => {
  const lock = store.save(LOCKED);
  await tick();
  client.answer("upsert");
  await lock;
  const unlock = store.save(OPEN);
  await tick();
  client.answer("upsert");
  await unlock;
  client.hear(0);
  await tick();
  client.hear(0);
  await tick();
});

// Another device's change still arrives, once, however many times the same row
// is delivered.
await scenario("another device's change", ["open"], async ({ client }) => {
  const theirs = { entry: OPEN, updated_at: "2026-09-04T10:05:00.000Z" };
  client.hearOther(theirs);
  await tick();
  client.hearOther(theirs);
  await tick();
  client.state.row = theirs;
  client.poll();
  await tick();
  client.answer("read");
  await tick();
});

// A change from another device that commits during our save is dropped from
// realtime but recovered by the next poll.
await scenario("change during our save recovers on poll", ["open"], async ({ client, store }) => {
  const save = store.save(LOCKED);
  await tick();
  const theirs = { entry: OPEN, updated_at: "2026-09-04T10:06:00.000Z" };
  client.hearOther(theirs);
  await tick();
  client.answer("upsert");
  await save;
  client.state.row = theirs;
  client.poll();
  await tick();
  client.answer("read");
  await tick();
});

// A failed save gives the version back, so the next poll is trusted again.
await scenario("failed save then poll", ["open"], async ({ client, store }) => {
  const original = client.from;
  const offline = () => {
    const chain = {
      eq: () => chain,
      select: () => Promise.resolve({ data: null, error: new Error("offline") }),
    };
    return chain;
  };
  client.from = () => ({ ...original(), update: offline });
  await assert.rejects(store.save(OPEN));
  client.from = original;
  client.state.row = { entry: OPEN, updated_at: "2026-09-04T10:07:00.000Z" };
  client.poll();
  await tick();
  client.answer("read");
  await tick();
});

/* --- what reaches the row ------------------------------------------------
   Above is about what reaches the screen. The rest is about what reaches the
   database: a save carries the version it was built from, and a save that lost
   the race merges its own changes onto whatever won rather than overwriting
   it. */

/**
 * Drive one save with another device committing in the middle of it.
 *
 * @param {string} name
 * @param {object} mine What this device is saving.
 * @param {object} theirs The row the other device leaves behind, mid-save.
 * @param {(row:object, name:string, heard:object[]) => void} check
 */
async function race(name, mine, theirs, check) {
  const client = fakeClient();
  const store = await createSupabaseStore("BXQK7HRTM4WD", "nfl-win", { client });
  const init = store.init();
  client.answer("read");
  await init;
  const heard = [];
  const stop = store.subscribe((entry) => heard.push(entry));

  const save = store.save(mine);
  await tick();
  // Their commit lands first, so ours no longer matches the row.
  client.state.row = theirs;
  client.answer("upsert");
  await tick();
  // Ours is refused, so the store reads the row and merges onto it.
  client.answer("read");
  await tick();
  client.answer("upsert");
  await save;
  stop();
  check(client.state.row, name, heard);
}

const LOCK_AND_THREE = {
  picks: { "1-0": { locked: true }, "3-0": { locked: true, by: "us" } },
  swaps: {},
};
const LOCK_AND_FIVE = {
  picks: { "1-0": { locked: true }, "5-0": { locked: true, by: "them" } },
  swaps: {},
};

await race(
  "a save that lost the race keeps both changes",
  LOCK_AND_THREE,
  { entry: LOCK_AND_FIVE, updated_at: "2026-09-04T10:09:00.000Z" },
  (row, name, heard) => {
    assert.deepEqual(Object.keys(row.entry.picks).sort(), ["1-0", "3-0", "5-0"], name);
    assert.equal(row.entry.picks["5-0"].by, "them", `${name}: theirs is untouched`);
    assert.equal(row.entry.picks["3-0"].by, "us", `${name}: ours is applied`);
    // The write that merged is the only time this device will ever see their
    // lock: the realtime event for it is our own echo, and echoes are dropped.
    assert.equal(heard.length, 1, `${name}: the board is told once`);
    assert.deepEqual(
      Object.keys(heard[0].picks).sort(),
      ["1-0", "3-0", "5-0"],
      `${name}: and told the merged entry`,
    );
  },
);

// The same race, where what we did was to take a lock off. Removing a slot is
// a change like any other, and the merge has to keep it removed.
await race(
  "an unlock that lost the race stays unlocked",
  { picks: {}, swaps: {} },
  {
    entry: { picks: { "1-0": { locked: true }, "9-0": { locked: true } }, swaps: {} },
    updated_at: "2026-09-04T10:11:00.000Z",
  },
  (row, name) => {
    assert.deepEqual(Object.keys(row.entry.picks), ["9-0"], name);
  },
);

// The board edits the entry it was handed in place - a lock writes into
// `entry.picks` - and the base a merge measures against must not be that same
// object, or our own change looks like something the row already had and is
// dropped.
{
  const client = fakeClient();
  const store = await createSupabaseStore("BXQK7HRTM4WD", "nfl-win", { client });
  const init = store.init();
  client.answer("read");
  await init;
  const mine = await init;

  // What app.js does on a tap: mutate what the store handed over.
  mine.picks["7-0"] = { locked: true, by: "us" };
  const save = store.save(mine);
  await tick();
  // And somebody else commits first, so the save has to merge.
  client.state.row = {
    entry: { picks: { "1-0": { locked: true }, "8-0": { locked: true } }, swaps: {} },
    updated_at: "2026-09-04T10:20:00.000Z",
  };
  client.answer("upsert");
  await tick();
  client.answer("read");
  await tick();
  client.answer("upsert");
  await save;
  assert.deepEqual(
    Object.keys(client.state.row.entry.picks).sort(),
    ["1-0", "7-0", "8-0"],
    "a change made in the entry the store handed over survives a merge",
  );
}

// A save whose row keeps moving gives up rather than trying for ever, and says
// so, because a change nobody was told was dropped is worse than an error.
{
  const client = fakeClient();
  const store = await createSupabaseStore("BXQK7HRTM4WD", "nfl-win", { client });
  const init = store.init();
  client.answer("read");
  await init;

  const save = store.save(LOCK_AND_THREE);
  // The handler goes on now, not after the loop: a rejection nobody is
  // listening to yet is a crash, not a test failure.
  const refused = assert.rejects(save, /saving to this pool/, "a save that never wins reports it");
  let moved = 11;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await tick();
    // Somebody else commits between every read and every write.
    client.state.row = { entry: OPEN, updated_at: `2026-09-04T10:${(moved += 1)}:00.000Z` };
    client.answer("upsert");
    await tick();
    if (attempt < 2) client.answer("read");
  }
  await refused;
}

/* --- opening on the row in hand ------------------------------------------
   The home page's refresh reads every pool's row whole, so a board can open on
   that copy (store/rows.js) and check it behind the screen: init() answers
   without a read, and the first subscribe reads the row. A copy the row has
   moved past reaches the board the way another device's change does; one that
   has not is not news. */

{
  const client = fakeClient();
  const seeded = await createSupabaseStore("BXQK7HRTM4WD", "nfl-win", {
    client,
    seed: { entry: LOCKED, version: "2026-09-04T10:00:00.000Z" },
  });
  const opened = await seeded.init();
  assert.deepEqual(opened.picks, LOCKED.picks, "the board opens on the copy in hand");
  assert.throws(() => client.answer("read"), /no pending read/, "and owes no read for it");
  const heard = [];
  const stop = seeded.subscribe((entry) => heard.push(entry));
  await tick();
  client.answer("read");
  await tick();
  assert.deepEqual(shown(heard), [], "a copy the row still matches is not news");
  stop();
}

{
  const client = fakeClient();
  client.state.row = { entry: OPEN, updated_at: "2026-09-04T10:09:00.000Z" };
  const seeded = await createSupabaseStore("BXQK7HRTM4WD", "nfl-win", {
    client,
    seed: { entry: LOCKED, version: "2026-09-04T10:00:00.000Z" },
  });
  await seeded.init();
  const heard = [];
  const stop = seeded.subscribe((entry) => heard.push(entry));
  await tick();
  client.answer("read");
  await tick();
  assert.deepEqual(
    shown(heard),
    ["open"],
    "a copy the row has moved past is corrected behind the board",
  );
  // And a save from there carries the corrected version, not the copy's.
  const save = seeded.save(LOCKED);
  await tick();
  client.answer("upsert");
  await save;
  assert.deepEqual(
    client.state.row.entry.picks,
    LOCKED.picks,
    "the save lands on the row as it is",
  );
  stop();
}

console.log(
  "Store sync OK: own echoes and stale polls never reach the board, other devices' changes do, " +
    "a save that lost the race merges onto what won, keeps its own change, tells the board " +
    "what it merged, and gives up rather than trying for ever, and a board opened on the row " +
    "in hand is checked behind the screen.",
);
