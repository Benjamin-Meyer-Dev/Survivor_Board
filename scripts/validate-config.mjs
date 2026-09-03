#!/usr/bin/env node
/**
 * Checks that config.js holds only what it is allowed to hold about the
 * passcode: a digest and its salt, both set together, and never the passcode
 * itself. Also pins the derivation, so a change to core/passcode.js that would
 * silently invalidate every device's remembered answer fails here first.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CONFIG } from "../src/js/config.js";
import { derivePasscodeDigest, isPasscodeDigest } from "../src/js/core/passcode.js";

const { digest, salt } = CONFIG.passcode;
assert.equal(typeof digest, "string", "passcode.digest must be a string");
assert.equal(typeof salt, "string", "passcode.salt must be a string");

if (digest) {
  assert.ok(isPasscodeDigest(digest), "passcode.digest is not a digest: run `npm run passcode`");
  assert.ok(
    /^[0-9a-f]{32}$/.test(salt),
    "passcode.salt must be set with the digest: run `npm run passcode`",
  );
} else {
  assert.equal(salt, "", "an empty passcode.digest should come with an empty salt");
}

// The shape an earlier version of config.js used for the plain passcode. A hand
// edit that brings it back is the one thing this file exists to catch.
const source = await readFile(new URL("../src/js/config.js", import.meta.url), "utf8");
assert.ok(
  !/^\s*passcode:\s*"/m.test(source),
  "config.js must not contain the passcode itself: run `npm run passcode`",
);

// Known answer for the derivation. If this fails, the iteration count or the
// algorithm changed, and every digest in the wild, including the one in
// config.js, no longer matches what devices will derive.
const known = await derivePasscodeDigest("  known answer  ", "0123456789abcdef");
assert.equal(
  known,
  "47a27e5728d783b045e55de889f8c805ae99be5a3ff652b399ef56effadb13e3",
  "derivePasscodeDigest changed: run `npm run passcode` and update this vector together",
);

console.log(
  digest
    ? "config ok: passcode gate is on, config holds a digest, not the passcode"
    : "config ok: no passcode gate",
);
