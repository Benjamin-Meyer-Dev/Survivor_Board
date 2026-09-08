/**
 * The league directory: which leagues exist, and which of them this device is
 * in.
 *
 * Two halves, deliberately.
 *
 * The **shared** half is one row per league in Supabase, keyed by the league's
 * code, holding its name, its sport and its board. Creating a league inserts a
 * row; joining one reads it by code. There are no accounts, so the code is the
 * credential - see supabase/schema.sql for exactly what that does and does not
 * protect.
 *
 * The **local** half is the list of codes on this phone, with the name and
 * sport cached beside each. It is what the home page draws before the network
 * answers, and it is what "your leagues" means: a league nobody on this device
 * has joined is not lost, it is simply not listed here, and pasting its code
 * back in brings it back. Leaving a league removes it from this list and takes
 * this person out of the members; it never deletes anyone else's league.
 *
 * With no Supabase configured the shared half is absent: leagues still work,
 * but only on the phone that made them, and the home page says so.
 */

import { CONFIG } from "../config.js";
import { newCode, normaliseCode, isCode } from "../core/code.js";
import { resolveSport, SPORTS } from "../sports.js";
import { mergeRules } from "../core/rules.js";
import { supabaseClient } from "./client.js";

export { sharingAvailable } from "./client.js";

/** The one client the app loads, shared with a league's own store. */
const supabase = supabaseClient;

/* --- this device's list --------------------------------------------------- */

/**
 * @returns {Array<{code:string, name:string, sport:string, joinedAt:string}>}
 *   In the order they were added, which is the order the home page shows them.
 */
export function myLeagues() {
  try {
    const raw = localStorage.getItem(CONFIG.storage.leagues);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((league) => isCode(league?.code)) : [];
  } catch {
    return [];
  }
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
  const merged = { ...(list[index] ?? { joinedAt: new Date().toISOString() }), ...league };
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
 * The rules a league is running, for the home page's one-line summary: what is
 * stored, over what its sport starts a league with, through the same clamps
 * the board applies (see core/rules.js).
 */
function rulesFor(league) {
  return mergeRules(SPORTS[league.sport].defaultRules, league.entry?.rules);
}

/** The columns a league row is read back as, whatever else the table holds. */
function rowToLeague(row) {
  return {
    code: row.code,
    name: row.name,
    sport: resolveSport(row.sport),
    entry: row.entry ?? { picks: {}, swaps: {} },
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/**
 * Create a league and join it.
 *
 * The code is generated here rather than by the database, so the link can be
 * shown the instant the sheet is submitted and a device with no backend gets
 * the same shape of league as one with it.
 *
 * @param {{name:string, sport:string, rules?:object}} args
 * @returns {Promise<{code:string, name:string, sport:string, shared:boolean}>}
 */
export async function createLeague({ name, sport, rules = null }) {
  const chosen = resolveSport(sport);
  const label = (name ?? "").trim().slice(0, 60) || `${SPORTS[chosen].label} survivor`;
  const code = newCode();
  // Clamped before it is stored, not just before it is read: a rule set that
  // reaches the row is one every member will run on (see core/rules.js).
  const entry = {
    picks: {},
    swaps: {},
    rules: mergeRules(SPORTS[chosen].defaultRules, rules),
    members: [{ id: myId(), name: myName(), joinedAt: new Date().toISOString() }],
  };

  const client = await supabase();
  if (client) {
    const { error } = await client
      .from(CONFIG.supabase.table)
      .insert({ code, name: label, sport: chosen, entry });
    if (error) throw new Error(`Could not create the league: ${error.message}`);
  }

  remember({ code, name: label, sport: chosen, rules: entry.rules });
  return { code, name: label, sport: chosen, shared: Boolean(client) };
}

/**
 * Join a league by its code, and put this person in its members.
 *
 * @param {string} typed Anything a person or a link might carry.
 * @returns {Promise<{code:string, name:string, sport:string}>}
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

  const { data, error } = await client
    .from(CONFIG.supabase.table)
    .select("code, name, sport, entry, created_at, updated_at")
    .eq("code", code)
    .maybeSingle();

  if (error) throw new Error(`Could not look up that code: ${error.message}`);
  if (!data) throw new Error("No league has that code.");

  const league = rowToLeague(data);
  await addMember(client, league);
  remember({
    code: league.code,
    name: league.name,
    sport: league.sport,
    rules: rulesFor(league),
  });
  return { code: league.code, name: league.name, sport: league.sport };
}

/**
 * Put this device in a league's members, if it is not already.
 *
 * Best effort: the members list is who is here, not who may write, so failing
 * to add yourself must never stop you opening the board. The write is a merge
 * of the row's own entry rather than of a local copy, so joining cannot roll
 * back a pick someone made a moment ago.
 */
async function addMember(client, league) {
  const members = Array.isArray(league.entry.members) ? league.entry.members : [];
  const id = myId();
  const name = myName();
  const mine = members.find((member) => member.id === id);
  if (mine && mine.name === name) return;

  const next = mine
    ? members.map((member) => (member.id === id ? { ...member, name } : member))
    : [...members, { id, name, joinedAt: new Date().toISOString() }];

  try {
    await client
      .from(CONFIG.supabase.table)
      .update({ entry: { ...league.entry, members: next }, updated_at: new Date().toISOString() })
      .eq("code", league.code);
  } catch {
    /* the board opens either way */
  }
}

/**
 * The leagues on this device, with their shared name and sport refreshed.
 *
 * The cached copy is what the home page draws first, so this is an update
 * rather than a load: a code that no longer names a league is marked `missing`
 * instead of vanishing, because a league that failed to load and a league that
 * was deleted look the same from here and only one of them is worth removing
 * someone's list over.
 *
 * @returns {Promise<Array<{code:string, name:string, sport:string,
 *   members:number, missing:boolean}>>}
 */
export async function refreshMyLeagues() {
  const mine = myLeagues();
  if (mine.length === 0) return [];

  const client = await supabase();
  if (!client) return mine.map((league) => ({ ...league, members: 1, missing: false }));

  const { data, error } = await client
    .from(CONFIG.supabase.table)
    .select("code, name, sport, entry, updated_at")
    .in(
      "code",
      mine.map((league) => league.code),
    );

  if (error) return mine.map((league) => ({ ...league, members: 1, missing: false }));

  const rows = new Map((data ?? []).map((row) => [row.code, rowToLeague(row)]));
  return mine.map((league) => {
    const row = rows.get(league.code);
    if (!row) return { ...league, members: 1, missing: true };
    const rules = rulesFor(row);
    remember({ code: row.code, name: row.name, sport: row.sport, rules });
    return {
      ...league,
      name: row.name,
      sport: row.sport,
      rules,
      members: Array.isArray(row.entry.members) ? row.entry.members.length : 1,
      missing: false,
    };
  });
}

/**
 * One league by code, from the shared row where there is one and the device's
 * cached list otherwise. What app.js opens a board from.
 *
 * @returns {Promise<{code:string, name:string, sport:string}|null>}
 */
export async function leagueByCode(code) {
  const clean = normaliseCode(code);
  const client = await supabase();

  if (client) {
    const { data } = await client
      .from(CONFIG.supabase.table)
      .select("code, name, sport, entry, created_at, updated_at")
      .eq("code", clean)
      .maybeSingle();
    if (data) {
      const league = rowToLeague(data);
      remember({
        code: league.code,
        name: league.name,
        sport: league.sport,
        rules: rulesFor(league),
      });
      return { code: league.code, name: league.name, sport: league.sport };
    }
  }

  return myLeagues().find((league) => league.code === clean) ?? null;
}

/**
 * Rename a league, for everyone in it.
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
 * Leave a league: off this device's list, and out of the members.
 *
 * The league itself is left alone. With one shared entry per league, deleting
 * it would take everyone's season with it, and that is not a thing one member
 * should be able to do from a phone.
 */
export async function leaveLeague(code) {
  const clean = normaliseCode(code);
  const client = await supabase();

  if (client) {
    try {
      const { data } = await client
        .from(CONFIG.supabase.table)
        .select("code, name, sport, entry")
        .eq("code", clean)
        .maybeSingle();
      if (data) {
        const league = rowToLeague(data);
        const members = (Array.isArray(league.entry.members) ? league.entry.members : []).filter(
          (member) => member.id !== myId(),
        );
        await client
          .from(CONFIG.supabase.table)
          .update({
            entry: { ...league.entry, members },
            updated_at: new Date().toISOString(),
          })
          .eq("code", clean);
      }
    } catch {
      /* leaving this device's list is the part that matters */
    }
  }

  forget(clean);
  try {
    localStorage.removeItem(`${CONFIG.storage.entryPrefix}/${clean}`);
  } catch {
    /* nothing to clean up */
  }
}
