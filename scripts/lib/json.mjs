/**
 * Reading and writing the repo's JSON, in one place.
 *
 * Every script here reads data files and most of them write one back, and each
 * had its own two-line version of it: `JSON.parse(await readFile(path,
 * "utf8"))`, and `writeFile(path, JSON.stringify(x, null, 2) + "\n")`. That is
 * fine until the details start to matter, and two of them do.
 *
 * A file's formatting is part of the repo. Data files are committed by a bot
 * and read by people in diffs, so they are written the way Prettier would
 * write them - two spaces, one trailing newline - and any script that forgets
 * the newline puts a whole-file change in the next commit that touches it.
 *
 * And "the file is not there" is not the same as "the file is broken". Several
 * of these files are optional: form.json does not exist until the first refresh
 * with something to fit, and a league whose season has not started has neither
 * it nor stats.json. The old optional read swallowed every error, which meant a
 * half-written or hand-edited file read as a missing one - the job carried on
 * and quietly refitted from nothing. Only a missing file is missing here;
 * anything else is a failure, and says which file and why.
 */

import { readFile, writeFile } from "node:fs/promises";

/**
 * @param {string|URL} path
 * @returns {Promise<any>}
 * @throws When the file is not there, or is not JSON.
 */
export async function readJson(path) {
  const raw = await readFile(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error.message}`);
  }
}

/**
 * A file that is allowed not to exist yet.
 *
 * @param {string|URL} path
 * @returns {Promise<any|null>} Null only when there is no such file.
 * @throws When the file is there and cannot be read or parsed.
 */
export async function readOptionalJson(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Several files at once, in the order they were asked for.
 *
 * @param {Array<string|URL>} paths
 * @returns {Promise<any[]>}
 */
export function readJsons(paths) {
  return Promise.all(paths.map((path) => readJson(path)));
}

/**
 * Write a document as the repo formats JSON: two spaces, trailing newline.
 *
 * @param {string|URL} path
 * @param {any} document
 * @param {{compact?:boolean}} [options] `compact` for the one file that is
 *   written a line at a time rather than to be read (data/<league>/history.json).
 */
export function writeJson(path, document, { compact = false } = {}) {
  const text = compact ? JSON.stringify(document) : JSON.stringify(document, null, 2);
  return writeFile(path, `${text}\n`, "utf8");
}
