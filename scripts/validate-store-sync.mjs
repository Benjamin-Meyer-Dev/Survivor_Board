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
import { CONFIG } from "../src/js/config.js";

const LOCKED = { picks: { "1-0": { locked: true } }, swaps: {} };
const OPEN = { picks: {}, swaps: {} };

/** Postgres renders a timestamptz with an offset; the client sends a Z. */
const pg = (iso) => iso.replace("Z", "+00:00");
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
        select() {
          return {
            eq() {
              return {
                maybeSingle: () => {
                  // A read sees the row as it stands when the request is issued.
                  const snapshot = { ...state.row, updated_at: pg(state.row.updated_at) };
                  return later("read", () => ({ data: snapshot, error: null }));
                },
              };
            },
          };
        },
        upsert(values) {
          return later("upsert", () => {
            state.row = { entry: values.entry, updated_at: values.updated_at };
            // Realtime fires on commit; the test decides when it is heard.
            client.echoes.push({ new: { ...state.row, updated_at: pg(state.row.updated_at) } });
            return { error: null };
          });
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
  const store = await createSupabaseStore("nfl", { client });
  store.unlock(CONFIG.passcode.digest);
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
  client.from = () => ({
    ...original(),
    upsert: () => Promise.resolve({ error: new Error("offline") }),
  });
  await assert.rejects(store.save(OPEN));
  client.from = original;
  client.state.row = { entry: OPEN, updated_at: "2026-09-04T10:07:00.000Z" };
  client.poll();
  await tick();
  client.answer("read");
  await tick();
});

console.log(
  "Store sync OK: own echoes and stale polls never reach the board, other devices' changes do.",
);
