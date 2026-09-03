/**
 * Entry point. Loads data, wires the store, and owns the render loop.
 *
 * Data flow is one-directional:
 *   JSON + store -> buildBoard() -> ui modules
 *   ui action    -> mutate entry -> store.save() -> re-render
 */

import { CONFIG } from "./config.js";
import { LEAGUES, resolveLeague } from "./leagues.js";
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

const el = {
  gate: document.getElementById("gate"),
  notices: document.getElementById("notices"),
  strip: document.getElementById("strip"),
  deck: document.getElementById("week-deck"),
  ladder: document.querySelector("#ladder tbody"),
  burn: document.getElementById("burn"),
  burnCount: document.getElementById("burn-count"),
  tabs: document.getElementById("tabs"),
  league: document.getElementById("league"),
  shell: document.querySelector(".shell"),
};

/** Which league was open last on this device. */
const LEAGUE_KEY = "survivor-board/league";

/** The pool passcode, once this device has given it. */
const PASSCODE_KEY = "survivor-board/passcode";

const app = {
  league: resolveLeague(readStored(LEAGUE_KEY)),
  plan: null,
  teams: null,
  odds: null,
  schedule: null,
  ratings: null,
  entry: { picks: {}, swaps: {} },
  store: null,
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
const EFFECT_FOR = { lock: "fx-lock", won: "fx-won", lost: "fx-lost", swap: "fx-swap" };

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

/**
 * @param {{search?:boolean}} options Pass search:false to paint without waiting
 *   on the optimiser. Used when the board is new to this session (first load, a
 *   league switch) and the search would otherwise block the frame the user is
 *   waiting to see. A follow-up render fills it in.
 */
function render({ search = true } = {}) {
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
  renderBurnBoard(el.burn, el.burnCount, board, app.teams);
  playEffect();

  if (board.recommendationPending) scheduleRecommendation();
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

/** Run the optimiser once the board the user asked for is on screen and settled. */
function scheduleRecommendation() {
  if (app.recommendTimer) return;
  app.recommendTimer = setTimeout(() => {
    app.recommendTimer = null;
    // The result is memoised, so this render is the only one that pays.
    render();
  }, RECOMMEND_DELAY_MS);
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

  switch (action) {
    case "lock":
      app.entry.picks[key] = { ...current, locked: !current.locked, by: ME, at: Date.now() };
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
    case "clear":
      delete app.entry.picks[key];
      break;
    case "apply": {
      // Adopt both recommended teams for the week, leaving any locked slot
      // alone - the recommendation already worked around it.
      const board = lastBoard;
      const target = board?.weeks.find((entry) => entry.week === week);
      for (const pick of target?.picks ?? []) {
        if (pick.status.locked || pick.status.result) continue;
        const wanted = (target.recommended ?? [])
          .map((o) => o.team)
          .find((team) => {
            const taken = target.picks.some(
              (other) => other.slot !== pick.slot && other.team === team,
            );
            return !taken;
          });
        if (!wanted) continue;
        const slotK = slotKey(week, pick.slot);
        if (wanted === planTeamFor(week, pick.slot)) delete app.entry.swaps[slotK];
        else app.entry.swaps[slotK] = wanted;
        pick.team = wanted;
      }
      break;
    }
    case "swap":
      // Selecting the plan's own pick clears the swap rather than storing it,
      // so the entry stays clean and follows any future re-plan.
      if (!team || team === planTeamFor(week, slot)) delete app.entry.swaps[key];
      else app.entry.swaps[key] = team;
      break;
    default:
      return;
  }

  if (action !== "clear") {
    app.effect = {
      week,
      slot: action === "apply" ? null : slot,
      className: action === "apply" ? "fx-swap" : (EFFECT_FOR[action] ?? "fx-swap"),
    };
  }

  render();
  scheduleSave();
}

function planTeamFor(week, slot) {
  return app.plan.weeks.find((entry) => entry.week === week)?.picks[slot]?.team ?? null;
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
  // lock opens with the same value. With no passcode configured there is no
  // lock to open.
  if (!app.store.canWrite) app.store.unlock?.(CONFIG.passcode);
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
  applyTheme(league);
  el.shell?.classList.add("is-swapping");
  await twoFrames();

  try {
    await openLeague(league);
    // Remembered only once it loaded, so a failed switch does not leave the
    // next visit opening a league that will not load either.
    writeStored(LEAGUE_KEY, league);
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
 * is not protecting. Changing the passcode makes every device ask again.
 */
async function requirePasscode() {
  const expected = CONFIG.passcode;
  if (!expected || readStored(PASSCODE_KEY) === expected) return;

  document.body.classList.add("is-gated");
  await requireGate(el.gate, (value) => value.trim() === expected);
  writeStored(PASSCODE_KEY, expected);
  document.body.classList.remove("is-gated");
}

async function main() {
  // The gate wears the last league's colours, so it looks like the board it opens.
  applyTheme(app.league);
  await requirePasscode();
  await openLeague(app.league);
  startClock();
}

main().catch((error) => {
  document.body.classList.remove("is-gated");
  if (el.gate) el.gate.hidden = true;
  el.notices.innerHTML = `<div class="notice notice--warn">Could not load the board: ${error.message}</div>`;
  console.error(error);
});
