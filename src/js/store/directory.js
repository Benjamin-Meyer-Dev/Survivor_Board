/**
 * The league directory: which leagues exist, and which of them this device is
 * in.
 *
 * Two halves, deliberately.
 *
 * The **shared** half is the `leagues` table in Supabase: one row per pool,
 * keyed by a league's code, the season the pool plays and what its picks have
 * to do. A league is every row that shares a code - one name, one set of
 * members, and a board for each pool it was made with, so an NFL winners pool,
 * an NFL losers pool and a college pool can go to the same people as one link.
 * Which pools a league runs, and whether each is played for winners or for
 * losers, is fixed when it is made (see POOL_KINDS in sports.js). Creating a
 * league inserts a row per pool; joining one reads them all by code. There are
 * no accounts, so the code is the credential - see supabase/schema.sql for
 * exactly what that does and does not protect.
 *
 * The **local** half is the list of codes on this phone, with the name, the
 * kinds of pool and each pool's rules cached beside each. It is what the home
 * page draws before the network answers, and it is what "your leagues" means:
 * a league nobody on this device has joined is not lost, it is simply not
 * listed here, and pasting its code back in brings it back. Leaving a league
 * removes it from this list and takes this person out of the members; it never
 * deletes anyone else's league.
 *
 * With no Supabase configured the shared half is absent: leagues still work,
 * but only on the phone that made them, and the home page says so.
 */

import { CONFIG, scopeFor } from "../config.js";
import { newCode, normaliseCode, isCode } from "../core/code.js";
import { SPORTS, POOL_KINDS, KIND_IDS, kindId, normaliseKinds, kindsLabel } from "../sports.js";
import { mergeRules } from "../core/rules.js";
import { supabaseClient } from "./client.js";
import { rememberRow, forgetRows } from "./rows.js";

export { sharingAvailable } from "./client.js";
export { knownRow } from "./rows.js";

/** The one client the app loads, shared with a league's own store. */
const supabase = supabaseClient;

/**
 * Every column, so a table from before `objective` was one still answers; what
 * is read off a row is decided in rowToPool.
 */
const COLUMNS = "*";

/* --- this device's list --------------------------------------------------- */

/**
 * @returns {Array<{code:string, name:string, kinds:string[],
 *   rules:Object<string,object>, joinedAt:string}>} In the order they were
 *   added, which is the order the home page shows them. `kinds` are kind ids
 *   from sports.js and `rules` is keyed by them.
 */
export function myLeagues() {
  try {
    const raw = localStorage.getItem(CONFIG.storage.leagues);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((league) => isCode(league?.code)).map(fromCache) : [];
  } catch {
    return [];
  }
}

/**
 * A cached league in today's shape.
 *
 * Lists written before a league could hold more than one pool carry one
 * `sport` and one flat set of `rules`, whose objective says which way that
 * pool was played; a short-lived shape in between carried `sports` with rules
 * by season. Either is read as a league of those kinds and rewritten in the new
 * shape the next time anything about it is remembered.
 */
function fromCache(entry) {
  const { sport, sports, ...league } = entry;
  const rules = league.rules && typeof league.rules === "object" ? league.rules : {};
  let kinds;
  let byKind;
  if (Array.isArray(league.kinds)) {
    kinds = league.kinds;
    byKind = rules;
  } else if (Array.isArray(sports)) {
    kinds = sports.map((id) => kindId(id, rules[id]?.objective));
    byKind = Object.fromEntries(sports.map((id, index) => [kinds[index], rules[id]]));
  } else {
    const flat = "picksPerWeek" in rules || "objective" in rules ? rules : null;
    const kind = kindId(sport, flat?.objective);
    kinds = [kind];
    byKind = flat ? { [kind]: flat } : {};
  }
  const known = normaliseKinds(kinds);
  return {
    ...league,
    kinds: known.length ? known : [KIND_IDS[0]],
    rules: Object.fromEntries(
      Object.entries(byKind).filter(([id, value]) => id in POOL_KINDS && value),
    ),
  };
}

function writeMyLeagues(list) {
  try {
    localStorage.setItem(CONFIG.storage.leagues, JSON.stringify(list));
  } catch {
    /* private mode or a full quota: the list lives for this session only */
  }
}

/** Add or update one league in this device's list, keeping the order stable. */
function remember(league) {
  const list = myLeagues();
  const index = list.findIndex((entry) => entry.code === league.code);
  const known = list[index] ?? { joinedAt: new Date().toISOString() };
  const merged = {
    ...known,
    ...league,
    // Per pool, so what arrives about one does not drop what was known about
    // another.
    rules: { ...(known.rules ?? {}), ...(league.rules ?? {}) },
  };
  if (index >= 0) list[index] = merged;
  else list.push(merged);
  writeMyLeagues(list);
  return merged;
}

/** Take a league off this device's list. The league itself stays where it is. */
export function forget(code) {
  writeMyLeagues(myLeagues().filter((league) => league.code !== normaliseCode(code)));
}

/* --- identity ------------------------------------------------------------- */

/** This person's name, or "" until they have given one. */
export function myName() {
  try {
    return localStorage.getItem(CONFIG.storage.name) ?? "";
  } catch {
    return "";
  }
}

export function setMyName(name) {
  try {
    localStorage.setItem(CONFIG.storage.name, name.trim().slice(0, 40));
  } catch {
    /* nothing to do: the name is asked for again next launch */
  }
}

/**
 * This device's id, saved against every lock and pick and used to tell one
 * member from another. Random and local: it identifies a phone, not a person,
 * which is the most an app with no accounts can honestly claim.
 */
export function myId() {
  try {
    const stored = localStorage.getItem(CONFIG.storage.who);
    if (stored) return stored;
    const id = `d-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(CONFIG.storage.who, id);
    return id;
  } catch {
    return "d-anon";
  }
}

/* --- the shared half ------------------------------------------------------ */

/**
 * One pool, as its row is read back. A row from before `objective` was a
 * column carries it inside the board's rules, so it is read from there.
 */
function rowToPool(row) {
  const entry = row.entry ?? { picks: {}, swaps: {} };
  return {
    code: row.code,
    name: row.name,
    kind: kindId(row.sport, row.objective ?? entry.rules?.objective),
    entry,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/**
 * The rules a pool is running, for the home page's one-line summary: what is
 * stored, over what its kind starts a pool with, through the same clamps the
 * board applies (see core/rules.js). The objective is the kind's, whatever the
 * stored rules say: it was fixed when the league was made.
 */
function poolRules(pool) {
  const kind = POOL_KINDS[pool.kind];
  return { ...mergeRules(kind.rules, pool.entry?.rules), objective: kind.objective };
}

function membersOf(pool) {
  return Array.isArray(pool?.entry?.members) ? pool.entry.members : [];
}

/**
 * Rows into leagues: every row with one code is one league, its pools in the
 * registry's order. A row whose season the repo no longer carries is left out,
 * since there is nothing to draw its board from.
 *
 * @returns {Array<{code:string, name:string, kinds:string[],
 *   pools:Object<string,object>}>}
 */
function groupPools(rows) {
  const leagues = new Map();
  for (const row of rows ?? []) {
    if (!(row?.sport in SPORTS)) continue;
    const pool = rowToPool(row);
    // The whole row was read; the board it holds is kept for the store to open
    // on (store/rows.js), rather than being read again a moment later.
    rememberRow(pool.code, pool.kind, { entry: pool.entry, version: pool.updatedAt });
    const league = leagues.get(pool.code) ?? { code: pool.code, name: pool.name, pools: {} };
    league.pools[pool.kind] = pool;
    leagues.set(pool.code, league);
  }
  return [...leagues.values()].map((league) => ({
    ...league,
    kinds: normaliseKinds(Object.keys(league.pools)),
  }));
}

/** A league as the rest of the app holds it: no boards, the rules by kind. */
function summary(league) {
  return {
    code: league.code,
    name: league.name,
    kinds: league.kinds,
    rules: Object.fromEntries(league.kinds.map((kind) => [kind, poolRules(league.pools[kind])])),
  };
}

/** How many people a league has. Its members are kept on every one of its pools. */
function memberCount(league) {
  return Math.max(1, ...league.kinds.map((kind) => membersOf(league.pools[kind]).length));
}

/** Narrow a query to one pool's row. */
function onPool(query, code, kind) {
  const { sport, objective } = POOL_KINDS[kind];
  return query.eq("code", code).eq("sport", sport).eq("objective", objective);
}

/** How many times a patch re-reads the row and tries again. */
const PATCH_ATTEMPTS = 3;

/**
 * Change one pool's entry without overwriting anything else in it.
 *
 * A pool's whole shared state is one JSON document, so writing the members
 * means writing the picks and the rules back too - and a copy of them fetched
 * a moment ago is a copy that can already be wrong. Somebody joining a league
 * while somebody else locks their week 1 pick from the board should not undo
 * that lock, and with an unconditional write of the whole document that is
 * exactly what happened.
 *
 * So the write carries the version it read as a filter and the database decides
 * whether it still applies. Nothing matched means the row moved: it is read
 * again and the change re-applied to what is actually there. Bounded, and
 * false rather than a throw when it runs out - every caller here is best
 * effort, because being in the members list is not what lets anyone open a
 * board.
 *
 * @param {object} client
 * @param {string} code
 * @param {string} kind
 * @param {(entry:object) => object|null} change The entry as the row holds it
 *   in, what it should hold out - or null for "nothing to do".
 * @param {{entry:object, version:string|null}|null} [known] The row as the
 *   caller already read it, to save the first query.
 * @returns {Promise<boolean>} Whether the change is in the row.
 */
async function patchPoolEntry(client, code, kind, change, known = null) {
  const table = CONFIG.supabase.table;
  let current = known;

  for (let attempt = 1; attempt <= PATCH_ATTEMPTS; attempt += 1) {
    if (!current) {
      const { data, error } = await onPool(
        client.from(table).select(COLUMNS),
        code,
        kind,
      ).maybeSingle();
      if (error || !data) return false;
      current = { entry: data.entry ?? { picks: {}, swaps: {} }, version: data.updated_at ?? null };
    }

    const next = change(current.entry);
    if (!next) return true;

    let write = onPool(
      client.from(table).update({ entry: next, updated_at: new Date().toISOString() }),
      code,
      kind,
    );
    // A row with no version to compare against - which the schema does not
    // produce, but a table from before it did could - is written as it always
    // was rather than never being written at all.
    if (current.version) write = write.eq("updated_at", current.version);
    const { data, error } = await write.select("updated_at");
    if (error) return false;
    if (data?.length) return true;

    // Somebody got there first. Read what they left and re-apply.
    current = null;
  }
  return false;
}

/**
 * A database error, in words the person at the form can act on.
 *
 * The API refusing a column it does not know - "could not find the 'objective'
 * column in the schema cache", or Postgres's own "does not exist" - means
 * supabase/schema.sql has not been run against this project since the app
 * started asking for it. That is a thing the league's owner can fix, and the
 * raw message does not say so.
 */
function explain(error) {
  const message = error?.message ?? String(error);
  if (/schema cache|does not exist/i.test(message)) {
    return "the database is behind this version of the app. Run supabase/schema.sql in the Supabase SQL editor, then try again.";
  }
  return message;
}

/** Every pool under a code, as one league, or null when the code names none. */
async function fetchLeague(client, code) {
  const { data, error } = await client.from(CONFIG.supabase.table).select(COLUMNS).eq("code", code);
  if (error) throw new Error(`Could not look up that code: ${explain(error)}`);
  return groupPools(data)[0] ?? null;
}

/**
 * Create a league and join it.
 *
 * One row per kind of pool chosen, all under one code, so the one link brings
 * the people it is sent to into every board the league has. Whether each
 * pool's picks win or lose is decided here and nowhere else. The code is
 * generated here rather than by the database, so the link can be shown the
 * instant the sheet is submitted and a device with no backend gets the same
 * shape of league as one with it.
 *
 * @param {{name:string, kinds:string[], rules?:Object<string,object>}} args
 *   `rules` may carry overrides by kind; each pool's are laid over its own
 *   defaults, all but the objective, which is the kind's.
 * @returns {Promise<{code:string, name:string, kinds:string[],
 *   rules:Object<string,object>, shared:boolean}>}
 * @throws When no usable kind was chosen, or the rows could not be written.
 */
export async function createLeague({ name, kinds, rules = null }) {
  const chosen = normaliseKinds(kinds);
  if (chosen.length === 0) throw new Error("Tick at least one pool for the league to run.");
  const label = (name ?? "").trim().slice(0, 60) || `${kindsLabel(chosen)} pool`;
  const code = newCode();
  const me = { id: myId(), name: myName(), joinedAt: new Date().toISOString() };
  // Clamped before it is stored, not just before it is read: a rule set that
  // reaches the row is one every member will run on (see core/rules.js).
  const rows = chosen.map((id) => {
    const kind = POOL_KINDS[id];
    return {
      code,
      name: label,
      sport: kind.sport,
      objective: kind.objective,
      entry: {
        picks: {},
        swaps: {},
        rules: { ...mergeRules(kind.rules, rules?.[id]), objective: kind.objective },
        members: [me],
      },
    };
  });

  const client = await supabase();
  if (client) {
    const { error } = await client.from(CONFIG.supabase.table).insert(rows);
    if (error) throw new Error(`Could not create the league: ${explain(error)}`);
  }

  const league = summary(groupPools(rows)[0]);
  remember(league);
  return { ...league, shared: Boolean(client) };
}

/**
 * Join a league by its code, and put this person in its members.
 *
 * @param {string} typed Anything a person or a link might carry.
 * @returns {Promise<{code:string, name:string, kinds:string[]}>}
 * @throws When the code is not a code, or names no league this build can see.
 */
export async function joinLeague(typed) {
  const code = normaliseCode(typed);
  if (!isCode(code)) throw new Error("That is not a league code.");

  const client = await supabase();
  if (!client) {
    // No backend to look it up in. A league made on this device is already in
    // the list, so the only codes that land here are other people's.
    const known = myLeagues().find((league) => league.code === code);
    if (known) return known;
    throw new Error("Sharing is off in this build, so there is no league to join.");
  }

  const league = await fetchLeague(client, code);
  if (!league) throw new Error("No league has that code.");

  await addMember(client, league);
  const known = summary(league);
  remember(known);
  return known;
}

/**
 * Put this device in a league's members, on every one of its pools, if it is
 * not already.
 *
 * Best effort: the members list is who is here, not who may write, so failing
 * to add yourself must never stop you opening the board. Each write is applied
 * to that row's own entry, over the version it was read at, so joining cannot
 * roll back a pick someone made a moment ago (see patchPoolEntry).
 */
async function addMember(client, league) {
  const id = myId();
  const name = myName();
  await Promise.all(
    league.kinds.map(async (kind) => {
      const pool = league.pools[kind];
      try {
        await patchPoolEntry(
          client,
          pool.code,
          kind,
          (entry) => {
            const members = Array.isArray(entry.members) ? entry.members : [];
            const mine = members.find((member) => member.id === id);
            if (mine && mine.name === name) return null;
            return {
              ...entry,
              members: mine
                ? members.map((member) => (member.id === id ? { ...member, name } : member))
                : [...members, { id, name, joinedAt: new Date().toISOString() }],
            };
          },
          { entry: pool.entry, version: pool.updatedAt },
        );
      } catch {
        /* the board opens either way */
      }
    }),
  );
}

/**
 * The leagues on this device, with their shared name, pools and rules
 * refreshed.
 *
 * The cached copy is what the home page draws first, so this is an update
 * rather than a load: a code that no longer names a league is marked `missing`
 * instead of vanishing, because a league that failed to load and a league that
 * was deleted look the same from here and only one of them is worth removing
 * someone's list over.
 *
 * @returns {Promise<Array<{code:string, name:string, kinds:string[],
 *   rules:Object<string,object>, members:number, missing:boolean}>>}
 */
export async function refreshMyLeagues() {
  const mine = myLeagues();
  if (mine.length === 0) return [];

  const offline = () => mine.map((league) => ({ ...league, members: 1, missing: false }));
  const client = await supabase();
  if (!client) return offline();

  const { data, error } = await client
    .from(CONFIG.supabase.table)
    .select(COLUMNS)
    .in(
      "code",
      mine.map((league) => league.code),
    );
  if (error) return offline();

  const found = new Map(groupPools(data).map((league) => [league.code, league]));
  return mine.map((league) => {
    const fresh = found.get(league.code);
    if (!fresh) return { ...league, members: 1, missing: true };
    return { ...remember(summary(fresh)), members: memberCount(fresh), missing: false };
  });
}

/**
 * One league by code, from the shared rows where there are any and the
 * device's cached list otherwise. What app.js opens a board from.
 *
 * @returns {Promise<{code:string, name:string, kinds:string[]}|null>}
 */
export async function leagueByCode(code) {
  const clean = normaliseCode(code);
  const client = await supabase();

  if (client) {
    try {
      const league = await fetchLeague(client, clean);
      if (league) {
        const known = summary(league);
        remember(known);
        return known;
      }
    } catch {
      /* the cached copy is the next best answer */
    }
  }

  return myLeagues().find((league) => league.code === clean) ?? null;
}

/**
 * Rename a league, for everyone in it. The name sits on every one of the
 * league's rows, and the update by code reaches them all.
 *
 * @returns {Promise<string>} The name that was actually stored.
 */
export async function renameLeague(code, name) {
  const clean = normaliseCode(code);
  const label = (name ?? "").trim().slice(0, 60);
  if (!label) throw new Error("A league needs a name.");

  const client = await supabase();
  if (client) {
    const { error } = await client
      .from(CONFIG.supabase.table)
      .update({ name: label, updated_at: new Date().toISOString() })
      .eq("code", clean);
    if (error) throw new Error(`Could not rename the league: ${explain(error)}`);
  }

  remember({ code: clean, name: label });
  return label;
}

/**
 * Leave a league: off this device's list, and out of the members on every one
 * of its pools.
 *
 * The league itself is left alone. With one shared board per pool, deleting
 * one would take everyone's season with it, and that is not a thing one member
 * should be able to do from a phone.
 */
export async function leaveLeague(code) {
  const clean = normaliseCode(code);
  const client = await supabase();

  if (client) {
    try {
      const league = await fetchLeague(client, clean);
      const me = myId();
      for (const kind of league?.kinds ?? []) {
        const pool = league.pools[kind];
        // Over the version the row was read at, so leaving cannot take
        // somebody else's lock out with it (see patchPoolEntry).
        await patchPoolEntry(
          client,
          clean,
          kind,
          (entry) => {
            const members = Array.isArray(entry.members) ? entry.members : [];
            if (!members.some((member) => member.id === me)) return null;
            return { ...entry, members: members.filter((member) => member.id !== me) };
          },
          { entry: pool.entry, version: pool.updatedAt },
        );
      }
    } catch {
      /* leaving this device's list is the part that matters */
    }
  }

  forget(clean);
  forgetBoards(clean, KIND_IDS, { everything: true });
}

/**
 * Delete a league, for everyone in it: every pool's row, and this device's
 * copies. The settings sheet asks twice before it gets here. Anyone holding
 * the code can do this, which is the same trust the code already carries - see
 * supabase/schema.sql.
 */
export async function deleteLeague(code) {
  const clean = normaliseCode(code);
  const client = await supabase();
  if (client) {
    const { error } = await client.from(CONFIG.supabase.table).delete().eq("code", clean);
    if (error) throw new Error(`Could not delete the league: ${explain(error)}`);
  }
  forget(clean);
  forgetBoards(clean, KIND_IDS, { everything: true });
}

/**
 * Take one pool out of a league, for everyone in it: its row, its picks, and
 * this device's copy of its board. Never the last one - a league with no pool
 * is nothing to open, and taking a league down is deleteLeague's job.
 */
export async function removePool(code, kind) {
  const clean = normaliseCode(code);
  if (!(kind in POOL_KINDS)) throw new Error("That is not one of the league's pools.");

  const client = await supabase();
  const cached = myLeagues().find((league) => league.code === clean);
  const kinds = client ? ((await fetchLeague(client, clean))?.kinds ?? []) : (cached?.kinds ?? []);
  if (!kinds.includes(kind)) throw new Error("That pool is not in this league.");
  if (kinds.length <= 1)
    throw new Error("A league keeps its last pool. Delete the league instead.");

  if (client) {
    const { error } = await onPool(client.from(CONFIG.supabase.table).delete(), clean, kind);
    if (error) throw new Error(`Could not remove the pool: ${explain(error)}`);
  }

  if (cached) {
    const rules = { ...cached.rules };
    delete rules[kind];
    writeMyLeagues(
      myLeagues().map((league) =>
        league.code === clean
          ? { ...league, kinds: league.kinds.filter((id) => id !== kind), rules }
          : league,
      ),
    );
  }
  forgetBoards(clean, [kind]);
}

/**
 * This device's offline copies of a league's boards, gone: the given kinds,
 * and - when the whole league is going - the one key a league kept before it
 * could hold more than one pool.
 */
function forgetBoards(code, kinds, { everything = false } = {}) {
  forgetRows(code, everything ? null : kinds);
  const keys = kinds.map((kind) => scopeFor(code, kind).storageKey);
  if (everything) keys.push(scopeFor(code, KIND_IDS[0]).legacyStorageKey);
  for (const key of keys) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* nothing to clean up */
    }
  }
}
