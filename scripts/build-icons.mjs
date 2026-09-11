#!/usr/bin/env node
/**
 * Draws the home-screen icons: the board's football, on the board's field.
 *
 * The scene is the app's own, "the field in hand" (src/css/tokens.css): turf
 * under a floodlight, mown in stripes, a chalk yard line per column with the
 * hash marks dashed across, and the painted end zones at either edge - the
 * field ui/pitch.js draws sideways across the top of the board. On it sits the
 * ball that stands on the week on the clock, in penalty-flag yellow with its
 * seam, laces and stripes in the flag's ink. Three layouts cover what
 * launchers ask for:
 *
 *   any       rounded tile, transparent corners       icon-192.png, icon-512.png, icon.svg
 *   maskable  full bleed, ball inside the 80% circle  icon-maskable-512.png
 *   apple     full bleed, iOS rounds it itself        apple-touch-icon.png
 *
 * The repo has no image library, so the PNGs come out of Chrome: each layout
 * is written as an SVG and screenshotted headlessly at its exact size. Run
 * `npm run icons` after changing the scene or a colour and commit the output;
 * CI does not run this.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ICONS_DIR = fileURLToPath(new URL("../icons/", import.meta.url));

/**
 * The ball as ui/pitch.js draws it: a 34 by 21 box, the ellipse filling it,
 * one seam most of the way along and five short laces across it. The stripes
 * are the icon's own - at this size they help the silhouette read as a ball.
 */
const BALL = {
  width: 34,
  height: 21,
  ellipse: { cx: 17, cy: 10.5, rx: 15.6, ry: 9.2 },
  seam: "M9.5 10.5h15",
  laces: "M12 8.6v3.8M14.5 8.6v3.8M17 8.6v3.8M19.5 8.6v3.8M22 8.6v3.8",
  stripes: "M7 5.1v10.8M27 5.1v10.8",
};

/* Palette, all from tokens.css. */
const TURF = "#0f4d2c"; // --turf; theme_color and background_color in manifest.webmanifest
const TURF_DARK = "#0d4527"; // --turf-2, the mown stripe
const PAINT = "#0a3a20"; // --paint, the end zones
const CHALK = "#f3f7f1"; // --chalk
const FLAG = "#ffe066"; // --flag
const FLAG_2 = "#fff0a8"; // --flag-2
const FLAG_SHADE = "#e3c24c"; // the flag, turned from the light
const INK = "#0a3a20"; // --on-flag

/**
 * Every layout is drawn in this square and scaled to its output size, so the
 * scene is composed once. Six yard columns between two end zones, the ball
 * just below centre so its shadow has turf to fall on.
 */
const VIEW = 512;
const ZONE = 64;
const COLUMNS = 6;
const BALL_AT = { x: 256, y: 262, tilt: -18 };

/** The rounded "any" layout, shared by the two PNG sizes and the SVG. */
const ANY = { ball: 0.66, corner: 0.22 };

/** Every PNG, with the ball's length and the corner radius as fractions of the tile. */
const OUTPUTS = [
  { file: "icon-192.png", size: 192, ...ANY },
  { file: "icon-512.png", size: 512, ...ANY },
  // Launchers may crop this to a circle 80% of the width, so the ball stays
  // well inside that.
  { file: "icon-maskable-512.png", size: 512, ball: 0.56, corner: 0 },
  { file: "apple-touch-icon.png", size: 180, ball: 0.66, corner: 0 },
];

const n = (v) => String(Math.round(v * 1000) / 1000);

/**
 * The field: the mow, the yard lines, the hash marks, the end zones. Drawn
 * flat and face-on, the way the board holds it, so the icon is the board.
 */
function field() {
  const inner = VIEW - 2 * ZONE;
  const column = inner / COLUMNS;
  const parts = [];

  // Mown stripes: every other column a shade darker.
  for (let i = 0; i < COLUMNS; i += 2) {
    parts.push(
      `<rect x="${n(ZONE + i * column)}" y="0" width="${n(column)}" height="${VIEW}" fill="${TURF_DARK}"/>`,
    );
  }

  // The end zones, painted, with the chalk hazard stripes over the paint.
  for (const x of [0, VIEW - ZONE]) {
    parts.push(`<rect x="${x}" y="0" width="${ZONE}" height="${VIEW}" fill="${PAINT}"/>`);
    parts.push(`<rect x="${x}" y="0" width="${ZONE}" height="${VIEW}" fill="url(#hazard)"/>`);
  }

  // Yard lines, the goal lines heavier.
  for (let i = 0; i <= COLUMNS; i++) {
    const x = ZONE + i * column;
    const goal = i === 0 || i === COLUMNS;
    parts.push(
      `<rect x="${n(x - (goal ? 2 : 1.5))}" y="0" width="${goal ? 4 : 3}" height="${VIEW}" fill="${CHALK}" opacity="${goal ? 0.7 : 0.4}"/>`,
    );
  }

  // Hash marks: the two dashed lines across the field.
  for (const y of [VIEW / 3, (VIEW * 2) / 3]) {
    parts.push(
      `<path d="M${ZONE} ${n(y)}H${VIEW - ZONE}" stroke="${CHALK}" stroke-width="3" stroke-dasharray="11 9" opacity="0.3"/>`,
    );
  }
  return parts.join("\n    ");
}

function svg({ size, ball, corner }) {
  const rx = VIEW * corner;
  const scale = (VIEW * ball) / BALL.width;
  const { cx, cy, rx: brx, ry: bry } = BALL.ellipse;
  const place = `translate(${BALL_AT.x} ${BALL_AT.y}) rotate(${BALL_AT.tilt}) scale(${n(scale)}) translate(${-cx} ${-cy})`;
  // A faint bevel on the rounded tile only: a full-bleed icon is cropped by the
  // launcher and the edge would land wherever its mask does.
  const bevel =
    corner > 0
      ? `<rect x="1.5" y="1.5" width="${VIEW - 3}" height="${VIEW - 3}" rx="${n(rx - 1.5)}" fill="none" stroke="#fff" stroke-width="3" opacity="0.08"/>`
      : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${VIEW} ${VIEW}">
  <defs>
    <clipPath id="tile"><rect width="${VIEW}" height="${VIEW}" rx="${n(rx)}"/></clipPath>
    <pattern id="hazard" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
      <rect width="5" height="12" fill="${CHALK}" opacity="0.1"/>
    </pattern>
    <radialGradient id="floodlight" gradientUnits="userSpaceOnUse" cx="256" cy="-30" r="400">
      <stop offset="0" stop-color="#fff" stop-opacity="0.2"/>
      <stop offset="0.55" stop-color="#fff" stop-opacity="0.05"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vignette" gradientUnits="userSpaceOnUse" cx="256" cy="256" r="330">
      <stop offset="0.6" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.34"/>
    </radialGradient>
    <linearGradient id="leather" x1="0.2" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="${FLAG_2}"/>
      <stop offset="0.45" stop-color="${FLAG}"/>
      <stop offset="1" stop-color="${FLAG_SHADE}"/>
    </linearGradient>
    <radialGradient id="sheen" cx="0.36" cy="0.28" r="0.5">
      <stop offset="0" stop-color="#fff" stop-opacity="0.38"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <filter id="shadow" x="-20%" y="-100%" width="140%" height="300%">
      <feGaussianBlur stdDeviation="10"/>
    </filter>
  </defs>
  <rect width="${VIEW}" height="${VIEW}" rx="${n(rx)}" fill="${TURF}"/>
  <g clip-path="url(#tile)">
    ${field()}
    <rect width="${VIEW}" height="${VIEW}" fill="url(#floodlight)"/>
    <rect width="${VIEW}" height="${VIEW}" fill="url(#vignette)"/>
    <ellipse cx="${BALL_AT.x + 6}" cy="${n(BALL_AT.y + scale * bry * 0.62)}" rx="${n(scale * brx * 0.92)}" ry="${n(scale * 2.2)}" fill="#000" opacity="0.5" filter="url(#shadow)"/>
    <g transform="${place}" stroke-linecap="round">
      <ellipse cx="${cx}" cy="${cy}" rx="${brx}" ry="${bry}" fill="url(#leather)" stroke="${INK}" stroke-width="0.9"/>
      <ellipse cx="${cx}" cy="${cy}" rx="${brx}" ry="${bry}" fill="url(#sheen)"/>
      <path d="${BALL.stripes}" fill="none" stroke="${INK}" stroke-width="1.4" opacity="0.9"/>
      <path d="${BALL.seam}" fill="none" stroke="${INK}" stroke-width="1.6"/>
      <path d="${BALL.laces}" fill="none" stroke="${INK}" stroke-width="1.6"/>
    </g>
  </g>
  ${bevel}
</svg>
`;
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
const workDir = mkdtempSync(join(tmpdir(), "sudden-death-icons-"));
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
