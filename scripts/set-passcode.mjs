#!/usr/bin/env node
/**
 * Set the pool passcode.
 *
 *   npm run passcode                   prompts for it
 *   npm run passcode -- "the passcode" takes it from the command line
 *
 * The passcode itself never goes into the repo. This derives its digest with a
 * fresh random salt (src/js/core/passcode.js) and writes those two values into
 * src/js/config.js. Commit that and push: Pages redeploys, and every device asks
 * for the new passcode on its next open. An empty answer removes the gate.
 */

import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { argv, stdin, stdout } from "node:process";
import { derivePasscodeDigest } from "../src/js/core/passcode.js";

const CONFIG_PATH = new URL("../src/js/config.js", import.meta.url);

/** Below this the digest is worth guessing at, even with the slow derivation. */
const SHORT = 12;

async function readPasscode() {
  if (argv.length > 2) return argv[2];

  if (!stdin.isTTY) {
    let piped = "";
    for await (const chunk of stdin) piped += chunk;
    return piped.replace(/\r?\n$/, "");
  }

  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return await prompt.question("New passcode (leave empty to remove the gate): ");
  } finally {
    prompt.close();
  }
}

/**
 * Replace the value on one `key: "..."` line of config.js, refusing to guess if
 * there is not exactly one such line. Only hex or empty values are touched, so
 * a line that holds anything else stops the script rather than being rewritten.
 */
function setValue(source, key, value) {
  const pattern = new RegExp(`^([ \\t]*${key}: ")[0-9a-f]*(",[ \\t]*\\r?)$`, "gm");
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one \`${key}: "..."\` line in src/js/config.js, found ${matches.length}. ` +
        `Restore the passcode block from git and run this again.`,
    );
  }
  return source.replace(pattern, (_, open, close) => `${open}${value}${close}`);
}

const passcode = (await readPasscode()).trim();
const salt = passcode ? randomBytes(16).toString("hex") : "";
const digest = passcode ? await derivePasscodeDigest(passcode, salt) : "";

const source = await readFile(CONFIG_PATH, "utf8");
const updated = setValue(setValue(source, "digest", digest), "salt", salt);
await writeFile(CONFIG_PATH, updated, "utf8");

if (!passcode) {
  console.log("Gate removed: src/js/config.js now has an empty passcode digest.");
} else {
  console.log(
    `Passcode set. src/js/config.js holds its digest (${digest.slice(0, 8)}…), not the passcode.`,
  );
  if (passcode.length < SHORT) {
    console.log(
      `Note: ${passcode.length} characters is short. The digest is public, so a short or ` +
        `guessable passcode can be worked out from it. A longer one is safer.`,
    );
  }
}
console.log("Commit and push; every device asks for the passcode again on its next open.");
