#!/usr/bin/env node
/**
 * Set the app's access code.
 *
 *   npm run passcode -- "the code"     set it
 *   npm run passcode -- --random       make one up, print it once, set it
 *   npm run passcode -- --clear        take the door off
 *   PASSCODE="the code" npm run passcode
 *
 * Writes a fresh salt and the code's digest into src/js/config.js and nothing
 * else: the code itself goes nowhere, and this prints it only when it made it
 * up. Commit config.js and deploy; every device is asked for the code again,
 * because what a device remembers is the digest and the digest has changed.
 *
 * The digest is what src/js/core/passcode.js derives, imported here so the
 * check in the browser and the value written here can never disagree.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  derivePasscodeDigest,
  newSalt,
  normalisePasscode,
  PASSCODE_ITERATIONS,
} from "../src/js/core/passcode.js";
import { newCode, formatCode } from "../src/js/core/code.js";

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "js", "config.js");

const args = process.argv.slice(2);
const clear = args.includes("--clear");
const random = args.includes("--random");
let typed = args.find((arg) => !arg.startsWith("--")) ?? process.env.PASSCODE ?? "";

let madeUp = null;
if (random) {
  // Eight characters from the league codes' alphabet - no O/0/1/I/L to misread
  // - grouped in fours, which is what a code read out down a phone line wants.
  madeUp = formatCode(newCode()).slice(0, 9);
  typed = madeUp;
}

if (!clear && normalisePasscode(typed).length < 6) {
  console.error(
    "Give a code of at least six characters (spaces and case do not count), or --random, or --clear.",
  );
  process.exit(1);
}

const source = await readFile(CONFIG_PATH, "utf8");
const block = /passcode:\s*Object\.freeze\(\{[\s\S]*?\}\)/;
if (!block.test(source)) {
  console.error("config.js has no passcode block to write into.");
  process.exit(1);
}

const salt = clear ? "" : newSalt();
const digest = clear ? "" : await derivePasscodeDigest(typed, salt, PASSCODE_ITERATIONS);
const written = source.replace(block, (found) =>
  found
    .replace(/digest:\s*"[^"]*"/, `digest: "${digest}"`)
    .replace(/salt:\s*"[^"]*"/, `salt: "${salt}"`)
    .replace(/iterations:\s*\d+/, `iterations: ${PASSCODE_ITERATIONS}`),
);
await writeFile(CONFIG_PATH, written);

if (clear) {
  console.log("The door is off: src/js/config.js carries no digest. Commit it to deploy that.");
} else {
  console.log(
    `Access code set in src/js/config.js (${PASSCODE_ITERATIONS} rounds, salt ${salt.slice(0, 8)}…).`,
  );
  console.log("Commit config.js and deploy. Every device will be asked for the code once.");
  if (madeUp) {
    console.log("");
    console.log(`The code is:  ${madeUp}`);
    console.log("It is not stored anywhere else. Case and spaces do not matter when it is typed.");
  }
}
