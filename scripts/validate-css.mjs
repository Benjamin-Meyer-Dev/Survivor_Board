#!/usr/bin/env node
/**
 * Every class the stylesheets style is a class something puts on an element.
 *
 * The app has no build step, so nothing prunes CSS and nothing complains about
 * a rule that has stopped applying to anything. A component renamed, a panel
 * taken out, a state that turned out not to be needed - each leaves its rules
 * behind, and they read exactly like rules that matter. Seventy-odd lines of
 * them had built up by the time this was written: a chip for a week on the
 * clock the card says another way now, a caption row for the drawer's panels,
 * a shake for a passcode gate that no longer exists.
 *
 * So: collect the classes the stylesheets name, collect what the markup and the
 * modules actually write, and report the difference. Keyframes too - the same
 * thing happens to them, and one of them is only ever named by the rule that
 * plays it.
 *
 * The interesting part is the classes nothing names in full, because they are
 * built a piece at a time - `chip chip--${tier}`, `pitch__mark--${mark}`,
 * `is-page-entering--${way}`. A check that could not see those would have to be
 * turned off, so it reads the other side of the template instead: any name that
 * runs up to a `${` is a prefix the app composes, and every class starting with
 * one counts as used. That is the allowlist, and it is derived rather than
 * maintained, which is the only kind that stays true.
 *
 * A false positive is not a nuisance to be silenced. It is either dead CSS or a
 * class written in a way nothing can see - a name glued together with `+`, one
 * assembled from a variable - and both are worth knowing about. The first is
 * deleted and the second is written as a template, which is the house style
 * anyway. WRITTEN_ELSEWHERE is for what is left, and wants a reason each.
 */

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Classes and keyframes that are worn, but not in a way reading the source can
 * see. Empty, and worth keeping that way: every name in the app is either
 * written out or composed from a prefix this can find.
 */
const WRITTEN_ELSEWHERE = new Set();

/** Files that write class names: the page, and every module in it. */
async function sourceFiles() {
  const files = [join(ROOT, "index.html")];
  const dir = join(ROOT, "src", "js");
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(join(entry.parentPath ?? entry.path, entry.name));
    }
  }
  return files;
}

async function stylesheets() {
  const dir = join(ROOT, "src", "css");
  const names = (await readdir(dir)).filter((name) => name.endsWith(".css"));
  return Promise.all(names.map(async (name) => [name, await readFile(join(dir, name), "utf8")]));
}

/** A class named in prose is not a class in use. */
function withoutComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Selectors alone.
 *
 * Everything up to each `{` is a selector or an at-rule's prelude; everything
 * between a `{` and its `}` is declarations, and is dropped. Which is what
 * keeps `url("...w3.org...")` from being a class called `w3`, and keeps the
 * selectors inside a media query, where a regex over whole blocks would have
 * had to choose between the two.
 */
function selectorsOnly(css) {
  const parts = [];
  let buffer = "";
  for (const character of withoutComments(css)) {
    if (character === "{") {
      parts.push(buffer);
      buffer = "";
    } else if (character === "}") {
      buffer = "";
    } else {
      buffer += character;
    }
  }
  return parts.join("\n");
}

const CLASS = /\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g;

const css = await stylesheets();
const written = (
  await Promise.all((await sourceFiles()).map((file) => readFile(file, "utf8")))
).join("\n");

/**
 * The prefixes the app builds names out of: whatever runs up to a `${`.
 *
 * `class="chip chip--${tier}"` gives `chip--`, which covers every chip variant
 * the stylesheet defines. Deliberately generous - the alternative is a check
 * nobody trusts.
 */
const composed = [...written.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\$\{/g)].map((match) => match[1]);

/** Every name that appears in an `animation` or `animation-name` anywhere. */
const played = new Set(
  [withoutComments(css.map(([, text]) => text).join("\n")), written]
    .flatMap((text) => [...text.matchAll(/animation(?:-name)?\s*:[^;{}"'`]*/g)])
    .flatMap((match) => match[0].match(/[A-Za-z_][A-Za-z0-9_-]*/g) ?? []),
);

const isWritten = (name) =>
  WRITTEN_ELSEWHERE.has(name) ||
  written.includes(name) ||
  composed.some((prefix) => name.startsWith(prefix) && name !== prefix);

const orphans = [];
for (const [file, text] of css) {
  for (const [, name] of selectorsOnly(text).matchAll(CLASS)) {
    if (!isWritten(name)) orphans.push({ file, kind: "class", name });
  }
  for (const [, name] of withoutComments(text).matchAll(
    /@keyframes\s+([A-Za-z_][A-Za-z0-9_-]*)/g,
  )) {
    if (!played.has(name) && !WRITTEN_ELSEWHERE.has(name)) {
      orphans.push({ file, kind: "keyframes", name });
    }
  }
}

/** One line per orphan: a class is styled by as many rules as it needs. */
const unique = [...new Map(orphans.map((each) => [`${each.kind} ${each.name}`, each])).values()];

if (unique.length) {
  console.error("CSS that styles nothing:\n");
  for (const { file, kind, name } of unique) {
    console.error(`  ${file}  ${kind === "class" ? "." : "@keyframes "}${name}`);
  }
  console.error(
    "\nEither the markup that wore it has gone - delete the rules - or it is written in a way " +
      "this cannot see, in which case write it as a template so it can be, or add it to " +
      "WRITTEN_ELSEWHERE in scripts/validate-css.mjs with a note saying who writes it.",
  );
  process.exit(1);
}

const classes = new Set(
  css.flatMap(([, text]) => [...selectorsOnly(text).matchAll(CLASS)].map(([, name]) => name)),
);
console.log(
  `CSS OK: ${classes.size} classes and ${played.size ? "every keyframe" : "no keyframes"} across ` +
    `${css.length} stylesheets, each of them reached by something the page or a module writes.`,
);
