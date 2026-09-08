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

export { sharingAvailable } from "./client.js";

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
function rulesOf(pool) {
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
    rules: Object.fromEntries(league.kinds.map((kind) => [kind, rulesOf(league.pools[kind])])),
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

/** Every pool under a code, as one league, or null when the code names none. */
async function fetchLeague(client, code) {
  const { data, error } = await client.from(CONFIG.supabase.table).select(COLUMNS).eq("code", code);
  if (error) throw new Error(`Could not look up that code: ${error.message}`);
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
    if (error) throw new Error(`Could not create the league: ${error.message}`);
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
 * to add yourself must never stop you opening the board. Each write is a merge
 * of that row's own entry rather than of a local copy, so joining cannot roll
 * back a pick someone made a moment ago.
 */
async function addMember(client, league) {
  const id = myId();
  const name = myName();
  await Promise.all(
    league.kinds.map(async (kind) => {
      const pool = league.pools[kind];
      const members = membersOf(pool);
      const mine = members.find((member) => member.id === id);
      if (mine && mine.name === name) return;

      const next = mine
        ? members.map((member) => (member.id === id ? { ...member, name } : member))
        : [...members, { id, name, joinedAt: new Date().toISOString() }];

      try {
        await onPool(
          client.from(CONFIG.supabase.table).update({
            entry: { ...pool.entry, members: next },
            updated_at: new Date().toISOString(),
          }),
          pool.code,
          kind,
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
    if (error) throw new Error(`Could not rename the league: ${error.message}`);
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
      for (const kind of league?.kinds ?? []) {
        const pool = league.pools[kind];
        const members = membersOf(pool).filter((member) => member.id !== myId());
        await onPool(
          client
            .from(CONFIG.supabase.table)
            .update({ entry: { ...pool.entry, members }, updated_at: new Date().toISOString() }),
          clean,
          kind,
        );
      }
    } catch {
      /* leaving this device's list is the part that matters */
    }
  }

  forget(clean);
  // This device's offline copies of the league's boards: one per kind of pool
  // it could have run, and the one a league kept before it could hold more
  // than one.
  const keys = KIND_IDS.map((kind) => scopeFor(clean, kind).storageKey);
  keys.push(scopeFor(clean, KIND_IDS[0]).legacyStorageKey);
  for (const key of keys) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* nothing to clean up */
    }
  }
}
