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
 * What matters most is the rules that keep leagues apart: a league's code is
 * the only way to it, one league's board can never land on another's, and a
 * league that plays two seasons has two boards that never land on each other.
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
 * The slice of supabase-js the directory calls: insert (one row or several),
 * select narrowed by eq and in, update narrowed by eq, each awaited directly
 * or through maybeSingle. Rows are keyed by code and season, as the table is.
 * Every call is synchronous here; the ordering the store depends on is
 * validate-store-sync's job, not this one.
 */
function fakeTable() {
  const rows = new Map();
  const keyOf = (row) => `${row.code}/${row.sport}`;

  /** A query: filters chain, and the request goes out when the chain is read. */
  const query = (apply) => {
    const filters = [];
    const matching = () => [...rows.values()].filter((row) => filters.every((keep) => keep(row)));
    const chain = {
      eq(column, value) {
        filters.push((row) => row[column] === value);
        return chain;
      },
      in(column, values) {
        filters.push((row) => values.includes(row[column]));
        return chain;
      },
      maybeSingle() {
        return Promise.resolve({ data: matching()[0] ?? null, error: null });
      },
      then(resolve, reject) {
        return Promise.resolve(apply(matching())).then(resolve, reject);
      },
    };
    return chain;
  };

  return {
    rows,
    row: (code, sport) => rows.get(`${code}/${sport}`),
    from(name) {
      assert.equal(name, "leagues", "the directory reads one table");
      return {
        insert(values) {
          const list = Array.isArray(values) ? values : [values];
          if (list.some((row) => rows.has(keyOf(row)))) {
            return Promise.resolve({ error: { message: "duplicate key" } });
          }
          for (const row of list) {
            rows.set(keyOf(row), { ...row, created_at: "now", updated_at: "now" });
          }
          return Promise.resolve({ error: null });
        },
        select() {
          return query((found) => ({ data: found, error: null }));
        },
        update(values) {
          return query((found) => {
            for (const row of found) rows.set(keyOf(row), { ...row, ...values });
            return { error: null };
          });
        },
      };
    },
  };
}

/* --- the modules under test ---------------------------------------------- */

const { setSupabaseClient } = await import("../src/js/store/client.js");
const directory = await import("../src/js/store/directory.js");
const { isCode, normaliseCode, formatCode } = await import("../src/js/core/code.js");
const { CONFIG, scopeFor } = await import("../src/js/config.js");
const { SPORTS } = await import("../src/js/sports.js");
const { mergeRules } = await import("../src/js/core/rules.js");

const reset = (client) => {
  storage.clear();
  setSupabaseClient(client ?? null);
};

const names = (row) => row.entry.members.map((member) => member.name).sort();

/* --- with a table --------------------------------------------------------- */

const table = fakeTable();
reset(table);

directory.setMyName("  Ben  ");
assert.equal(directory.myName(), "Ben", "a name is stored trimmed");
const id = directory.myId();
assert.equal(directory.myId(), id, "a device's id is stable");
assert.ok(id.startsWith("d-"), "and is a device id, not a person");

const made = await directory.createLeague({ name: "  The Office Pool  ", sports: ["nfl"] });
assert.ok(isCode(made.code), "a new league gets a whole code");
assert.equal(made.name, "The Office Pool", "its name is trimmed");
assert.deepEqual(made.sports, ["nfl"]);
assert.equal(made.shared, true, "and it was written to the table");

const row = table.row(made.code, "nfl");
assert.equal(row.sport, "nfl");
assert.deepEqual(
  row.entry.rules,
  { ...SPORTS.nfl.defaultRules, buyBackWeeks: [1, 2] },
  "a league starts on its season's rules, clamped",
);
assert.deepEqual(names(row), ["Ben"], "and its maker is in it");
assert.deepEqual(row.entry.picks, {}, "with an empty board");

// No season, no league: there would be nothing to open.
await assert.rejects(
  () => directory.createLeague({ name: "Nothing", sports: [] }),
  /at least one season/,
);
await assert.rejects(
  () => directory.createLeague({ name: "Nothing", sports: ["xfl"] }),
  /at least one season/,
  "a season the repo does not carry counts for nothing",
);
assert.equal(table.rows.size, 1, "and nothing was written");

// A league of two seasons is two rows under one code, each on its own season's
// rules, and one entry on this device.
const both = await directory.createLeague({ name: "Both Ways", sports: ["cfb", "nfl", "cfb"] });
assert.deepEqual(
  both.sports,
  ["nfl", "cfb"],
  "seasons come back once each, in the registry's order",
);
assert.equal(table.row(both.code, "nfl").name, "Both Ways");
assert.equal(table.row(both.code, "cfb").name, "Both Ways", "both rows carry the league's name");
assert.deepEqual(
  table.row(both.code, "cfb").entry.rules,
  mergeRules(SPORTS.cfb.defaultRules),
  "the college board starts on college rules",
);
assert.notDeepEqual(
  table.row(both.code, "nfl").entry.rules,
  table.row(both.code, "cfb").entry.rules,
  "which are not the NFL's",
);
assert.deepEqual(names(table.row(both.code, "nfl")), ["Ben"]);
assert.deepEqual(names(table.row(both.code, "cfb")), ["Ben"], "its maker is on every board");

// A league with no name given still has one: a nameless card is unusable.
const unnamed = await directory.createLeague({ name: "   ", sports: ["cfb"] });
assert.equal(unnamed.name, "College survivor", "an unnamed league is named after its season");
const unnamedBoth = await directory.createLeague({ name: "", sports: ["nfl", "cfb"] });
assert.equal(unnamedBoth.name, "NFL & College survivor", "or after all of them");

// This device's list, in the order the leagues were added.
assert.deepEqual(
  directory.myLeagues().map((league) => league.code),
  [made.code, both.code, unnamed.code, unnamedBoth.code],
  "the list keeps the order they were added in",
);
assert.deepEqual(directory.myLeagues()[1].sports, ["nfl", "cfb"], "and knows a league's seasons");
assert.deepEqual(
  Object.keys(directory.myLeagues()[1].rules).sort(),
  ["cfb", "nfl"],
  "with each season's rules filed under it",
);

// Two leagues, two boards; one league of two seasons, two boards as well. This
// is the isolation the whole model rests on.
assert.notEqual(scopeFor(made.code, "nfl").storageKey, scopeFor(unnamed.code, "cfb").storageKey);
assert.notEqual(scopeFor(made.code, "nfl").entryId, scopeFor(unnamed.code, "cfb").entryId);
assert.notEqual(
  scopeFor(both.code, "nfl").storageKey,
  scopeFor(both.code, "cfb").storageKey,
  "a league's two seasons never share a board",
);
assert.notEqual(scopeFor(both.code, "nfl").doc, scopeFor(both.code, "cfb").doc);

// The hydrated list carries what the table says, not what was cached.
table.rows.set(`${made.code}/nfl`, { ...table.row(made.code, "nfl"), name: "Renamed Elsewhere" });
const listed = await directory.refreshMyLeagues();
assert.equal(listed[0].name, "Renamed Elsewhere", "a name changed by someone else arrives");
assert.equal(listed[0].members, 1);
assert.deepEqual(
  listed[0].rules.nfl,
  table.row(made.code, "nfl").entry.rules,
  "and so do the rules",
);
assert.deepEqual(listed[1].sports, ["nfl", "cfb"], "a two-season league lists both seasons");
assert.equal(
  listed.every((league) => !league.missing),
  true,
  "nothing is missing",
);

// A code whose league is gone is marked rather than dropped: a league that
// failed to load and one that was deleted look the same from here.
const vanished = table.row(unnamed.code, "cfb");
table.rows.delete(`${unnamed.code}/cfb`);
const withGap = await directory.refreshMyLeagues();
assert.equal(withGap[2].missing, true, "a code that does not answer is marked missing");
assert.equal(withGap[2].name, "College survivor", "and keeps the name it was cached with");
table.rows.set(`${unnamed.code}/cfb`, vanished);

// Renaming, for everyone, on every season.
const renamed = await directory.renameLeague(both.code, "  Sunday Sweat  ");
assert.equal(renamed, "Sunday Sweat");
assert.equal(table.row(both.code, "nfl").name, "Sunday Sweat", "the rows are what changed");
assert.equal(table.row(both.code, "cfb").name, "Sunday Sweat", "every one of them");
await assert.rejects(() => directory.renameLeague(both.code, "   "), /needs a name/);

/* --- joining -------------------------------------------------------------- */

// Another device: same table, its own storage and its own name.
const hostCode = both.code;
reset(table);
directory.setMyName("Sam");

await assert.rejects(() => directory.joinLeague("nonsense"), /not a league code/);
await assert.rejects(() => directory.joinLeague("BXQK7HRTM4WD"), /No league has that code/);

const joined = await directory.joinLeague(formatCode(hostCode));
assert.equal(joined.code, hostCode, "a code typed with its dashes still joins");
assert.equal(joined.name, "Sunday Sweat", "and brings the league's own name back");
assert.deepEqual(joined.sports, ["nfl", "cfb"], "one code joins every season the league plays");
assert.deepEqual(
  directory.myLeagues().map((league) => league.code),
  [hostCode],
  "the joined league is on this device's list",
);
for (const sport of ["nfl", "cfb"]) {
  assert.deepEqual(
    names(table.row(hostCode, sport)),
    ["Ben", "Sam"],
    `${sport}: this person is in the members beside the one who made it`,
  );
  assert.deepEqual(table.row(hostCode, sport).entry.picks, {}, "joining does not touch the board");
}

// Joining twice is not two members.
await directory.joinLeague(hostCode);
assert.equal(table.row(hostCode, "nfl").entry.members.length, 2, "joining again adds nobody");

// A name changed after joining reaches the members list, on every board.
directory.setMyName("Samantha");
await directory.joinLeague(hostCode);
assert.deepEqual(names(table.row(hostCode, "nfl")), ["Ben", "Samantha"]);
assert.deepEqual(
  names(table.row(hostCode, "cfb")),
  ["Ben", "Samantha"],
  "a member's name is updated rather than duplicated",
);

// Leaving takes this device off the list and out of the members on every
// board, and leaves the league itself alone: shared boards mean leaving must
// not delete them.
await directory.leaveLeague(hostCode);
assert.deepEqual(directory.myLeagues(), [], "leaving clears this device's list");
assert.ok(table.rows.has(`${hostCode}/nfl`) && table.rows.has(`${hostCode}/cfb`));
for (const sport of ["nfl", "cfb"]) {
  assert.deepEqual(names(table.row(hostCode, sport)), ["Ben"], `${sport}: the rest stay`);
}
assert.equal(
  storage.keys().some((key) => key.startsWith(`${CONFIG.storage.entryPrefix}/${hostCode}`)),
  false,
  "and this device's copies of its boards are cleaned up",
);

// leagueByCode is what a link opens with, and it reads the table.
const found = await directory.leagueByCode(formatCode(hostCode));
assert.equal(found.code, hostCode);
assert.deepEqual(found.sports, ["nfl", "cfb"], "with every season, so any of them can open");
assert.equal(await directory.leagueByCode("BXQK7HRTM4WD"), null, "an unknown code opens nothing");

/* --- a list from before a league could hold more than one season ---------- */

reset(table);
storage.setItem(
  CONFIG.storage.leagues,
  JSON.stringify([
    {
      code: made.code,
      name: "Old Shape",
      sport: "nfl",
      rules: SPORTS.nfl.defaultRules,
      joinedAt: "then",
    },
  ]),
);
const [old] = directory.myLeagues();
assert.deepEqual(
  old.sports,
  ["nfl"],
  "a cached league with one sport reads as a league of that season",
);
assert.deepEqual(old.rules, { nfl: SPORTS.nfl.defaultRules }, "with its rules filed under it");
assert.equal(old.sport, undefined, "and the old key is gone");
assert.equal(old.joinedAt, "then", "without losing when it was joined");
const [refreshedOld] = await directory.refreshMyLeagues();
assert.equal(refreshedOld.name, "Renamed Elsewhere", "and it still refreshes from the table");
assert.deepEqual(
  JSON.parse(storage.getItem(CONFIG.storage.leagues))[0].sports,
  ["nfl"],
  "which rewrites the list in the new shape",
);

/* --- with no table at all ------------------------------------------------- */

reset(null);
directory.setMyName("Alone");

const local = await directory.createLeague({ name: "Just Me", sports: ["nfl", "cfb"] });
assert.equal(local.shared, false, "with no backend a league is made anyway");
assert.ok(isCode(local.code), "and still gets a code");
assert.deepEqual(local.sports, ["nfl", "cfb"], "with every season asked for");
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
  "Directory OK: a league is made with a code, a row per season and each season's own rules, " +
    "a code joins every season of it and adds one member however often it is used, leaving " +
    "keeps the league and its other members, two leagues never share a board and nor do a " +
    "league's seasons, an old list reads as leagues of one season, and a build with no " +
    "backend still makes leagues that work.",
);
