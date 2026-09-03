#!/usr/bin/env node
/**
 * Draws the home-screen icons from the football in the startup animation, so
 * the tile on a phone is the ball the board opens with.
 *
 * The ball is the startup scene's path from index.html, unchanged. Only its
 * colours differ: in the animation it sits on the pale ground with an accent
 * outline, and on the theme-blue tile that outline would vanish, so here the
 * outline is white and the laces take the tile colour. Three layouts cover
 * what launchers ask for:
 *
 *   any       rounded tile, transparent corners       icon-192.png, icon-512.png, icon.svg
 *   maskable  full bleed, ball inside the 80% circle  icon-maskable-512.png
 *   apple     full bleed, iOS rounds it itself        apple-touch-icon.png
 *
 * The repo has no image library, so the PNGs come out of Chrome: each layout
 * is written as an SVG and screenshotted headlessly at its exact size. Run
 * `npm run icons` after changing the ball or a colour and commit the output;
 * CI does not run this.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ICONS_DIR = fileURLToPath(new URL("../icons/", import.meta.url));

/** index.html, .startup__ball: a 54 by 34 box with the ball centred at (27, 17). */
const BALL = {
  width: 54,
  height: 34,
  outline: "M3 17C9 4 20 1 27 1s18 3 24 16c-6 13-17 16-24 16S9 30 3 17Z",
  laces: "M19 17h16M23 12v10M27 11v12M31 12v10",
};

const TILE = "#2f5d8c"; // theme_color in manifest.webmanifest
const LEATHER = "#e2edf3"; // --accent-soft in tokens.css, the ball's fill in the animation
const OUTLINE = "#ffffff";
const LACES = TILE;

/** The rounded "any" layout, shared by the two PNG sizes and the SVG. */
const ANY = { ball: 0.72, corner: 0.22 };

/** Every PNG, with the ball's width and the corner radius as fractions of the tile. */
const OUTPUTS = [
  { file: "icon-192.png", size: 192, ...ANY },
  { file: "icon-512.png", size: 512, ...ANY },
  // Launchers may crop this to a circle 80% of the width, so the ball stays
  // well inside that.
  { file: "icon-maskable-512.png", size: 512, ball: 0.64, corner: 0 },
  { file: "apple-touch-icon.png", size: 180, ball: 0.72, corner: 0 },
];

function svg({ size, ball, corner }) {
  const scale = (size * ball) / BALL.width;
  const x = (size - BALL.width * scale) / 2;
  const y = (size - BALL.height * scale) / 2;
  const n = (v) => String(Math.round(v * 1000) / 1000);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `  <rect width="${size}" height="${size}" rx="${n(size * corner)}" fill="${TILE}"/>`,
    `  <g transform="translate(${n(x)} ${n(y)}) scale(${n(scale)})" stroke-linecap="round">`,
    `    <path d="${BALL.outline}" fill="${LEATHER}" stroke="${OUTLINE}" stroke-width="2.5"/>`,
    `    <path d="${BALL.laces}" fill="none" stroke="${LACES}" stroke-width="2"/>`,
    `  </g>`,
    `</svg>`,
    ``,
  ].join("\n");
}

function findChrome() {
  const candidates = [
    process.env.CHROME,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) {
    throw new Error("Chrome not found. Set CHROME to the browser binary and run again.");
  }
  return found;
}

/** Screenshot one SVG at exactly `size` square pixels, corners transparent. */
function rasterise(chrome, workDir, svgPath, pngPath, size) {
  const result = spawnSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--default-background-color=00000000",
      `--window-size=${size},${size}`,
      `--user-data-dir=${join(workDir, "profile")}`,
      `--screenshot=${pngPath}`,
      pathToFileURL(svgPath).href,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 || !existsSync(pngPath)) {
    throw new Error(`Chrome did not write ${pngPath}\n${result.stderr}`);
  }

  // IHDR is always the first chunk, so the dimensions sit at bytes 16 and 20.
  const png = readFileSync(pngPath);
  const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  if (width !== size || height !== size) {
    throw new Error(`${pngPath} came out ${width}x${height}, expected ${size}x${size}`);
  }
}

const chrome = findChrome();
const workDir = mkdtempSync(join(tmpdir(), "survivor-icons-"));
try {
  for (const output of OUTPUTS) {
    const svgPath = join(workDir, output.file.replace(/\.png$/, ".svg"));
    writeFileSync(svgPath, svg(output));
    rasterise(chrome, workDir, svgPath, join(ICONS_DIR, output.file), output.size);
    console.log(`wrote icons/${output.file}`);
  }
  writeFileSync(join(ICONS_DIR, "icon.svg"), svg({ size: 512, ...ANY }));
  console.log("wrote icons/icon.svg");
} finally {
  // Chrome's helper processes can hold the profile open for a moment on Windows.
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
