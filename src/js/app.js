/**
 * Entry point. Loads data, wires the store, and owns the render loop.
 *
 * Data flow is one-directional:
 *   JSON + store -> buildBoard() -> ui modules
 *   ui action    -> mutate entry -> store.save() -> re-render
 */

import { CONFIG } from "./config.js";
import { LEAGUES } from "./leagues.js";
import { buildBoard, slotKey } from "./core/plan.js";
import { createStore } from "./store/index.js";
import { renderLeagueSwitch } from "./ui/league-switch.js";
import { renderStrip } from "./ui/strip.js";
import { renderWeekDeck } from "./ui/week-panel.js";
import { renderLadder } from "./ui/ladder.js";
import { renderBurnBoard } from "./ui/burn-board.js";
import { renderNotices } from "./ui/notices.js";
import { renderTabs, initialTab } from "./ui/tabs.js";
import { requireGate } from "./ui/gate.js";
import { formatDuration } from "./core/refresh.js";
import { derivePasscodeDigest } from "./core/passcode.js";

const el = {
  gate: document.getElementById("gate"),
  startup: document.getElementById("startup"),
  startupStatus: document.getElementById("startup-status"),
  notices: document.getElementById("notices"),
  strip: document.getElementById("strip"),
  deck: document.getElementById("week-deck"),
  ladder: document.querySelector("#ladder tbody"),
  burn: document.getElementById("burn"),
  burnLegend: document.getElementById("burn-legend"),
  tabs: document.getElementById("tabs"),
  league: document.getElementById("league"),
  shell: document.querySelector(".shell"),
};

/** The digest of the pool passcode, once this device has answered it correctly. */
const PASSCODE_KEY = "survivor-board/passcode";

const app = {
  // Every new page load starts on NFL. A league switch lasts only until the
  // page is loaded again, regardless of the device's previous visits.
  league: "nfl",
  plan: null,
  teams: null,
  odds: null,
  schedule: null,
  ratings: null,
  entry: { picks: {}, swaps: {} },
  store: null,
  /** The verified passcode digest, which is also what opens the store's write lock. */
  passcodeDigest: null,
  viewWeek: 1,
  activeTab: initialTab(),
  saveTimer: null,
  effect: null,
  /** One line for the notices area, such as a league that failed to load. */
  message: "",
  tickTimer: null,
  unsubscribe: null,
  switching: false,
  recommendTimer: null,
};

/** Which keyframe an action should play on the slot it changed. */
const EFFECT_FOR = { lock: "fx-lock", won: "fx-won", lost: "fx-lost", pick: "fx-swap" };

/**
 * Feedback has to be applied AFTER the render that produced the new markup -
 * innerHTML replaces the node, so anything set beforehand is thrown away.
 */
function playEffect() {
  const effect = app.effect;
  app.effect = null;
  if (!effect) return;

  const slide = el.deck.querySelectorAll(".week-slide")[effect.week - 1];
  if (!slide) return;

  const slots =
    effect.slot === null
      ? [...slide.querySelectorAll(".slot")]
      : [slide.querySelectorAll(".slot")[effect.slot]];

  for (const slot of slots) {
    if (!slot) continue;
    slot.classList.add(effect.className);
    slot.addEventListener("animationend", () => slot.classList.remove(effect.className), {
      once: true,
    });
  }
}

/**
 * Repaint for the league. Every colour in the app hangs off this attribute
 * (see src/css/leagues.css), so the switch is one write rather than a class on
 * each component. The browser chrome is told too, or the status bar keeps the
 * other pool's colour.
 */
function applyTheme(league) {
  document.documentElement.dataset.league = league;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const styles = getComputedStyle(document.documentElement);
  const ground = styles.getPropertyValue("--ground").trim();
  if (ground) meta.setAttribute("content", ground);
}

/**
 * One-shot entrance for the new league's board. Applied after the render that
 * built it, for the same reason playEffect is: innerHTML has just replaced the
 * nodes an earlier class would have been sitting on.
 */
function playSwitch() {
  const shell = el.shell;
  if (!shell) return;
  shell.classList.remove("is-switching");
  // Forces the browser to drop the finished animation before it is re-added,
  // so a second switch plays rather than doing nothing.
  void shell.offsetWidth;
  shell.classList.add("is-switching");
  setTimeout(() => shell.classList.remove("is-switching"), 500);
}

/** Local identity for the "who changed this" stamp. */
const ME = resolveIdentity();

/**
 * Read a data file. The artifact build has no sibling files to fetch, so the
 * bundler inlines the three JSON blobs on `globalThis.SURVIVOR_DATA` and this
 * short-circuits. On Pages it fetches normally.
 */
async function loadJson(name, league = app.league) {
  const preloaded = globalThis.SURVIVOR_DATA?.[league]?.[name];
  if (preloaded) return structuredClone(preloaded);

  const response = await fetch(`${CONFIG.dataPath}/${league}/${name}?v=${Date.now()}`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Could not load ${league}/${name} (${response.status})`);
  return response.json();
}

let lastBoard = null;

/** Capture stable UI nodes before a render so changed replacements can settle in. */
function captureMotionState() {
  const state = new Map();
  for (const node of el.shell?.querySelectorAll("[data-motion-key]") ?? []) {
    state.set(node.dataset.motionKey, motionSignature(node));
  }
  return state;
}

function motionSignature(node) {
  const classes = [...node.classList].filter((name) => name !== "is-data-updated").join(" ");
  return `${classes}|${node.innerHTML}`;
}

/** Animate only nodes whose content or state styling changed during the render. */
function playDataUpdates(previous) {
  if (previous.size === 0 || app.switching) return;

  const changed = [];
  for (const node of el.shell?.querySelectorAll("[data-motion-key]") ?? []) {
    const before = previous.get(node.dataset.motionKey);
    if (before !== undefined && before !== motionSignature(node)) {
      node.classList.add("is-data-updated");
      changed.push(node);
    }
  }

  if (changed.length) {
    setTimeout(() => changed.forEach((node) => node.classList.remove("is-data-updated")), 650);
  }
}

/**
 * @param {{search?:boolean, settle?:number}} options Pass search:false to paint
 *   without waiting on the optimiser. Used when the board is new to this
 *   session (first load, a league switch) and after a lock or unlock, when the
 *   search would otherwise block the frame the user is waiting to see. A
 *   follow-up render fills it in once `settle` milliseconds have passed.
 */
function render({ search = true, settle = RECOMMEND_DELAY_MS } = {}) {
  const previousMotion = captureMotionState();
  const board = buildBoard({
    plan: app.plan,
    odds: app.odds,
    teams: app.teams,
    schedule: app.schedule,
    ratings: app.ratings,
    entry: app.entry,
    refreshSchedule: CONFIG.refresh,
    allowSearch: search,
  });

  lastBoard = board;
  renderLeagueSwitch(el.league, app.league, switchLeague);
  renderNotices(el.notices, { store: app.store, board, message: app.message });
  renderStrip(el.strip, board);
  renderTabs(el.tabs, app.activeTab, selectTab);
  renderWeekDeck(el.deck, board, app.viewWeek, {
    canWrite: app.store.canWrite,
    // Swiping must not re-render - that would yank the track out from under
    // the gesture. Just record where we are.
    onWeekChange: (week) => {
      app.viewWeek = week;
    },
    onAction: handleAction,
  });
  // Picking a row on the Full Path tab is a request to work on that week,
  // so jump to the week view rather than leaving the user to switch tabs.
  renderLadder(el.ladder, board, (week) => {
    app.viewWeek = week;
    app.activeTab = "week";
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  renderBurnBoard(el.burn, el.burnLegend, board, app.teams);
  playDataUpdates(previousMotion);
  playEffect();

  if (board.recommendationPending) scheduleRecommendation(settle);
}

/**
 * How long to leave the main thread alone before running the optimiser.
 *
 * Long enough for the board's entrance to finish. The search takes a few
 * hundred milliseconds and cannot be interrupted, and a CSS animation that is
 * only part way through when that happens does not quietly continue: it stalls
 * and then jumps to its end. Waiting for the animation to be over is what buys
 * the smooth arrival; the freeze then lands while the board is sitting still
 * and being read, where nothing visible is waiting on it.
 */
const RECOMMEND_DELAY_MS = 380;

/**
 * A lock, an unlock or a result changes what the coach has to plan around, so
 * the search runs again. This is how long its feedback keyframe needs to finish
 * first: the win wash is the longest of them at 720 ms.
 */
const REPLAN_DELAY_MS = 750;

/** Run the optimiser once the board the user asked for is on screen and settled. */
function scheduleRecommendation(delay = RECOMMEND_DELAY_MS) {
  if (app.recommendTimer) return;
  app.recommendTimer = setTimeout(() => {
    app.recommendTimer = null;
    // The result is memoised, so this render is the only one that pays.
    render();
  }, delay);
}

/**
 * One second heartbeat for the next-pull countdown in the strip.
 *
 * It writes textContent on one node rather than re-rendering, so a focused
 * button is never torn out from under the user and the board is not rebuilt
 * sixty times a minute.
 */
function startClock() {
  clearInterval(app.tickTimer);
  app.tickTimer = setInterval(() => {
    const countdown = document.getElementById("countdown");
    if (!countdown || !lastBoard) return;

    const remaining = lastBoard.nextRefreshAt - Date.now();
    // The scheduled run has come and gone; recompute against the new slot.
    if (remaining <= 0) {
      render();
      return;
    }
    countdown.textContent = formatDuration(remaining);
  }, 1000);
}

function selectTab(id) {
  if (id === app.activeTab) return;
  app.activeTab = id;
  render();
}

function handleAction({ action, week, slot, team }) {
  if (!app.store.canWrite) return;

  const key = slotKey(week, slot);
  const current = app.entry.picks[key] ?? {};
  // What the slot holds on the board that was tapped.
  const held = lastBoard?.weeks.find((entry) => entry.week === week)?.picks[slot] ?? null;

  switch (action) {
    case "pick":
      // The team in a slot is always the users' choice, and a locked slot keeps
      // its team until it is unlocked. Picking never commits: the coach plans
      // as if the slot were still open until it is locked.
      if (!team || held?.status.locked) return;
      if (held?.team === team) {
        // The selected row is the clear control too: tapping it again returns
        // the slot to the coach without needing a separate action button.
        delete app.entry.picks[key];
        delete app.entry.swaps[key];
      } else {
        app.entry.swaps[key] = team;
      }
      break;
    case "lock":
      if (current.locked) {
        // Unlocking keeps the team as an unlocked pick. Entries saved before
        // slots were user-picked could lock a team without storing it, so it
        // is stored now, before the lock that implied it goes.
        if (held?.team && !app.entry.swaps[key]) app.entry.swaps[key] = held.team;
        delete app.entry.picks[key];
      } else {
        if (!held?.team) return;
        app.entry.picks[key] = { ...current, locked: true, by: ME, at: Date.now() };
      }
      break;
    case "won":
      app.entry.picks[key] = {
        ...current,
        result: current.result === "W" ? null : "W",
        by: ME,
        at: Date.now(),
      };
      break;
    case "lost":
      app.entry.picks[key] = {
        ...current,
        result: current.result === "L" ? null : "L",
        by: ME,
        at: Date.now(),
      };
      break;
    default:
      return;
  }

  app.effect = { week, slot, className: EFFECT_FOR[action] };

  // A lock, an unlock or a result changes what the coach has to plan around,
  // and the search that answers it blocks the main thread. Paint the change
  // first and let the timer run the search once the feedback has played. An
  // action that did not move the plan comes straight out of the memo.
  render({ search: false, settle: REPLAN_DELAY_MS });
  scheduleSave();
}

/** Coalesce rapid taps into one write. */
function scheduleSave() {
  clearTimeout(app.saveTimer);
  app.saveTimer = setTimeout(() => {
    app.store.save(structuredClone(app.entry)).catch(() => {
      /* a failed write must never break the UI - the next one retries */
    });
  }, 250);
}

function resolveIdentity() {
  const stored = localStorage.getItem("survivor-board/who");
  if (stored) return stored;
  const name = `Viewer ${Math.random().toString(36).slice(2, 4).toUpperCase()}`;
  try {
    localStorage.setItem("survivor-board/who", name);
  } catch {
    /* ignore */
  }
  return name;
}

/**
 * Load a league and take over the page.
 *
 * Every league owns its data folder and its own stored entry, so a switch is a
 * full reload of the board rather than a filter over one: old subscriptions
 * are torn down first, and nothing from the previous league survives.
 */
async function openLeague(league) {
  app.unsubscribe?.();
  app.unsubscribe = null;
  clearTimeout(app.recommendTimer);
  app.recommendTimer = null;
  app.message = "";

  const [plan, teams, odds, schedule, ratings] = await Promise.all([
    loadJson("plan.json", league),
    loadJson("teams.json", league),
    loadJson("odds.json", league),
    loadJson("schedule.json", league),
    loadJson("ratings.json", league),
  ]);

  app.league = league;
  app.plan = plan;
  app.teams = teams;
  app.odds = odds;
  app.schedule = schedule;
  app.ratings = ratings;
  app.viewWeek = Math.min(Math.max(odds.currentWeek ?? 1, 1), plan.weeks.length);

  document.title = `${LEAGUES[league].title} · ${LEAGUES[league].label}`;
  applyTheme(league);

  app.store = await createStore(league);
  // The gate already checked the passcode on this device, so the store's write
  // lock opens with the same digest. With no passcode configured there is no
  // lock to open.
  if (!app.store.canWrite) app.store.unlock?.(app.passcodeDigest);
  app.entry = await app.store.init();
  app.unsubscribe = app.store.subscribe((entry) => {
    // A late push from the store we just replaced must not land on this board.
    if (app.league !== league) return;
    app.entry = entry;
    render();
  });

  render({ search: false });
}

/**
 * Handler for the masthead switch.
 *
 * Rebuilding a board is not instant: the recommendation is a beam search over
 * the whole remaining season, and it runs synchronously. So the tap is answered
 * before the work starts, not after it. The switch and the palette move on the
 * frame you touch them, the board fades out, and the new one fades in when it
 * is ready. Without the two frames of waiting, the fade-out would be computed
 * and then never painted, because the search blocks the main thread before the
 * browser gets a chance.
 */
async function switchLeague(league) {
  if (app.switching || league === app.league) return;
  app.switching = true;

  renderLeagueSwitch(el.league, league, switchLeague);
  el.shell?.classList.add("is-swapping");
  await twoFrames();
  // The colour tokens switch inside openLeague. Let the old board finish its
  // 160ms exit first so borders and badges cannot flash the incoming palette
  // while they are still visible.
  await new Promise((resolve) => setTimeout(resolve, 150));

  try {
    await openLeague(league);
  } catch (error) {
    // Put the board back the way it was, including its colours.
    renderLeagueSwitch(el.league, app.league, switchLeague);
    applyTheme(app.league);
    app.message = `Could not load ${LEAGUES[league]?.label ?? league}: ${error.message}`;
    render();
  } finally {
    el.shell?.classList.remove("is-swapping");
    // Removing the class and starting the entrance happen in the same task, so
    // the browser never paints the un-faded board in between.
    playSwitch();
    app.switching = false;
  }
}

/**
 * Resolve after the browser has had a chance to paint. One frame schedules the
 * work; the second runs after the frame that included it has gone out.
 */
function twoFrames() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked - the choice just will not persist */
  }
}

/**
 * The passcode screen, once per device.
 *
 * A device that has answered correctly before is let straight through. The
 * check lives here rather than in the store because it gates the whole board,
 * not just writes; see the note on `passcode` in config.js for what it is and
 * is not protecting.
 *
 * Only the digest is ever compared or stored: the typed answer is run through
 * the same derivation `npm run passcode` used and matched against config.
 * Changing the passcode changes the digest, so every device asks again.
 */
async function requirePasscode() {
  const expected = CONFIG.passcode.digest;
  if (!expected) return;

  if (readStored(PASSCODE_KEY) === expected) {
    app.passcodeDigest = expected;
    return;
  }

  document.body.classList.add("is-gated");
  await requireGate(el.gate, async (value) => {
    const digest = await derivePasscodeDigest(value, CONFIG.passcode.salt);
    return digest === expected;
  });
  app.passcodeDigest = expected;
  writeStored(PASSCODE_KEY, expected);
  document.body.classList.remove("is-gated");
}

/** Keep quick cached loads on screen long enough for the startup play to read. */
function startupMinimum() {
  const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 900;
  return new Promise((resolve) => setTimeout(resolve, duration));
}

/** Hand the fully rendered board over from the startup layer. */
async function finishStartup() {
  if (!el.startup) return;
  if (el.startupStatus) el.startupStatus.textContent = "Board ready";
  el.startup.classList.add("is-ready");
  // Reveal the board beneath the fading layer, making this one handoff rather
  // than a blank beat followed by a second entrance.
  document.body.classList.remove("is-starting");

  const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 420;
  await new Promise((resolve) => setTimeout(resolve, duration));
  el.startup.hidden = true;
}

/**
 * Registers `sw.js`. Chrome will not offer "Install app" for a site without a
 * service worker, however complete its manifest is, and the same worker is what
 * keeps the board readable on a phone with no signal.
 *
 * It goes last on purpose: it must never delay the first paint, and a failure
 * (an insecure origin, a browser without support) is not worth a notice.
 */
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./sw.js").catch((error) => {
    console.warn("Service worker not registered:", error.message);
  });
}

async function main() {
  // Every visit begins in the NFL palette. The gate keeps that same fixed blue
  // identity before the NFL board opens.
  applyTheme(app.league);
  if (CONFIG.passcode.digest && readStored(PASSCODE_KEY) !== CONFIG.passcode.digest) {
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#080b12");
  }
  await requirePasscode();
  await Promise.all([openLeague(app.league), startupMinimum()]);
  await finishStartup();
  startClock();
  registerServiceWorker();
}

main().catch((error) => {
  document.body.classList.remove("is-gated");
  document.body.classList.remove("is-starting");
  if (el.startup) el.startup.hidden = true;
  if (el.gate) el.gate.hidden = true;
  el.notices.innerHTML = `<div class="notice notice--warn">Could not load the board: ${error.message}</div>`;
  console.error(error);
});
