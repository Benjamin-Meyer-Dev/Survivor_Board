#!/usr/bin/env node
/**
 * The app's access code: how it is read, how it is checked, and what config.js
 * is allowed to carry of it.
 *
 * The code itself must never be in the repo - only a salted digest - and the
 * digest the browser derives must be the one `npm run passcode` wrote, or the
 * door would open for nobody. So the derivation is pinned to a known answer
 * here, and config.js is checked for the shape the app reads.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { CONFIG } from "../src/js/config.js";
import {
  derivePasscodeDigest,
  isDigest,
  newSalt,
  normalisePasscode,
  PASSCODE_ITERATIONS,
} from "../src/js/core/passcode.js";

/* --- reading a code ------------------------------------------------------- */

assert.equal(normalisePasscode(" turf 42 "), "TURF42", "spaces go and case folds");
assert.equal(normalisePasscode("Turf 42"), "TURF42", "a hard space goes too");
assert.equal(
  normalisePasscode("ｔｕｒｆ４２"),
  "TURF42",
  "full-width characters read as themselves",
);
assert.equal(normalisePasscode(null), "", "nothing typed is nothing");

/* --- the derivation ------------------------------------------------------- */

const salt = "00112233445566778899aabbccddeeff";
const pinned = await derivePasscodeDigest("Turf 42", salt, 1000);
assert.ok(isDigest(pinned), "a digest is 32 bytes of hex");
assert.equal(
  pinned,
  await derivePasscodeDigest("TURF42", salt, 1000),
  "the same code however it is typed gives the same digest",
);
assert.notEqual(
  pinned,
  await derivePasscodeDigest("Turf 43", salt, 1000),
  "a different code gives a different digest",
);
assert.notEqual(
  pinned,
  await derivePasscodeDigest("Turf 42", "ffeeddccbbaa99887766554433221100", 1000),
  "and so does a different salt",
);
assert.notEqual(
  pinned,
  await derivePasscodeDigest("Turf 42", salt, 1001),
  "and so does a different count",
);
// PBKDF2-HMAC-SHA256("TURF42", salt, 1000, 32 bytes), pinned so that a change
// to the derivation - a different hash, a different encoding of the code -
// shows up here rather than as a door that opens for nobody.
assert.equal(
  pinned,
  "c13280142e26468f79be59db17a57e3e222f08f3e12d6e009ade7eb1dcbbd9c7",
  "the derivation must stay what the digests already written were made with",
);
assert.ok(isDigest(await derivePasscodeDigest("x", newSalt(), 1)), "a fresh salt derives");
assert.ok(/^[0-9a-f]{32}$/.test(newSalt()), "a salt is sixteen bytes of hex");
assert.notEqual(newSalt(), newSalt(), "and random");
await assert.rejects(derivePasscodeDigest("x", "not hex", 1), /not hex/, "a bad salt is refused");
assert.ok(PASSCODE_ITERATIONS >= 100000, "the count is what makes a public digest worth anything");

/* --- what config.js carries ----------------------------------------------- */

const { passcode } = CONFIG;
assert.deepEqual(
  Object.keys(passcode).sort(),
  ["digest", "iterations", "salt"],
  "config.js carries the digest, the salt and the count, and nothing else of the code",
);
assert.ok(
  passcode.digest === "" || isDigest(passcode.digest),
  "the digest is empty (no door) or 32 bytes of hex",
);
assert.ok(
  passcode.salt === "" || /^[0-9a-f]{32}$/.test(passcode.salt),
  "the salt is empty or sixteen bytes of hex",
);
if (passcode.digest) assert.ok(passcode.salt, "a digest needs its salt");
assert.ok(
  Number.isInteger(passcode.iterations) && passcode.iterations >= 100000,
  "the count is at least a hundred thousand",
);
assert.equal(CONFIG.storage.passcode, "sudden-death/passcode", "and the device remembers it here");

// The code itself must never land in the file: the block holds those three
// keys and no other, and nothing in it reads as a code being spelled out.
const source = await readFile(new URL("../src/js/config.js", import.meta.url), "utf8");
const block = source.match(/passcode:\s*Object\.freeze\(\{([\s\S]*?)\}\)/)?.[1] ?? "";
assert.ok(block, "config.js has a passcode block");
assert.ok(
  !/\b(code|plain|password|secret)\s*:/i.test(block),
  "config.js never spells the code out",
);

console.log(
  `passcode ok: read loosely, derived with PBKDF2-SHA256 at ${PASSCODE_ITERATIONS} rounds and ` +
    `pinned, config.js carries ${passcode.digest ? "a digest and its salt" : "no door"} and never the code`,
);
