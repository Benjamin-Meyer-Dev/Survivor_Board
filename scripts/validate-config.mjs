#!/usr/bin/env node
/**
 * Checks the things config.js and the sport registry promise the rest of the
 * app, and that the two places a season's starting rules are written down
 * still agree.
 *
 * There is no passcode any more - a league's code is the credential, and the
 * codes are generated rather than configured - so what is left to check here
 * is the shape of the configuration itself, the storage keys the app keys
 * every device's state on, and the refresh clock the board counts down to.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { CONFIG, scopeFor } from "../src/js/config.js";
import { SPORTS, SPORT_IDS, resolveSport } from "../src/js/sports.js";
import { nextRefreshAt } from "../src/js/core/refresh.js";
import { mergeRules } from "../src/js/core/rules.js";
import { newCode, normaliseCode, isCode, formatCode, codeFromHash } from "../src/js/core/code.js";

/* --- configuration -------------------------------------------------------- */

assert.equal(typeof CONFIG.dataPath, "string", "dataPath must be a string");
assert.equal(CONFIG.supabase.table, "leagues", "one row per league, in the leagues table");

// Every stored key is namespaced, so nothing this app writes can collide with
// anything else on the origin, and no two leagues can share an entry.
for (const [name, key] of Object.entries(CONFIG.storage)) {
  assert.ok(key.startsWith("survivor-board/"), `storage.${name} must be namespaced`);
}
const first = scopeFor("BXQK7HRTM4WD");
const second = scopeFor("M4WDBXQK7HRT");
assert.notEqual(first.storageKey, second.storageKey, "two leagues must not share a storage key");
assert.notEqual(first.entryId, second.entryId);
assert.ok(first.storageKey.startsWith(CONFIG.storage.entryPrefix));

// The passcode is gone, and nothing should quietly bring it back: a digest in
// config.js would be a second gate nobody maintains.
const source = await readFile(new URL("../src/js/config.js", import.meta.url), "utf8");
assert.ok(!/passcode/i.test(source), "config.js must not carry a passcode any more");

/* --- league codes --------------------------------------------------------- */

const code = newCode();
assert.ok(isCode(code), "a generated code must be a whole code");
assert.equal(normaliseCode(code), code, "and already be in its stored form");
assert.equal(normaliseCode(formatCode(code)), code, "the shown form normalises back");
assert.equal(normaliseCode("bxqk 7hrt-m4wd"), "BXQK7HRTM4WD", "typed loosely, read strictly");
// The five characters that get misread cannot be in a code, so one that
// arrives carrying them was misread somewhere: it comes back short, and short
// is not a code.
assert.equal(isCode("BXQKOHRTM4WD"), false, "a code with an O in it is not one");
assert.equal(isCode("BXQK1HRTM4WD"), false, "nor one with a 1");
assert.equal(normaliseCode("BXQK7HRTM4WDZZZZ").length, 12, "and a long one is cut to length");
assert.equal(isCode("BXQK-7HRT"), false, "a partial code is not a code");
assert.deepEqual(codeFromHash(`#/join/${formatCode(code)}`), { action: "join", code });
assert.deepEqual(codeFromHash(`#/l/${code}`), { action: "open", code });
assert.equal(codeFromHash("#/l/nope"), null, "a hash that names no code opens nothing");
assert.equal(codeFromHash(""), null);

// Two codes in a row must not collide; 59 bits says they never will, but a
// generator wired to a constant would show up here.
const codes = new Set(Array.from({ length: 200 }, () => newCode()));
assert.equal(codes.size, 200, "codes must be random");

/* --- sports --------------------------------------------------------------- */

assert.ok(SPORT_IDS.length > 0, "there must be a sport to play");
assert.equal(resolveSport("nonsense"), SPORT_IDS[0], "an unknown sport falls back to the first");

for (const id of SPORT_IDS) {
  const sport = SPORTS[id];
  assert.equal(sport.id, id, `${id}: the registry key and the id must match`);
  assert.ok(sport.label && sport.short, `${id}: needs a name`);
  assert.ok(Array.isArray(sport.conferences) && sport.conferences.length, `${id}: needs teams`);

  // What a new league on this sport starts with has to be what the season's
  // own plan file says, or a league created from the home page would run
  // different rules from the same season opened any other way.
  const plan = JSON.parse(
    await readFile(new URL(`../data/${id}/plan.json`, import.meta.url), "utf8"),
  );
  const weeks = plan.weeks.map((week) => week.week);
  assert.deepEqual(
    mergeRules(sport.defaultRules, null, weeks),
    mergeRules(plan.rules, null, weeks),
    `${id}: SPORTS.defaultRules and data/${id}/plan.json rules must agree`,
  );
  assert.equal(plan.league, id, `${id}: plan.json must name its own season`);
}

/* --- the refresh clock ---------------------------------------------------- */

assert.equal(
  new Date(nextRefreshAt(Date.parse("2026-09-03T12:00:00Z"), CONFIG.refresh)).toISOString(),
  "2026-09-03T13:00:00.000Z",
  "summer refresh must be 9am Toronto time",
);
assert.equal(
  new Date(nextRefreshAt(Date.parse("2026-01-03T13:00:00Z"), CONFIG.refresh)).toISOString(),
  "2026-01-03T14:00:00.000Z",
  "winter refresh must be 9am Toronto time",
);

console.log(
  `config ok: ${SPORT_IDS.length} seasons, leagues keyed by code, storage namespaced, ` +
    `codes random and read loosely, 9am refresh holds across daylight saving`,
);
