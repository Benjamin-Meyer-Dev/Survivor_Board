#!/usr/bin/env node
/**
 * The league directory: making a league, joining one by code, listing the ones
 * a device is in, renaming, and leaving.
 *
 * This is the part of the app with no board to check it against, so it is
 * checked here. Two backends are exercised - a fake table, and no table at all
 * - because the second one is what a build with no keys runs on, and a league
 * has to work on a phone that cannot share it.
 *
 * What matters most is the two rules that keep leagues apart: a league's code
 * is the only way to it, and one league's board can never land on another's.
 */

import assert from "node:assert/strict";

/* --- a browser, enough of one -------------------------------------------- */

/** localStorage, as the directory uses it: get, set, remove. */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    get size() {
      return map.size;
    },
    keys: () => [...map.keys()],
  };
}

const storage = fakeStorage();
globalThis.localStorage = storage;

/* --- a table, enough of one ---------------------------------------------- */

/**
 * The slice of supabase-js the directory calls: insert, select by code, select
 * by a list of codes, and update by code. Every call is synchronous here; the
 * ordering the store depends on is validate-store-sync's job, not this one.
 */
function fakeTable() {
  const rows = new Map();

  const client = {
    rows,
    from(name) {
      assert.equal(name, "leagues", "the directory reads one table");
      return {
        insert(values) {
          if (rows.has(values.code)) {
            return Promise.resolve({ error: { message: "duplicate key" } });
          }
          rows.set(values.code, { ...values, created_at: "now", updated_at: "now" });
          return Promise.resolve({ error: null });
        },
        select() {
          return {
            eq(_column, code) {
              return {
                maybeSingle: () => Promise.resolve({ data: rows.get(code) ?? null, error: null }),
              };
            },
            in(_column, codes) {
              return Promise.resolve({
                data: codes.map((code) => rows.get(code)).filter(Boolean),
                error: null,
              });
            },
          };
        },
        update(values) {
          return {
            eq(_column, code) {
              const row = rows.get(code);
              if (row) rows.set(code, { ...row, ...values });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
  return client;
}

/* --- the modules under test ---------------------------------------------- */

const { setSupabaseClient } = await import("../src/js/store/client.js");
const directory = await import("../src/js/store/directory.js");
const { isCode, normaliseCode, formatCode } = await import("../src/js/core/code.js");
const { CONFIG, scopeFor } = await import("../src/js/config.js");
const { SPORTS } = await import("../src/js/sports.js");

const reset = (client) => {
  storage.clear();
  setSupabaseClient(client ?? null);
};

/* --- with a table --------------------------------------------------------- */

const table = fakeTable();
reset(table);

directory.setMyName("  Ben  ");
assert.equal(directory.myName(), "Ben", "a name is stored trimmed");
const id = directory.myId();
assert.equal(directory.myId(), id, "a device's id is stable");
assert.ok(id.startsWith("d-"), "and is a device id, not a person");

const made = await directory.createLeague({ name: "  The Office Pool  ", sport: "nfl" });
assert.ok(isCode(made.code), "a new league gets a whole code");
assert.equal(made.name, "The Office Pool", "its name is trimmed");
assert.equal(made.sport, "nfl");
assert.equal(made.shared, true, "and it was written to the table");

const row = table.rows.get(made.code);
assert.equal(row.sport, "nfl");
assert.deepEqual(
  row.entry.rules,
  { ...SPORTS.nfl.defaultRules, buyBackWeeks: [1, 2] },
  "a league starts on its season's rules, clamped",
);
assert.deepEqual(
  row.entry.members.map((member) => member.name),
  ["Ben"],
  "and its maker is in it",
);
assert.deepEqual(row.entry.picks, {}, "with an empty board");

// A league with no name given still has one: a nameless card is unusable.
const unnamed = await directory.createLeague({ name: "   ", sport: "cfb" });
assert.equal(unnamed.name, "College survivor", "an unnamed league is named after its season");

// This device's list, in the order the leagues were added.
assert.deepEqual(
  directory.myLeagues().map((league) => league.code),
  [made.code, unnamed.code],
  "the list keeps the order they were added in",
);

// Two leagues, two boards. This is the isolation the whole model rests on.
assert.notEqual(scopeFor(made.code).storageKey, scopeFor(unnamed.code).storageKey);
assert.notEqual(scopeFor(made.code).entryId, scopeFor(unnamed.code).entryId);

// The hydrated list carries what the table says, not what was cached.
table.rows.set(made.code, { ...table.rows.get(made.code), name: "Renamed Elsewhere" });
const listed = await directory.refreshMyLeagues();
assert.equal(listed[0].name, "Renamed Elsewhere", "a name changed by someone else arrives");
assert.equal(listed[0].members, 1);
assert.deepEqual(listed[0].rules, table.rows.get(made.code).entry.rules, "and so do the rules");
assert.equal(
  listed.every((league) => !league.missing),
  true,
  "nothing is missing",
);

// A code whose league is gone is marked rather than dropped: a league that
// failed to load and one that was deleted look the same from here.
const vanished = table.rows.get(unnamed.code);
table.rows.delete(unnamed.code);
const withGap = await directory.refreshMyLeagues();
assert.equal(withGap[1].missing, true, "a code that does not answer is marked missing");
assert.equal(withGap[1].name, "College survivor", "and keeps the name it was cached with");
table.rows.set(unnamed.code, vanished);

// Renaming, for everyone.
const renamed = await directory.renameLeague(made.code, "  Sunday Sweat  ");
assert.equal(renamed, "Sunday Sweat");
assert.equal(table.rows.get(made.code).name, "Sunday Sweat", "the row is what changed");
await assert.rejects(() => directory.renameLeague(made.code, "   "), /needs a name/);

/* --- joining -------------------------------------------------------------- */

// Another device: same table, its own storage and its own name.
const hostCode = made.code;
reset(table);
directory.setMyName("Sam");

await assert.rejects(() => directory.joinLeague("nonsense"), /not a league code/);
await assert.rejects(() => directory.joinLeague("BXQK7HRTM4WD"), /No league has that code/);

const joined = await directory.joinLeague(formatCode(hostCode));
assert.equal(joined.code, hostCode, "a code typed with its dashes still joins");
assert.equal(joined.name, "Sunday Sweat", "and brings the league's own name back");
assert.deepEqual(
  directory.myLeagues().map((league) => league.code),
  [hostCode],
  "the joined league is on this device's list",
);
assert.deepEqual(
  table.rows
    .get(hostCode)
    .entry.members.map((member) => member.name)
    .sort(),
  ["Ben", "Sam"],
  "and this person is in the members beside the one who made it",
);
assert.deepEqual(table.rows.get(hostCode).entry.picks, {}, "joining does not touch the board");

// Joining twice is not two members.
await directory.joinLeague(hostCode);
assert.equal(table.rows.get(hostCode).entry.members.length, 2, "joining again adds nobody");

// A name changed after joining reaches the members list.
directory.setMyName("Samantha");
await directory.joinLeague(hostCode);
assert.deepEqual(
  table.rows
    .get(hostCode)
    .entry.members.map((member) => member.name)
    .sort(),
  ["Ben", "Samantha"],
  "a member's name is updated rather than duplicated",
);

// Leaving takes this device off the list and out of the members, and leaves
// the league itself alone: one shared board means leaving must not delete it.
await directory.leaveLeague(hostCode);
assert.deepEqual(directory.myLeagues(), [], "leaving clears this device's list");
assert.ok(table.rows.has(hostCode), "but the league is still there");
assert.deepEqual(
  table.rows.get(hostCode).entry.members.map((member) => member.name),
  ["Ben"],
  "with the rest of its members",
);
assert.equal(
  storage.keys().some((key) => key.startsWith(`${CONFIG.storage.entryPrefix}/${hostCode}`)),
  false,
  "and this device's copy of its board is cleaned up",
);

// leagueByCode is what a link opens with, and it reads the table.
const found = await directory.leagueByCode(formatCode(hostCode));
assert.equal(found.code, hostCode);
assert.equal(await directory.leagueByCode("BXQK7HRTM4WD"), null, "an unknown code opens nothing");

/* --- with no table at all ------------------------------------------------- */

reset(null);
directory.setMyName("Alone");

const local = await directory.createLeague({ name: "Just Me", sport: "nfl" });
assert.equal(local.shared, false, "with no backend a league is made anyway");
assert.ok(isCode(local.code), "and still gets a code");
assert.deepEqual(
  directory.myLeagues().map((league) => league.name),
  ["Just Me"],
  "and is on this device's list",
);

// Its own code opens it; anyone else's cannot, and says why.
assert.equal((await directory.joinLeague(local.code)).code, local.code);
await assert.rejects(() => directory.joinLeague("BXQK7HRTM4WD"), /Sharing is off/);

const offline = await directory.refreshMyLeagues();
assert.equal(offline.length, 1, "the list still lists it");
assert.equal(offline[0].missing, false, "and does not call it missing");

/* --- codes are read as people type them ---------------------------------- */

assert.equal(normaliseCode(" bxqk-7hrt m4wd "), "BXQK7HRTM4WD");
assert.equal(formatCode("BXQK7HRTM4WD"), "BXQK-7HRT-M4WD");

console.log(
  "Directory OK: a league is made with a code and its season's rules, a code joins it and " +
    "adds one member however often it is used, leaving keeps the league and its other members, " +
    "two leagues never share a board, and a build with no backend still makes leagues that work.",
);
