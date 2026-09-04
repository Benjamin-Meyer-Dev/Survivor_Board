#!/usr/bin/env node
/**
 * Draws the home-screen icons: the startup animation's football, mid-flight
 * under the lights of a night game.
 *
 * The scene is the app's own. The tile is the ground colour the board sits on
 * (manifest theme_color), lit from above in the accent blue the startup and
 * passcode screens use; below the ball a chalked field recedes to a horizon,
 * marked the way the passcode stadium is; and the dashed route of the startup
 * throw trails in behind the ball from the lower left. The ball is the startup
 * scene's path from index.html, unchanged in shape, drawn here as leather with
 * a sheen, stripes and laces, with the field's blue catching its underside.
 * Three layouts cover what launchers ask for:
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

/** index.html, .startup__ball: a 54 by 34 box with the ball centred at (27, 17). */
const BALL = {
  width: 54,
  height: 34,
  outline: "M3 17C9 4 20 1 27 1s18 3 24 16c-6 13-17 16-24 16S9 30 3 17Z",
  laces: "M19 17h16M23 12v10M27 11v12M31 12v10",
};

/* Palette, all from the app: --ground and --startup-accent in components.css,
   the leather warm against the cool light the way a ball reads on television. */
const GROUND = "#080b12"; // theme_color and background_color in manifest.webmanifest
const ACCENT = "#93b4f0";
const LEATHER = { light: "#c4713d", mid: "#8b4622", dark: "#47200f", edge: "#2a1108" };
const CHALK = "#f4efe4";

/**
 * Every layout is drawn in this square and scaled to its output size, so the
 * scene is composed once. The horizon sits just below centre; the ball hangs
 * above it, tilted nose-up like a pass on its way.
 */
const VIEW = 512;
const HORIZON = 236;
const BALL_AT = { x: 256, y: 214, tilt: -18 };

/** The rounded "any" layout, shared by the two PNG sizes and the SVG. */
const ANY = { ball: 0.64, corner: 0.22 };

/** Every PNG, with the ball's length and the corner radius as fractions of the tile. */
const OUTPUTS = [
  { file: "icon-192.png", size: 192, ...ANY },
  { file: "icon-512.png", size: 512, ...ANY },
  // Launchers may crop this to a circle 80% of the width, so the ball stays
  // well inside that.
  { file: "icon-maskable-512.png", size: 512, ball: 0.56, corner: 0 },
  { file: "apple-touch-icon.png", size: 180, ball: 0.64, corner: 0 },
];

const n = (v) => String(Math.round(v * 1000) / 1000);

/**
 * Yard lines and hash marks receding to the horizon. Spacing, weight and
 * brightness all grow toward the viewer, and the hash columns converge, which
 * is what turns a set of lines into a field seen from the stands.
 */
function field() {
  const lines = [258, 285, 318, 359, 410, 473];
  const depth = (y) => (y - HORIZON) / (VIEW - HORIZON);
  const marks = [];
  for (const y of lines) {
    const t = depth(y);
    const h = 1.6 + 1.8 * t;
    marks.push(
      `<rect x="0" y="${n(y - h / 2)}" width="${VIEW}" height="${n(h)}" fill="#fff" opacity="${n(0.09 + 0.11 * t)}"/>`,
    );
  }
  for (let i = 0; i < lines.length - 1; i++) {
    const y = (lines[i] + lines[i + 1]) / 2;
    const t = depth(y);
    const [offset, w, h] = [62 + 78 * t, 9 + 12 * t, 1.6 + 1.6 * t];
    for (const side of [-1, 1]) {
      marks.push(
        `<rect x="${n(VIEW / 2 + side * offset - w / 2)}" y="${n(y - h / 2)}" width="${n(w)}" height="${n(h)}" fill="#fff" opacity="0.16"/>`,
      );
    }
  }
  return marks.join("\n    ");
}

function svg({ size, ball, corner }) {
  const rx = VIEW * corner;
  const scale = (VIEW * ball) / BALL.width;
  const place = `translate(${BALL_AT.x} ${BALL_AT.y}) rotate(${BALL_AT.tilt}) scale(${n(scale)}) translate(${-BALL.width / 2} ${-BALL.height / 2})`;
  // A faint bevel on the rounded tile only: a full-bleed icon is cropped by the
  // launcher and the edge would land wherever its mask does.
  const bevel =
    corner > 0
      ? `<rect x="1.5" y="1.5" width="${VIEW - 3}" height="${VIEW - 3}" rx="${n(rx - 1.5)}" fill="none" stroke="#fff" stroke-width="3" opacity="0.07"/>`
      : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${VIEW} ${VIEW}">
  <defs>
    <clipPath id="tile"><rect width="${VIEW}" height="${VIEW}" rx="${n(rx)}"/></clipPath>
    <clipPath id="ball"><path d="${BALL.outline}"/></clipPath>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#161f34"/>
      <stop offset="0.5" stop-color="#0b1020"/>
      <stop offset="1" stop-color="${GROUND}"/>
    </linearGradient>
    <radialGradient id="light" gradientUnits="userSpaceOnUse" cx="256" cy="-60" r="360">
      <stop offset="0" stop-color="${ACCENT}" stop-opacity="0.4"/>
      <stop offset="0.5" stop-color="${ACCENT}" stop-opacity="0.09"/>
      <stop offset="1" stop-color="${ACCENT}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vignette" gradientUnits="userSpaceOnUse" cx="256" cy="230" r="330">
      <stop offset="0.55" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.38"/>
    </radialGradient>
    <linearGradient id="turf" gradientUnits="userSpaceOnUse" x1="0" y1="${HORIZON}" x2="0" y2="${HORIZON + 110}">
      <stop offset="0" stop-color="${ACCENT}" stop-opacity="0.13"/>
      <stop offset="1" stop-color="${ACCENT}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="route" gradientUnits="userSpaceOnUse" x1="52" y1="440" x2="214" y2="232">
      <stop offset="0" stop-color="${ACCENT}" stop-opacity="0"/>
      <stop offset="0.4" stop-color="${ACCENT}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${ACCENT}" stop-opacity="0.95"/>
    </linearGradient>
    <linearGradient id="leather" x1="0.15" y1="0" x2="0.85" y2="1">
      <stop offset="0" stop-color="${LEATHER.light}"/>
      <stop offset="0.5" stop-color="${LEATHER.mid}"/>
      <stop offset="1" stop-color="${LEATHER.dark}"/>
    </linearGradient>
    <radialGradient id="sheen" cx="0.34" cy="0.26" r="0.5">
      <stop offset="0" stop-color="#fff" stop-opacity="0.42"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.45" stop-color="${ACCENT}" stop-opacity="0"/>
      <stop offset="1" stop-color="${ACCENT}" stop-opacity="0.45"/>
    </linearGradient>
    <filter id="glow" x="-40%" y="-60%" width="180%" height="220%">
      <feGaussianBlur stdDeviation="2.4"/>
    </filter>
    <filter id="shadow" x="-20%" y="-100%" width="140%" height="300%">
      <feGaussianBlur stdDeviation="9"/>
    </filter>
  </defs>
  <rect width="${VIEW}" height="${VIEW}" rx="${n(rx)}" fill="url(#sky)"/>
  <g clip-path="url(#tile)">
    <rect width="${VIEW}" height="${VIEW}" fill="url(#light)"/>
    <rect x="0" y="${HORIZON}" width="${VIEW}" height="120" fill="url(#turf)"/>
    <rect x="0" y="${n(HORIZON - 0.8)}" width="${VIEW}" height="1.6" fill="${ACCENT}" opacity="0.22"/>
    ${field()}
    <rect width="${VIEW}" height="${VIEW}" fill="url(#vignette)"/>
    <path d="M52 440C84 332 128 274 214 232" fill="none" stroke="url(#route)" stroke-width="5" stroke-linecap="round" stroke-dasharray="15 12"/>
    <ellipse cx="262" cy="342" rx="140" ry="20" fill="#000" opacity="0.5" filter="url(#shadow)"/>
    <g transform="${place}" stroke-linecap="round">
      <path d="${BALL.outline}" fill="${ACCENT}" opacity="0.55" filter="url(#glow)"/>
      <path d="${BALL.outline}" fill="url(#leather)" stroke="${LEATHER.edge}" stroke-width="1.1"/>
      <path d="${BALL.outline}" fill="url(#sheen)"/>
      <g clip-path="url(#ball)" fill="${CHALK}" opacity="0.9">
        <rect x="10.4" y="-1" width="3.6" height="36"/>
        <rect x="40" y="-1" width="3.6" height="36"/>
      </g>
      <path d="${BALL.laces}" transform="translate(0.35 0.55)" fill="none" stroke="${LEATHER.edge}" stroke-width="2.5" opacity="0.5"/>
      <path d="${BALL.laces}" fill="none" stroke="${CHALK}" stroke-width="2.1"/>
      <path d="${BALL.outline}" fill="none" stroke="url(#rim)" stroke-width="1.3"/>
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
