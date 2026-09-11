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
 * league that runs several pools - even the same season played for winners and
 * for losers - has boards that never land on each other.
 */

import assert from "node:assert/strict";

/* --- a browser, enough of one -------------------------------------------- */

/** localStorage, as the directory uses it: get, set, remove, and a walk of the keys. */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
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
 * select narrowed by eq and in, update narrowed by eq and reporting what it
 * changed through select, each awaited directly or through maybeSingle. Rows
 * are keyed by code, season and objective, as the table is. Every call is
 * synchronous here; the ordering the store depends on is validate-store-sync's
 * job, not this one.
 */
function fakeTable() {
  const rows = new Map();
  let clock = 0;
  const stamp = () => `t${(clock += 1)}`;
  const keyOf = (row) => `${row.code}/${row.sport}/${row.objective}`;

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
      // What a write changed, which is how the directory knows whether the row
      // it was writing over is still the row that is there.
      select() {
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
    /** One pool's row, by the league's code and the kind it is. */
    row: (code, kind) => {
      const [sport, objective] = kind.split("-");
      return rows.get(`${code}/${sport}/${objective}`);
    },
    from(name) {
      assert.equal(name, "leagues", "the directory reads one table");
      return {
        insert(values) {
          const list = Array.isArray(values) ? values : [values];
          if (list.some((row) => rows.has(keyOf(row)))) {
            return Promise.resolve({ error: { message: "duplicate key" } });
          }
          for (const row of list) {
            rows.set(keyOf(row), { ...row, created_at: "now", updated_at: stamp() });
          }
          return Promise.resolve({ error: null });
        },
        select() {
          return query((found) => ({ data: found, error: null }));
        },
        update(values) {
          return query((found) => {
            // A version the caller supplied is its own; anything else gets one
            // from here, the way the column's default does.
            const written = found.map((row) => ({ ...row, ...values, updated_at: stamp() }));
            for (const row of written) rows.set(keyOf(row), row);
            return { data: written.map(({ updated_at }) => ({ updated_at })), error: null };
          });
        },
        delete() {
          return query((found) => {
            for (const row of found) rows.delete(keyOf(row));
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
const { CONFIG, OLD_STORAGE_PREFIXES, STORAGE_PREFIX, scopeFor } =
  await import("../src/js/config.js");
const { SPORTS, POOL_KINDS } = await import("../src/js/sports.js");
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

const made = await directory.createLeague({ name: "  The Office Pool  ", kinds: ["nfl-win"] });
assert.ok(isCode(made.code), "a new league gets a whole code");
assert.equal(made.name, "The Office Pool", "its name is trimmed");
assert.deepEqual(made.kinds, ["nfl-win"]);
assert.equal(made.shared, true, "and it was written to the table");

const row = table.row(made.code, "nfl-win");
assert.equal(row.sport, "nfl");
assert.equal(row.objective, "win", "what the picks have to do is a column of its own");
assert.deepEqual(
  row.entry.rules,
  { ...SPORTS.nfl.defaultRules, buyBackWeeks: [1, 2] },
  "a league starts on its season's rules, clamped",
);
assert.deepEqual(names(row), ["Ben"], "and its maker is in it");
assert.deepEqual(row.entry.picks, {}, "with an empty board");

// No pool, no league: there would be nothing to open.
await assert.rejects(
  () => directory.createLeague({ name: "Nothing", kinds: [] }),
  /at least one pool/,
);
await assert.rejects(
  () => directory.createLeague({ name: "Nothing", kinds: ["xfl-win", "nfl"] }),
  /at least one pool/,
  "a kind the repo does not carry counts for nothing",
);
assert.equal(table.rows.size, 1, "and nothing was written");

// A league of three pools is three rows under one code - the same season
// played both ways among them - each on its own kind's rules.
const trio = await directory.createLeague({
  name: "Both Ways",
  kinds: ["cfb-win", "nfl-lose", "nfl-win", "nfl-lose"],
});
assert.deepEqual(
  trio.kinds,
  ["nfl-win", "nfl-lose", "cfb-win"],
  "kinds come back once each, in the registry's order",
);
for (const kind of trio.kinds) {
  assert.equal(table.row(trio.code, kind).name, "Both Ways", `${kind}: carries the league's name`);
  assert.deepEqual(names(table.row(trio.code, kind)), ["Ben"], `${kind}: its maker is on it`);
}
assert.equal(table.row(trio.code, "nfl-lose").objective, "lose");
assert.equal(
  table.row(trio.code, "nfl-lose").entry.rules.objective,
  "lose",
  "a losers pool's rules say so from the start",
);
assert.equal(table.row(trio.code, "nfl-win").entry.rules.objective, "win");
assert.deepEqual(
  table.row(trio.code, "cfb-win").entry.rules,
  mergeRules(SPORTS.cfb.defaultRules),
  "the college board starts on college rules",
);
assert.notDeepEqual(
  table.row(trio.code, "nfl-win").entry.rules,
  table.row(trio.code, "cfb-win").entry.rules,
  "which are not the NFL's",
);

// The objective is the kind's, whatever an override tries to say.
const stubborn = await directory.createLeague({
  name: "Stubborn",
  kinds: ["nfl-win"],
  rules: { "nfl-win": { objective: "lose", picksPerWeek: 2 } },
});
assert.equal(table.row(stubborn.code, "nfl-win").entry.rules.objective, "win");
assert.equal(table.row(stubborn.code, "nfl-win").entry.rules.picksPerWeek, 2, "the rest lands");
assert.equal(stubborn.rules["nfl-win"].objective, "win");

// A league with no name given still has one: a nameless card is unusable.
const unnamed = await directory.createLeague({ name: "   ", kinds: ["cfb-win"] });
assert.equal(unnamed.name, "College winners pool", "an unnamed league is named after its pool");
const unnamedTwo = await directory.createLeague({ name: "", kinds: ["nfl-lose", "nfl-win"] });
assert.equal(unnamedTwo.name, "NFL winners & NFL losers pool", "or after all of them");

// This device's list, in the order the leagues were added.
assert.deepEqual(
  directory.myLeagues().map((league) => league.code),
  [made.code, trio.code, stubborn.code, unnamed.code, unnamedTwo.code],
  "the list keeps the order they were added in",
);
assert.deepEqual(
  directory.myLeagues()[1].kinds,
  ["nfl-win", "nfl-lose", "cfb-win"],
  "and knows a league's pools",
);
assert.deepEqual(
  Object.keys(directory.myLeagues()[1].rules).sort(),
  ["cfb-win", "nfl-lose", "nfl-win"],
  "with each pool's rules filed under it",
);
assert.equal(directory.myLeagues()[1].rules["nfl-lose"].objective, "lose");

// Two leagues, two boards; one league of three pools, three boards. This is
// the isolation the whole model rests on.
assert.notEqual(
  scopeFor(made.code, "nfl-win").storageKey,
  scopeFor(trio.code, "nfl-win").storageKey,
);
assert.notEqual(scopeFor(made.code, "nfl-win").entryId, scopeFor(trio.code, "nfl-win").entryId);
assert.notEqual(
  scopeFor(trio.code, "nfl-win").storageKey,
  scopeFor(trio.code, "nfl-lose").storageKey,
  "a season played both ways is two boards",
);
assert.notEqual(scopeFor(trio.code, "nfl-win").doc, scopeFor(trio.code, "cfb-win").doc);

// The hydrated list carries what the table says, not what was cached.
table.rows.set(`${made.code}/nfl/win`, {
  ...table.row(made.code, "nfl-win"),
  name: "Renamed Elsewhere",
});
const listed = await directory.refreshMyLeagues();
assert.equal(listed[0].name, "Renamed Elsewhere", "a name changed by someone else arrives");
assert.equal(listed[0].members, 1);
assert.deepEqual(
  listed[0].rules["nfl-win"],
  table.row(made.code, "nfl-win").entry.rules,
  "and so do the rules",
);
assert.deepEqual(listed[1].kinds, ["nfl-win", "nfl-lose", "cfb-win"], "every pool is listed");
assert.equal(
  listed.every((league) => !league.missing),
  true,
  "nothing is missing",
);

// A code whose league is gone is marked rather than dropped: a league that
// failed to load and one that was deleted look the same from here.
const vanished = table.row(unnamed.code, "cfb-win");
table.rows.delete(`${unnamed.code}/cfb/win`);
const withGap = await directory.refreshMyLeagues();
assert.equal(withGap[3].missing, true, "a code that does not answer is marked missing");
assert.equal(withGap[3].name, "College winners pool", "and keeps the name it was cached with");
table.rows.set(`${unnamed.code}/cfb/win`, vanished);

// Renaming, for everyone, on every pool.
const renamed = await directory.renameLeague(trio.code, "  Sunday Sweat  ");
assert.equal(renamed, "Sunday Sweat");
for (const kind of trio.kinds) {
  assert.equal(table.row(trio.code, kind).name, "Sunday Sweat", `${kind}: the row is what changed`);
}
await assert.rejects(() => directory.renameLeague(trio.code, "   "), /needs a name/);

/* --- joining -------------------------------------------------------------- */

// Another device: same table, its own storage and its own name.
const hostCode = trio.code;
reset(table);
directory.setMyName("Sam");

await assert.rejects(() => directory.joinLeague("nonsense"), /not a league code/);
await assert.rejects(() => directory.joinLeague("BXQK7HRTM4WD"), /No league has that code/);

const joined = await directory.joinLeague(formatCode(hostCode));
assert.equal(joined.code, hostCode, "a code typed with its dashes still joins");
assert.equal(joined.name, "Sunday Sweat", "and brings the league's own name back");
assert.deepEqual(
  joined.kinds,
  ["nfl-win", "nfl-lose", "cfb-win"],
  "one code joins every pool the league runs",
);
assert.deepEqual(
  directory.myLeagues().map((league) => league.code),
  [hostCode],
  "the joined league is on this device's list",
);
for (const kind of joined.kinds) {
  assert.deepEqual(
    names(table.row(hostCode, kind)),
    ["Ben", "Sam"],
    `${kind}: this person is in the members beside the one who made it`,
  );
  assert.deepEqual(table.row(hostCode, kind).entry.picks, {}, "joining does not touch the board");
}

// Joining twice is not two members.
await directory.joinLeague(hostCode);
assert.equal(table.row(hostCode, "nfl-win").entry.members.length, 2, "joining again adds nobody");

// A name changed after joining reaches the members list, on every board.
directory.setMyName("Samantha");
await directory.joinLeague(hostCode);
for (const kind of joined.kinds) {
  assert.deepEqual(
    names(table.row(hostCode, kind)),
    ["Ben", "Samantha"],
    `${kind}: a member's name is updated rather than duplicated`,
  );
}

// Leaving takes this device off the list and out of the members on every
// board, and leaves the league itself alone: shared boards mean leaving must
// not delete them.
await directory.leaveLeague(hostCode);
assert.deepEqual(directory.myLeagues(), [], "leaving clears this device's list");
for (const kind of joined.kinds) {
  assert.ok(table.row(hostCode, kind), `${kind}: the league is still there`);
  assert.deepEqual(names(table.row(hostCode, kind)), ["Ben"], `${kind}: the rest stay`);
}
assert.equal(
  storage.keys().some((key) => key.startsWith(`${CONFIG.storage.entryPrefix}/${hostCode}`)),
  false,
  "and this device's copies of its boards are cleaned up",
);

// leagueByCode is what a link opens with, and it reads the table.
const found = await directory.leagueByCode(formatCode(hostCode));
assert.equal(found.code, hostCode);
assert.deepEqual(found.kinds, ["nfl-win", "nfl-lose", "cfb-win"], "with every pool");
assert.equal(await directory.leagueByCode("BXQK7HRTM4WD"), null, "an unknown code opens nothing");

/* --- taking pools and leagues down --------------------------------------- */

// Back as the maker, with the league on this device's list again.
reset(table);
directory.setMyName("Ben");
await directory.joinLeague(hostCode);
storage.setItem(scopeFor(hostCode, "nfl-lose").storageKey, "{}");
storage.setItem(scopeFor(hostCode, "nfl-win").storageKey, "{}");

await assert.rejects(() => directory.removePool(hostCode, "xfl-win"), /not one of/);
await assert.rejects(
  () => directory.removePool(hostCode, "cfb-lose"),
  /not in this league/,
  "a kind the league does not run cannot be removed from it",
);

// One pool goes: its row, its place on this device's list, and its board copy.
await directory.removePool(hostCode, "nfl-lose");
assert.equal(table.row(hostCode, "nfl-lose"), undefined, "the pool's row is gone");
assert.ok(table.row(hostCode, "nfl-win") && table.row(hostCode, "cfb-win"), "the others stay");
assert.deepEqual(directory.myLeagues()[0].kinds, ["nfl-win", "cfb-win"], "the list follows");
assert.deepEqual(
  Object.keys(directory.myLeagues()[0].rules).sort(),
  ["cfb-win", "nfl-win"],
  "and so do the rules",
);
assert.equal(storage.getItem(scopeFor(hostCode, "nfl-lose").storageKey), null, "its copy is gone");
assert.equal(storage.getItem(scopeFor(hostCode, "nfl-win").storageKey), "{}", "the rest are kept");
await assert.rejects(() => directory.removePool(hostCode, "nfl-lose"), /not in this league/);

// The last pool stays: a league with no board is nothing to open.
await directory.removePool(hostCode, "cfb-win");
await assert.rejects(() => directory.removePool(hostCode, "nfl-win"), /last pool/);
assert.ok(table.row(hostCode, "nfl-win"), "and the row is still there");

// The whole league goes, and only that league.
await directory.deleteLeague(hostCode);
assert.equal(
  [...table.rows.values()].some((row) => row.code === hostCode),
  false,
  "every row of the league is gone",
);
assert.ok(table.row(made.code, "nfl-win"), "other leagues are untouched");
assert.deepEqual(directory.myLeagues(), [], "it is off this device's list");
assert.equal(
  storage.keys().some((key) => key.startsWith(`${CONFIG.storage.entryPrefix}/${hostCode}`)),
  false,
  "and every copy of its boards is gone",
);

/* --- what came before ----------------------------------------------------- */

// A row from a table that has not been migrated carries the objective in its
// rules and no column: it reads as the pool it always was.
table.rows.set("QWERTYASDFGH/nfl/undefined", {
  code: "QWERTYASDFGH",
  name: "Old Losers",
  sport: "nfl",
  entry: { picks: {}, swaps: {}, rules: { objective: "lose", picksPerWeek: 1 }, members: [] },
});
const oldRow = await directory.leagueByCode("QWERTYASDFGH");
assert.deepEqual(oldRow.kinds, ["nfl-lose"], "an old losers row is an NFL losers pool");
assert.equal(oldRow.rules["nfl-lose"].objective, "lose");

// A cached list from before a league could hold more than one pool: one
// `sport` and one flat set of rules, whose objective says which kind it was.
reset(table);
storage.setItem(
  CONFIG.storage.leagues,
  JSON.stringify([
    {
      code: made.code,
      name: "Old Shape",
      sport: "nfl",
      rules: { ...SPORTS.nfl.defaultRules, objective: "lose" },
      joinedAt: "then",
    },
    { code: "QWERTYASDFGH", name: "Older Shape", sport: "nfl", joinedAt: "then" },
  ]),
);
const [old, older] = directory.myLeagues();
assert.deepEqual(old.kinds, ["nfl-lose"], "a cached league reads as the kind its rules say");
assert.deepEqual(old.rules, { "nfl-lose": { ...SPORTS.nfl.defaultRules, objective: "lose" } });
assert.equal(old.sport, undefined, "and the old key is gone");
assert.equal(old.joinedAt, "then", "without losing when it was joined");
assert.deepEqual(older.kinds, ["nfl-win"], "one with no rules cached is a winners pool");
assert.deepEqual(older.rules, {});
const [refreshedOld] = await directory.refreshMyLeagues();
assert.equal(refreshedOld.name, "Renamed Elsewhere", "and it still refreshes from the table");
assert.deepEqual(refreshedOld.kinds, ["nfl-win"], "which corrects the kind to what the table says");
assert.deepEqual(
  JSON.parse(storage.getItem(CONFIG.storage.leagues))[0].kinds,
  ["nfl-win"],
  "and rewrites the list in the new shape",
);

/* --- with no table at all ------------------------------------------------- */

reset(null);
directory.setMyName("Alone");

const local = await directory.createLeague({ name: "Just Me", kinds: ["nfl-win", "cfb-lose"] });
assert.equal(local.shared, false, "with no backend a league is made anyway");
assert.ok(isCode(local.code), "and still gets a code");
assert.deepEqual(local.kinds, ["nfl-win", "cfb-lose"], "with every pool asked for");
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

// Pools and leagues can be taken down here too, off the list alone.
await directory.removePool(local.code, "cfb-lose");
assert.deepEqual(directory.myLeagues()[0].kinds, ["nfl-win"], "a pool comes off the list");
await assert.rejects(() => directory.removePool(local.code, "nfl-win"), /last pool/);
await directory.deleteLeague(local.code);
assert.deepEqual(directory.myLeagues(), [], "and a league comes off it whole");

/* --- a device from before the rename keeps everything -------------------- */

// Every key the app has ever written starts with the current prefix, and the
// old prefix is not it: otherwise there would be nothing to bring across.
for (const key of Object.values(CONFIG.storage)) assert.ok(key.startsWith(STORAGE_PREFIX));
assert.ok(OLD_STORAGE_PREFIXES.length > 0 && !OLD_STORAGE_PREFIXES.includes(STORAGE_PREFIX));

storage.clear();
const [oldPrefix] = OLD_STORAGE_PREFIXES;
const oldKeys = {
  [`${oldPrefix}passcode`]: "digest-from-before",
  [`${oldPrefix}name`]: "Sam",
  [`${oldPrefix}who`]: "d-old12345",
  [`${oldPrefix}leagues/v1`]: JSON.stringify([{ code: "BXQK7HRTM4WD", kinds: ["nfl-win"] }]),
  [`${oldPrefix}entry/v2/BXQK7HRTM4WD/nfl-win`]: JSON.stringify({ picks: {} }),
};
for (const [key, value] of Object.entries(oldKeys)) storage.setItem(key, value);
storage.setItem(`${STORAGE_PREFIX}who`, "d-new67890");
storage.setItem("someone-else/setting", "left alone");

directory.adoptOldStorage();

assert.equal(storage.getItem(CONFIG.storage.passcode), "digest-from-before", "the door stays open");
assert.equal(directory.myName(), "Sam", "the name is still known");
assert.equal(storage.getItem(CONFIG.storage.who), "d-new67890", "a key the new name holds wins");
assert.equal(directory.myLeagues()[0]?.code, "BXQK7HRTM4WD", "the league list is intact");
assert.equal(
  storage.getItem(scopeFor("BXQK7HRTM4WD", "nfl-win").storageKey),
  JSON.stringify({ picks: {} }),
  "and so is the offline board",
);
assert.ok(
  !storage.keys().some((key) => key.startsWith(oldPrefix)),
  "nothing is left under the old name",
);
assert.equal(storage.getItem("someone-else/setting"), "left alone", "other keys are not touched");
directory.adoptOldStorage();
assert.equal(
  storage.getItem(CONFIG.storage.who),
  "d-new67890",
  "and running again changes nothing",
);
storage.clear();

/* --- codes are read as people type them ---------------------------------- */

assert.equal(normaliseCode(" bxqk-7hrt m4wd "), "BXQK7HRTM4WD");
assert.equal(formatCode("BXQK7HRTM4WD"), "BXQK-7HRT-M4WD");
assert.ok(POOL_KINDS["nfl-win"], "the registry the directory keys on is there");

console.log(
  "Directory OK: a league is made with a code, a row per pool and each pool's own rules with " +
    "the objective fixed, a code joins every pool of it and adds one member however often it " +
    "is used, leaving keeps the league and its other members, two leagues never share a board " +
    "and nor do a league's pools, a pool can be removed but never the last one, a league can " +
    "be deleted whole, old rows and old lists read as the pools they were, a device from " +
    "before the rename keeps its code, name, leagues and boards, and a build with no backend " +
    "still makes leagues that work.",
);
