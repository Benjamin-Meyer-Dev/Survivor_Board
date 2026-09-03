#!/usr/bin/env node
/**
 * Bundle the site into one self-contained HTML file for publishing as a
 * Claude Artifact.
 *
 * Why this exists: an artifact is a single document on a sandboxed origin. It
 * cannot fetch sibling files, so the CSS, the JS modules and every league's
 * JSON have to be inlined. Building it from the same source as the Pages site
 * is what stops the two copies drifting apart.
 *
 * The Artifact tool wraps the output in its own doctype/head/body, so this
 * emits a fragment: title, font link, style, markup, script.
 *
 *   npm run build:artifact   ->  dist/artifact.html
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFile(join(ROOT, ...parts), "utf8");

/** Concatenation order matters: a module must follow everything it imports. */
const CSS = [
  "tokens.css",
  "base.css",
  "layout.css",
  "components.css",
  "field.css",
  // After field.css: the league palettes override both files' tokens.
  "leagues.css",
  "motion.css",
];
const JS = [
  "config.js",
  "leagues.js",
  "core/probability.js",
  "core/format.js",
  "core/survival.js",
  "core/recommend.js",
  "core/refresh.js",
  "core/plan.js",
  "store/artifact.js",
  "store/supabase.js",
  "store/local.js",
  "store/index.js",
  "ui/league-switch.js",
  "ui/tabs.js",
  "ui/strip.js",
  "ui/week-panel.js",
  "ui/ladder.js",
  "ui/burn-board.js",
  "ui/notices.js",
  "ui/gate.js",
  "app.js",
];
const DATA = ["plan.json", "teams.json", "odds.json", "schedule.json", "ratings.json"];

/** Every league gets its own inlined block, keyed the way app.js looks it up. */
const LEAGUE_IDS = ["cfb", "nfl"];

/**
 * Flatten an ES module into the shared scope: drop its import statements and
 * strip the `export` keyword. Safe here because every module uses named
 * declaration exports with no name collisions - `npm run build:artifact`
 * fails loudly below if that stops being true.
 */
function flatten(source) {
  return source
    .replace(/^\s*import\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/^\s*export\s+(?=(async\s+)?function|const|let|class)/gm, "")
    .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, "")
    .trim();
}

/**
 * Fail if a module exists in src/js but is missing from JS above. Without this
 * a new module silently vanishes from the bundle and the artifact breaks at
 * runtime while the Pages build stays fine - the two are hard to tell apart.
 */
async function assertNoMissingModules() {
  const dir = join(ROOT, "src", "js");
  const found = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) =>
      relative(dir, join(entry.parentPath ?? entry.path, entry.name))
        .split("\\")
        .join("/"),
    );

  const missing = found.filter((file) => !JS.includes(file));
  if (missing.length) {
    throw new Error(
      `Module(s) not listed in build-artifact.mjs: ${missing.join(", ")}. ` +
        `Add them to JS in dependency order.`,
    );
  }
}

/** Guard against two modules declaring the same top-level name. */
function assertNoCollisions(modules) {
  const seen = new Map();
  const declaration = /^(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

  for (const [name, source] of modules) {
    for (const match of source.matchAll(declaration)) {
      const symbol = match[1];
      if (seen.has(symbol)) {
        throw new Error(
          `Bundle collision: "${symbol}" is declared in both ${seen.get(symbol)} and ${name}. ` +
            `Rename one, or teach build-artifact.mjs to scope them.`,
        );
      }
      seen.set(symbol, name);
    }
  }
}

await assertNoMissingModules();

const html = await read("index.html");

const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1];
if (!body) throw new Error("Could not find <body> in index.html");

const fontLink = html.match(/<link[^>]+fonts\.googleapis\.com[^>]*>/i)?.[0] ?? "";
const markup = body.replace(/<script[\s\S]*?<\/script>/gi, "").trim();

const css = (await Promise.all(CSS.map((file) => read("src", "css", file)))).join("\n");

const modules = await Promise.all(
  JS.map(async (file) => [file, flatten(await read("src", "js", file))]),
);
assertNoCollisions(modules);

const data = Object.fromEntries(
  await Promise.all(
    LEAGUE_IDS.map(async (league) => [
      league,
      Object.fromEntries(
        await Promise.all(
          DATA.map(async (file) => [file, JSON.parse(await read("data", league, file))]),
        ),
      ),
    ]),
  ),
);

const script = [
  `globalThis.SURVIVOR_DATA = ${JSON.stringify(data)};`,
  ...modules.map(([file, source]) => `/* ---- ${file} ---- */\n${source}`),
].join("\n\n");

const out = `<title>Survivor Board</title>
${fontLink}
<style>
${css}
</style>

${markup}

<script type="module">
${script}
</script>
`;

await mkdir(join(ROOT, "dist"), { recursive: true });
await writeFile(join(ROOT, "dist", "artifact.html"), out, "utf8");

console.log(
  `dist/artifact.html  ${(out.length / 1024).toFixed(1)} KB  ` +
    `(${CSS.length} css, ${JS.length} js, ${LEAGUE_IDS.length} leagues x ${DATA.length} data)`,
);
