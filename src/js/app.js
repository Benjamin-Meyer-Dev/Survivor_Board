/**
 * Entry point. Loads data, wires the store, and owns the render loop.
 *
 * Two screens. The home page lists the leagues this device is in and is where
 * they are made, joined and shared; a board is one league, opened by code.
 * Which one is showing is `app.view`, and the hash carries it so a league can
 * be linked to (#/l/CODE, or #/l/CODE/KIND for one of a league's pools) and
 * joined from a message (#/join/CODE).
 *
 * Data flow is one-directional either way:
 *   JSON + store -> buildBoard() -> ui modules
 *   ui action    -> mutate entry -> store.save() -> re-render
 */

import { APP_NAME, CONFIG } from "./config.js";
import { POOL_KINDS, KIND_IDS, resolveSport, normaliseKinds } from "./sports.js";
import { buildBoard, previewHolds, slotKey, sameEntry, searchesSettled } from "./core/plan.js";
import { onSearchSettled, searchRunner } from "./core/search.js";
import { useWorkerForSearch } from "./worker-search.js";
import { createStore } from "./store/index.js";
import {
  accessGranted,
  adoptOldStorage,
  createLeague,
  deleteLeague,
  grantAccess,
  joinLeague,
  knownRow,
  leaveLeague,
  leagueByCode,
  myLeagues,
  myName,
  myId,
  refreshMyLeagues,
  removePool,
  renameLeague,
  setMyName,
  sharingAvailable,
} from "./store/directory.js";
import { derivePasscodeDigest } from "./core/passcode.js";
import { codeFromHash, leagueHash, normaliseCode } from "./core/code.js";
import { renderLeagueBar } from "./ui/league-bar.js";
import { renderSettings } from "./ui/settings.js";
import { watchDrags } from "./ui/swipe.js";
import { afterMotion, playOnce, prefersReducedMotion, twoFrames } from "./ui/motion.js";
import { renderHome, closeHomePanels, markOpening } from "./ui/home.js";
import { renderPitch, markViewing } from "./ui/pitch.js";
import { renderCall } from "./ui/call.js";
import { renderSideline } from "./ui/sideline.js";
import { renderDrive, markDriveViewing } from "./ui/drive.js";
import { renderBench } from "./ui/bench.js";
import { renderNotices } from "./ui/notices.js";
import { renderTabs, initialTab } from "./ui/tabs.js";
import { requireName } from "./ui/name.js";
import { requirePasscode } from "./ui/passcode.js";
import { holdBack, releaseBack } from "./ui/back.js";
import { formatDuration } from "./core/refresh.js";

const el = {
  start: document.getElementById("start"),
  home: document.getElementById("home"),
  /** The home page's create and join sheets, kept out of the redrawn list. */
  homeSheets: document.getElementById("home-sheets"),
  board: document.getElementById("board"),
  startup: document.getElementById("startup"),
  startupStatus: document.getElementById("startup-status"),
  notices: document.getElementById("notices"),
  /** The readout: the field and drive line, then the week's call. */
  pitch: document.getElementById("pitch"),
  call: document.getElementById("call"),
  /** The drawer's three panels, and the two of them a week turns. */
  sideline: document.getElementById("sideline"),
  drive: document.getElementById("drive"),
  bench: document.getElementById("bench"),
  weekPanel: document.getElementById("view-week"),
  pathPanel: document.getElementById("view-path"),
  benchLegend: document.getElementById("bench-legend"),
  tabs: document.getElementById("tabs"),
  league: document.getElementById("league"),
  settings: document.getElementById("settings"),
  /** The league bar: the way back, the name, the pool picker and the gear. A board's, so hidden on the home page. */
  leagueBar: document.getElementById("league-bar"),
  shell: document.querySelector(".shell"),
};

const app = {
  /** "home" or "board". The home page is where a launch with no link lands. */
  view: "home",
  /** The open league: {code, name, kinds}. Null on the home page. */
  league: null,
  /** Which of the open league's pools the board is showing: a kind id (see sports.js). */
  kind: null,
  /** This device's leagues, as the home page knows them. */
  leagues: [],
  /** Whether the shared copy of that list is still on its way. */
  leaguesLoading: true,
  /** This person's name, which rides along on every lock. */
  name: "",
  /** A line for the home page: a code that did not open, a create that failed. */
  homeMessage: "",
  plan: null,
  teams: null,
  odds: null,
  schedule: null,
  ratings: null,
  /** Ratings fitted to this season's pulls. Null when the file is not there. */
  form: null,
  /** The league's fitted probability model. Null falls back to the defaults. */
  calibration: null,
  /** Player availability, kept by hand. Null means nothing reported. */
  availability: null,
  /** The pool's size and pick popularity, kept by hand. Null, and the field is implied. */
  pool: null,
  entry: { picks: {}, swaps: {} },
  store: null,
  /** The week being looked at: the call, the sideline and the drive follow it. */
  viewWeek: 1,
  /** Which of that week's slots the sideline is filling. */
  activeSlot: 0,
  activeTab: initialTab(),
  effect: null,
  /** One line for the notices area, such as a league that failed to load. */
  message: "",
  tickTimer: null,
  unsubscribe: null,
  switching: false,
  recommendTimer: null,
  /** A rebuild owed to the bracket moving onto, or off, a pick pending (see followTheBracket). */
  previewTimer: null,
  /**
   * The motion an action is playing on the board, as a promise of its end
   * (playEffect). Null while nothing is. What a search landing and an inline
   * search wait on (stillness), so neither cuts a keyframe short.
   */
  motion: null,
  /** A repaint owed to a search that landed while that motion ran (repaintAfterMotion). */
  repaintOwed: false,
  /**
   * Whether the board on screen is still arriving: opened, but painted before
   * its season plan landed. Until the plan is in, a render is the rest of the
   * board turning up rather than the board changing, and must not be settled
   * in a second time on top of the entrance (see playDataUpdates).
   */
  arriving: false,
};

/** Which keyframe an action should play on the slot it changed. */
const EFFECT_FOR = { lock: "fx-lock", pick: "fx-swap" };

/**
 * What turns when the week does: a box that clips the slide, and the thing
 * inside it that moves across.
 *
 * The field is deliberately not here. Its bracket slides along the yard lines
 * under its own smooth scroll, and it is what everything else moves against -
 * a board where the field slid too would have nothing standing still to read
 * the movement from. Nor is the bench, which says the same thing whatever week
 * is open.
 */
const SLIDING = [
  { clip: "#call", moves: ".call" },
  { clip: "#view-week", moves: "#sideline" },
  { clip: "#view-path", moves: "#drive" },
];

/**
 * Feedback has to be applied AFTER the render that produced the new markup -
 * innerHTML replaces the node, so anything set beforehand is thrown away.
 *
 * How long any of it lasts is not written here. Every duration in the app
 * lives in the stylesheet that draws it, and ui/motion.js asks the browser
 * when a move is over - a keyframe shortened in motion.css used to leave a
 * class hanging on for a beat, and a keyframe lengthened had its class
 * stripped mid-flight, with nothing in the repo able to catch either.
 *
 * @returns {{className:string, nodes:HTMLElement[]}|null} What was decorated,
 *   so the render can keep other motion off the same nodes.
 */
function playEffect() {
  const effect = app.effect;
  app.effect = null;
  if (!effect) return null;

  // The call shows the week being looked at, which is the week that was tapped.
  const slots =
    effect.slot === null
      ? [...el.call.querySelectorAll(`.call__slot[data-week="${effect.week}"]`)]
      : [
          el.call.querySelector(
            `.call__slot[data-week="${effect.week}"][data-slot="${effect.slot}"]`,
          ),
        ].filter(Boolean);
  if (slots.length === 0) return null;

  const plays = slots.map((slot) => {
    slot.classList.add(effect.className);
    const play = afterMotion(slot);
    play.then(() => slot.classList.remove(effect.className));
    return play;
  });
  // The board's motion, for whatever has to wait on it (stillness). Cleared
  // when it ends, unless a later action has put its own in its place.
  const motion = Promise.all(plays).then(() => {
    if (app.motion === motion) app.motion = null;
  });
  app.motion = motion;
  return { className: effect.className, nodes: slots };
}

/**
 * Resolves once nothing an action started is still moving on the board.
 *
 * A render replaces the nodes whose markup changed, and a search on this
 * thread stalls whatever is moving, so both wait here: the repaint for a
 * search that landed (repaintAfterMotion) and the inline search itself
 * (scheduleRecommendation). An action begun during the wait is waited on too.
 * Read off the animations themselves (afterMotion in ui/motion.js), not off a
 * clock beside them.
 */
async function stillness() {
  let motion;
  while ((motion = app.motion)) await motion;
}

/**
 * A search has landed (onSearchSettled in main): paint it in, once the board
 * is still.
 *
 * The result is in the cache the moment it lands; only the paint waits. The
 * search behind a lock's "if locked" number used to land inside the lock's
 * own keyframes and paint at once, and the paint replaced the slot the
 * keyframes were on - which is what a stall on the first lock of a session
 * was. Landings while the wait is on are one repaint, and a tap in the
 * meantime takes it: the render the tap makes reads the same cache.
 */
function repaintAfterMotion() {
  if (app.view !== "board") return;
  if (!lastBoard?.recommendationPending && !lastBoard?.previewPending) return;
  if (app.repaintOwed) return;
  app.repaintOwed = true;
  stillness().then(() => {
    if (!app.repaintOwed) return;
    app.repaintOwed = false;
    if (app.view !== "board") return;
    if (!lastBoard?.recommendationPending && !lastBoard?.previewPending) return;
    render({ search: false });
  });
}

/**
 * Repaint for the sport, and for what its picks have to do. Every colour in
 * the app hangs off these two attributes (see src/css/leagues.css), so a
 * change of league is two writes rather than a class on each component. The
 * browser chrome is told too, or the status bar keeps the last league's
 * colour.
 *
 * A league picking losers takes its sport's surfaces under a warm accent: two
 * leagues on the same schedule wanting opposite results should not look
 * identical.
 */
function applyTheme(sport, objective = "win") {
  document.documentElement.dataset.league = resolveSport(sport);
  document.documentElement.dataset.objective = objective === "lose" ? "lose" : "win";

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
  playOnce(el.shell, ["is-switching"]);
}

/**
 * The classes a page change puts on a page, in two halves.
 *
 * Kept apart because the halves are cleared at different moments: a page has
 * finished leaving as soon as the next one is up, but the one arriving is
 * still arriving then, and stripping its classes there is exactly what stopped
 * a board from ever animating in - so those come off when the keyframes they
 * name are over (playOnce in ui/motion.js). Both together is settlePages,
 * where the change is not an animation at all.
 */
const PAGE_LEAVE_CLASSES = ["is-page-leaving", "is-page-leaving--in", "is-page-leaving--out"];
const PAGE_ENTER_CLASSES = ["is-page-entering", "is-page-entering--in", "is-page-entering--out"];
const PAGE_CLASSES = [...PAGE_LEAVE_CLASSES, ...PAGE_ENTER_CLASSES];

/**
 * Send a page away: it goes the way you are travelling and stops taking taps.
 *
 * @param {HTMLElement|null} page
 * @param {"in"|"out"} way "in" for stepping into a league, "out" for stepping
 *   back to the list of them. The two scale opposite ways, which is what makes
 *   the step read as forward or back rather than as a swap.
 * @returns {Promise<void>} Resolves when the page has gone, so a caller can
 *   sequence the halves without knowing the timing. Already resolved with
 *   motion reduced, or for a page that was not on screen to begin with, and
 *   then the change is a straight swap.
 */
function leavePage(page, way) {
  if (!page || page.hidden || prefersReducedMotion()) return Promise.resolve();
  page.classList.add("is-page-leaving", `is-page-leaving--${way}`);
  // The page's own fade, not its children's: subtree off, or this would wait
  // for whatever the page it is replacing still has running inside it.
  return afterMotion(page, { subtree: false });
}

/**
 * And bring one on: it comes from the other side of the same move, in bands a
 * beat apart (see motion.css).
 *
 * One-shot, applied after the render that built the page, for the same reason
 * playEffect and playSwitch are - innerHTML has just replaced the nodes an
 * earlier class would have been sitting on.
 */
function enterPage(page, way) {
  if (!page) return;
  page.classList.remove(...PAGE_LEAVE_CLASSES);
  playOnce(page, ["is-page-entering", `is-page-entering--${way}`]);
}

/** Whatever a page change left on either page, off. */
function settlePages() {
  for (const page of [el.home, el.board]) {
    page?.classList.remove(...PAGE_CLASSES);
  }
}

/**
 * Local identity, saved as `by` on every lock and result: the device's id and
 * the name this person gave on first run. The board does not show it, but a
 * league with several people in it records who did what and when.
 */
const ME = myId();

/**
 * Every file a board reads, in the order loadLeague unpacks them, and how many
 * of them it cannot open without. The first five are the season itself; the
 * rest each have a default (see loadLeague), and two of them do not exist for
 * most pools.
 *
 * One list, because the home page warms the same files it will need a tap
 * later (warmBoardData) and a second copy of it would drift.
 */
const BOARD_FILES = [
  "plan.json",
  "teams.json",
  "odds.json",
  "schedule.json",
  "ratings.json",
  "form.json",
  "calibration.json",
  "availability.json",
  "pool.json",
];

/** How many of BOARD_FILES a board cannot open without. */
const BOARD_FILES_REQUIRED = 5;

/**
 * The files a season is described by, which do not change while the app is
 * open: the calendar, the roster, the fixtures, the ratings it shipped with and
 * the fitted model. Read once per sport and held for the session.
 */
const SETTLED_FILES = new Set([
  "plan.json",
  "teams.json",
  "schedule.json",
  "ratings.json",
  "calibration.json",
]);

/**
 * And how long the rest are trusted for: the lines, the fit to them, the
 * availability reports and the pool's numbers, all of which the refresh job
 * rewrites. Long enough that switching between a league's pools is free, short
 * enough that a board left open all evening is not reading this morning's
 * lines the next time it is opened.
 */
const FRESH_FOR_MS = 5 * 60 * 1000;

/** Per sport and file: the request that answered, and when it goes stale. */
const files = new Map();

/**
 * Read a data file. The artifact build has no sibling files to fetch, so the
 * bundler inlines the JSON blobs on `globalThis.SUDDEN_DEATH_DATA` and this
 * short-circuits. On Pages it fetches, once.
 *
 * Every caller gets its own copy, because loadLeague writes the pool's
 * objective into the plan's rules and two pools of one league would otherwise
 * be reading each other's.
 */
async function loadJson(name, sport = POOL_KINDS[app.kind]?.sport) {
  // Per sport, not per league: every league on the NFL schedule is priced off
  // the one data/nfl pull, however many of them there are.
  const folder = resolveSport(sport);
  const preloaded = globalThis.SUDDEN_DEATH_DATA?.[folder]?.[name];
  if (preloaded) return structuredClone(preloaded);
  return structuredClone(await fetchJson(folder, name));
}

/**
 * The request for one file, shared by everything that asks for it while it is
 * still fresh. A league switch used to re-fetch all nine files even between two
 * pools on the same season, where seven of them are the same bytes.
 *
 * No cache-busting query. The fetch is `no-store`, which is what actually keeps
 * the browser out of it, and the service worker goes to the network for data
 * files first anyway (sw.js) - the query string only ever made every launch
 * store the same file under a new key.
 */
function fetchJson(folder, name) {
  const key = `${folder}/${name}`;
  const held = files.get(key);
  if (held && held.until > Date.now()) return held.request;

  const request = fetch(`${CONFIG.dataPath}/${folder}/${name}`, { cache: "no-store" }).then(
    (response) => {
      if (!response.ok) {
        const error = new Error(`Could not load ${folder}/${name} (${response.status})`);
        error.status = response.status;
        throw error;
      }
      return response.json();
    },
  );
  // A file the season does not have is known to be missing for as long as a
  // fresh one is trusted: the optional ones are missing on most boards, and
  // asking again on every open was two round trips for two 404s that the home
  // page had already paid for. Not for good, so a form.json written mid-season
  // is still picked up. Any other failure - the network, a bad answer - is not
  // an answer to hold on to at all, and the open asks again.
  request.catch((error) => {
    if (error?.status === 404) files.set(key, { request, until: Date.now() + FRESH_FOR_MS });
    else files.delete(key);
  });
  files.set(key, {
    request,
    until: SETTLED_FILES.has(name) ? Infinity : Date.now() + FRESH_FOR_MS,
  });
  return request;
}

/**
 * Start reading the season files for the sports this device's leagues play,
 * as soon as the device's list of them is read (reloadLeagues).
 *
 * Opening a league used to be the first moment any of them was asked for, so
 * the tap on Open paid for nine round trips before a board could be built -
 * and the step from the list to the league was that wait with nothing in it.
 * The list on the device already says which seasons its leagues are on, so
 * the fetches go out with it and the tap finds them answered - and so does a
 * launch straight into a league from a link, whose files are on their way
 * while the directory is still being asked about the list.
 *
 * Deliberately quiet: this is a head start, not a load. Every failure is the
 * open's to report, and a file that would not come is asked for again there
 * (fetchJson drops it from the cache).
 */
function warmBoardData() {
  const sports = new Set(
    app.leagues.flatMap((league) =>
      normaliseKinds(league.kinds).map((kind) => POOL_KINDS[kind]?.sport),
    ),
  );
  for (const sport of sports) {
    if (!sport) continue;
    for (const name of BOARD_FILES) loadJson(name, sport).catch(() => {});
  }
}

let lastBoard = null;

/** Everything buildBoard needs from the loaded league, minus the search flag. */
function boardInputs() {
  return {
    plan: app.plan,
    odds: app.odds,
    teams: app.teams,
    schedule: app.schedule,
    ratings: app.ratings,
    form: app.form,
    calibration: app.calibration,
    availability: app.availability,
    pool: app.pool,
    entry: app.entry,
    refreshSchedule: CONFIG.refresh,
    // The slot the lock button would lock, so "if locked" prices that lock and
    // not every pick pending on the board (heldFor in core/plan.js).
    inHand: { week: app.viewWeek, slot: app.activeSlot },
  };
}

/**
 * How long the field takes to slide its bracket to a week, with room to spare:
 * the smooth scroll the browser runs for it (markViewing in ui/pitch.js) and
 * the week sliding in behind a drag (week-slide-in in motion.css, 280 ms).
 * A rebuild inside that window replaces the field under its own scroll, and
 * the bracket jumps the rest of the way.
 */
const BRACKET_SETTLE_MS = 400;

/**
 * The bracket has moved: rebuild the board if the move gives "if locked" a
 * different lock to rehearse.
 *
 * The number prices the lock the slot in hand would make (boardInputs), so the
 * bracket moving onto a pending pick, or off one onto a slot with nothing to
 * lock (where the readout shows a dash), changes what the readout says. A move
 * between two slots with nothing pending in either costs nothing here.
 * `before` is what the readout was for before the move (previewHolds).
 *
 * @param {string} before
 * @param {{settle?:boolean}} [options] `settle` waits for the field to finish
 *   sliding first; a slot changing hands within a week has nothing to wait for.
 */
function followTheBracket(before, { settle = false } = {}) {
  if (!lastBoard || previewHolds(lastBoard, boardInputs().inHand) === before) return;
  clearTimeout(app.previewTimer);
  if (!settle) {
    app.previewTimer = null;
    render({ search: false });
    return;
  }
  app.previewTimer = setTimeout(() => {
    app.previewTimer = null;
    if (app.view === "board" && !app.switching) render({ search: false });
  }, BRACKET_SETTLE_MS);
}

/**
 * Capture stable UI nodes before a render so changed replacements can settle
 * in.
 *
 * What counts as a change is each module's own business: a node that wants the
 * settle carries `data-motion-key` to say which node it is across renders and
 * `data-motion-signature` to say what it is showing. This used to read the
 * node's classes and serialise its innerHTML instead, which meant every update
 * built a string of the whole board twice - once before and once after - and
 * threw both away. It also read as a change when nothing anyone could see had
 * changed, since any attribute a render happened to write differently was in
 * the string.
 */
function captureMotionState() {
  const state = new Map();
  for (const node of el.shell?.querySelectorAll("[data-motion-key]") ?? []) {
    state.set(node.dataset.motionKey, node.dataset.motionSignature ?? "");
  }
  return state;
}

/**
 * Animate only nodes whose content or state styling changed during the render.
 *
 * The slot a tap just changed is left out: its own effect is the feedback, and
 * this settle on top of it read as the card dipping and rising again. A pick's
 * rise moves the same rows this would; a lock's ring and wash are the whole of
 * what a lock should do. The settle is for changes that arrive without a tap -
 * another device's edit, the optimiser filling in behind a stand-in, a refresh.
 *
 * @param {Map<string,string>} previous Signatures from before the render.
 * @param {{className:string, nodes:HTMLElement[]}|null} effect What playEffect
 *   just decorated.
 */
function playDataUpdates(previous, effect = null) {
  // Nothing to settle while the board is still arriving: behind the startup
  // layer, mid-swap, or opened and waiting on the season plan that finishes
  // it. In all three the search filling in is the board turning up, not the
  // board changing - and settled a second time it read as the whole page
  // playing its entrance twice, a beat after it had finished.
  if (
    previous.size === 0 ||
    app.switching ||
    app.arriving ||
    document.body.classList.contains("is-starting")
  )
    return;

  const skip = new Set(effect?.nodes ?? []);
  const changed = [];
  for (const node of el.shell?.querySelectorAll("[data-motion-key]") ?? []) {
    if (skip.has(node)) continue;
    const before = previous.get(node.dataset.motionKey);
    if (before !== undefined && before !== (node.dataset.motionSignature ?? "")) {
      node.classList.add("is-data-updated");
      changed.push(node);
    }
  }

  if (changed.length) {
    setTimeout(() => changed.forEach((node) => node.classList.remove("is-data-updated")), 650);
  }
}

/**
 * @param {{search?:boolean, settle?:number, board?:object}} options Pass
 *   search:false to paint without a search on this thread. Used when the board
 *   is new to this session (first load, a league switch) and after a lock or
 *   unlock, when the search would otherwise hold up the frame the user is
 *   waiting to see. Where a worker runs the search it goes out regardless -
 *   it costs this thread nothing - and lands as a repaint of its own once the
 *   board is still (repaintAfterMotion); without one, a follow-up render runs
 *   it here once `settle` milliseconds have passed and the board is still.
 *   Pass `board` to paint one that has already been built, so opening a league
 *   builds it once.
 * @returns {object|null} The board that was painted, or null on the home page.
 */
function render({ search = true, settle = RECOMMEND_DELAY_MS, board: prepared = null } = {}) {
  if (app.view === "home") {
    renderHomeView();
    return null;
  }

  const started = performance.now();
  // A full render is not a drag: the markup a half-finished turn is moving is
  // about to be replaced, so put the board flat first.
  settleTurn();
  // And it is the rebuild a bracket move was waiting for, if one was - and the
  // repaint a landed search was waiting for, since it reads the same cache.
  clearTimeout(app.previewTimer);
  app.previewTimer = null;
  app.repaintOwed = false;

  const previousMotion = captureMotionState();
  const board =
    prepared ?? buildBoard({ ...boardInputs(), allowSearch: search || Boolean(searchRunner()) });
  // The week being looked at has to be one the pool plays. Which weeks those
  // are is a rule now (core/rules.js), so a range narrowed here or on another
  // device can take the open week out from under the drawer.
  app.viewWeek = weekOnBoard(board, app.viewWeek);

  lastBoard = board;
  renderLeagueBar(el.league, { league: app.league, kind: app.kind }, BAR_HANDLERS);
  renderSettings(el.settings, board, {
    // The rules are the league's, so changing them is a write like any other.
    // Unlike the deck, an eliminated run does not close them: the rules are
    // how a season is set up, and a review is exactly when someone fixes the
    // ones that were wrong.
    canWrite: app.store.canWrite,
    onSave: applyRules,
    league: app.league,
    kind: app.kind,
    onRename: applyRename,
    onRemovePool: removeCurrentPool,
    onDeleteLeague: deleteCurrentLeague,
  });
  renderNotices(el.notices, { store: app.store, board, message: app.message });
  renderPitch(el.pitch, board, app.viewWeek, { onWeekChange: lookAt });
  // The drive is a board's worth of rows and none of them says which week is
  // being looked at except the one wearing the bracket, so it is rebuilt here
  // rather than on every step of a scrub (see renderSelection).
  renderDrive(el.drive, board, app.viewWeek, lookAt);
  renderSelection(board);
  renderTabs(el.tabs, app.activeTab, selectTab);
  renderBench(el.bench, el.benchLegend, board);
  // The action's own feedback first, so the settle knows which slot to leave
  // to it.
  const effect = playEffect();
  playDataUpdates(previousMotion, effect);
  // This render is the plan the board opened without: the arrival is complete,
  // and everything after it is the board changing again.
  if (!board.recommendationPending) app.arriving = false;

  // A search that is already running somewhere else will say when it lands
  // (onSearchSettled in main), so there is nothing to schedule for it.
  if (board.recommendationPending && !board.recommendationRunning) scheduleRecommendation(settle);
  measure("sudden-death:render", started);
  return board;
}

/**
 * A span on the performance timeline, so a trace taken on a phone can tell a
 * render from a search from a layout. Named `sudden-death:*`, alongside the
 * worker's own (worker-search.js) and the store's (store/supabase.js).
 */
function measure(name, started) {
  try {
    performance.measure(name, { start: started, end: performance.now() });
  } catch {
    /* an old browser without measures loses nothing but the measure */
  }
}

/**
 * The nearest week the board actually holds: the week itself where the pool
 * plays it, and otherwise the end of the run it fell off. The board's weeks
 * are the run between the pool's start and end week, so this is a clamp
 * rather than a search.
 */
function weekOnBoard(board, week) {
  const first = board.weeks[0]?.week ?? 1;
  const last = board.weeks.at(-1)?.week ?? first;
  return Math.min(Math.max(week, first), last);
}

/**
 * The parts of the board that follow the week being looked at and the slot in
 * hand: the call under the field, the sideline in the drawer, and the drive's
 * bracket. Cheap enough to run on every step of a scrub along the field.
 */
function renderSelection(board) {
  // Once the run is over the board is a review, and a review is read-only:
  // nothing more can be picked or locked, whatever the store allows.
  const canWrite = app.store.canWrite && !board.eliminated;
  renderCall(el.call, board, app.viewWeek, app.activeSlot, {
    canWrite,
    onAction: handleAction,
    onSlot: (slot) => {
      if (slot === app.activeSlot) return;
      const before = previewHolds(board, boardInputs().inHand);
      app.activeSlot = slot;
      if (lastBoard) renderSelection(lastBoard);
      followTheBracket(before);
    },
  });
  renderSideline(el.sideline, board, app.viewWeek, app.activeSlot, {
    canWrite,
    onAction: handleAction,
  });
  markDriveViewing(el.drive, app.viewWeek);
}

/**
 * The week a turn in this direction would land on, or null at the ends of the
 * run. They hold rather than wrap: week 18 is the end of the season, and a
 * drag that landed back on week 1 would read as the board having lost its
 * place. Which is also what the field does when the arrow keys run out of yard
 * lines.
 */
function weekAlong(direction) {
  if (!lastBoard) return null;
  const at = lastBoard.weeks.findIndex((week) => week.week === app.viewWeek);
  if (at === -1) return null;
  return lastBoard.weeks[at + direction] ?? null;
}

/** Whether there is a week that way, for the drag to pull against if not. */
function canTurn(direction) {
  return weekAlong(direction) !== null;
}

/**
 * Turn the board a week, once a drag has carried the week on screen off its
 * own edge (ui/swipe.js).
 *
 * The half going out was the drag itself. This is the other half: the render
 * happens while nothing is on screen, and the week that arrives comes in from
 * the side the drag came from. `--slide` carries the direction, so one pair of
 * keyframes serves both ways (see motion.css).
 *
 * Looked up again after the render, because the call's card is a new element by
 * then, where the drawer's panels are the ones the markup ships and stay put.
 * The clip goes off after the arrival, so nothing that overflows its box on
 * purpose - a focus ring, a shadow - is clipped for the rest of the time.
 */
function turnWeek(direction) {
  const next = weekAlong(direction);
  if (!next) {
    settleTurn();
    return;
  }

  lookAt(next.week);
  for (const { clip, moves } of slidingParts()) {
    moves.style.setProperty("--slide", String(direction));
    moves.classList.add("is-slide-in");
    afterMotion(moves, { subtree: false }).then(() => {
      clip.classList.remove("is-dragging");
      moves.classList.remove("is-slide-in");
      moves.style.removeProperty("--slide");
    });
  }
}

/** The regions to turn, as element pairs, skipping any that is not on screen. */
function slidingParts() {
  const parts = [];
  for (const { clip, moves } of SLIDING) {
    const box = document.querySelector(clip);
    const inner = box?.querySelector(moves);
    // A panel behind another tab has nothing to show for a turn.
    if (inner && box.offsetParent !== null) parts.push({ clip: box, moves: inner });
  }
  return parts;
}

/**
 * Put the board flat again: no clip, no transform, nothing half way across.
 *
 * Called at the top of every full render, which replaces the very markup a
 * drag or an arriving week is moving. Without it a card could be left sitting
 * off its own edge at opacity nothing, or a clip could stay on for good.
 */
function settleTurn() {
  for (const { clip, moves } of SLIDING) {
    const box = document.querySelector(clip);
    box?.classList.remove("is-dragging");
    const inner = box?.querySelector(moves);
    inner?.classList.remove("is-slide-in", "is-drag-settling");
    inner?.style.removeProperty("--slide");
    inner?.style.removeProperty("transform");
    inner?.style.removeProperty("opacity");
  }
}

/**
 * Look at a week, from a tap on the field, a row of the drive or a drag across
 * the board.
 *
 * Only the parts that follow the week are touched: the field slides its own
 * bracket (pitch.js) rather than being rebuilt under a finger that is still on
 * it, the drive moves the bracket on its rows, and the board itself is not
 * rebuilt - so a scrub costs a millisecond or two a step and never asks for a
 * new plan.
 *
 * This is the one place the bracket moves from, whichever layer the week came
 * from. The field used to move it as well, on its own taps, which meant one tap
 * started the same smooth scroll twice and read the layout twice for it.
 */
function lookAt(week) {
  if (week === app.viewWeek) return;
  const before = lastBoard ? previewHolds(lastBoard, boardInputs().inHand) : "";
  app.viewWeek = week;
  app.activeSlot = 0;
  // The field first: it is the thing under the thumb that just asked.
  markViewing(el.pitch, week);
  if (lastBoard) renderSelection(lastBoard);
  // "If locked" prices the lock the slot in hand would make, and the week just
  // turned to may hold one of the picks pending. Rebuilt for that once the
  // bracket has finished sliding, and only when the move changes what is held.
  followTheBracket(before, { settle: true });
}

/**
 * The home page, and the two screens' visibility with it.
 *
 * The board keeps its markup while the home page is up - a league that was
 * open is the one a Back lands on, and rebuilding its deck would throw away
 * the week it was scrolled to.
 */
function renderHomeView() {
  el.board.hidden = true;
  el.home.hidden = false;
  // Whatever a page change left on either of them, off. This is the one place
  // that puts the home page up and the board away, so a fade that was
  // interrupted - or one that has just finished - cannot leave the board
  // flagged as leaving and invisible the next time it is opened.
  settlePages();
  // The league bar is a board's: on the home page there is no league for it to
  // name, so it is hidden whole - the way back, the picker and the gear.
  if (el.leagueBar) el.leagueBar.hidden = true;
  document.title = APP_NAME;

  renderSettings(el.settings, null, { canWrite: false, onSave: () => {} });
  renderNotices(el.notices, { store: app.store, board: null, message: app.message });

  renderHome(
    el.home,
    {
      name: app.name,
      leagues: app.leagues,
      shared: sharingAvailable(),
      loading: app.leaguesLoading,
      message: app.homeMessage ?? "",
    },
    {
      onOpen: (code, kind) => {
        app.homeMessage = "";
        // The row that was tapped is a league this list has just refreshed.
        openBoard(code, kind, {
          league: app.leagues.find((league) => league.code === code) ?? null,
        });
      },
      // Neither of these catches: a failure throws back to the form, which
      // shows the reason under its own field. The message at the top of the
      // page is for what goes wrong away from the forms - an invite link that
      // did not open, a board that would not load.
      onCreate: async ({ name, kinds }) => {
        app.homeMessage = "";
        const league = await createLeague({ name, kinds });
        await reloadLeagues();
        openBoard(league.code, null, { league });
      },
      onJoin: async (code) => {
        app.homeMessage = "";
        const league = await joinLeague(code);
        await reloadLeagues();
        openBoard(league.code, null, { league });
      },
      onLeave: async (code) => {
        await leaveLeague(code);
        if (app.league?.code === code) app.league = null;
        await reloadLeagues();
        renderHomeView();
      },
      onRenameMe: (name) => {
        setMyName(name);
        app.name = name;
        renderHomeView();
      },
    },
    el.homeSheets,
  );
}

/**
 * The home page's list, from this device first and the shared rows after.
 *
 * The season files go out on the device's own list, before the directory has
 * answered: which seasons the boards are on is known already, and the warm
 * used to wait on the refresh - the one round trip on a launch that has to go
 * to the database - before the files a board would want were asked for.
 */
async function reloadLeagues() {
  app.leagues = myLeagues();
  warmBoardData();
  app.leaguesLoading = true;
  try {
    app.leagues = await refreshMyLeagues();
  } catch {
    /* the cached list is still worth showing */
  } finally {
    app.leaguesLoading = false;
  }
  return app.leagues;
}

/**
 * Show the home page. The hash goes with it, so Back and a reload both land
 * where the person is rather than back inside a league.
 */
async function goHome() {
  if (app.switching) return;
  // The address bar answers at once, whatever the board is still doing on
  // screen: the tap has been taken, and a URL that lags looks like it has not.
  if (window.location.hash)
    window.history.pushState(null, "", window.location.pathname + window.location.search);

  // Held for the length of the fade, so a second tap cannot start a board
  // opening behind a board that is still leaving.
  app.switching = true;
  try {
    await leavePage(el.board, "out");
    app.view = "home";
    releaseBack();
    // Back from a board, the page starts folded: a form left open on the way
    // out is not what anyone came back for.
    closeHomePanels();
    renderHomeView();
    enterPage(el.home, "out");
  } finally {
    app.switching = false;
  }
}

/**
 * Open a league's board by code - and, for a league of several pools, which
 * one - from the home page, the switch or a link.
 *
 * Failures put the person back on the home page with the reason, because a
 * half-open board - a code that no longer exists, a season whose data will not
 * load - is not a place anyone can do anything from.
 *
 * @param {string} code
 * @param {string|null} [kind] Which of the league's pools.
 * @param {{league?:object|null}} [have] The league as the caller already holds
 *   it - a row of the home page's list, or what the create or join it just did
 *   returned. Passing it saves a directory round trip in front of the board;
 *   the copy is checked behind it instead (revalidateLeague). Only a code from
 *   a link with nothing behind it has to be looked up first.
 */
async function openBoard(code, kind = null, { league: have = null } = {}) {
  const clean = normaliseCode(code);
  if (app.switching) return;
  app.switching = true;
  // The board's own regions fade out only when a board is what we are leaving
  // - a link followed while one is already open. From the home page there is
  // no board on screen to fade, and adding it there showed the topline of the
  // new board for a frame over a readout still held at nothing.
  if (!el.board?.hidden) el.shell?.classList.add("is-swapping");

  // From the list, the card that was tapped says it is opening and the page
  // stays where it is while the league loads. It used to leave at once, so the
  // two could overlap - but its fade is seventy milliseconds and the load is
  // not always, and every millisecond the load ran past it was spent looking
  // at nothing. The fade comes once there is a board to put up behind it.
  const fromHome = !el.home?.hidden;
  if (fromHome) markOpening(el.home, clean);
  let left = false;

  try {
    const known = have?.code === clean ? have : null;
    const league = known ?? (await leagueByCode(clean));
    if (!league) throw new Error("That league could not be found.");
    // The season files and the pool's row - from a list that has been up for
    // a moment, both already in hand (warmBoardData, store/rows.js). Only the
    // load: nothing is painted yet, and nothing has moved.
    //
    // The screens used to change over here, before any of it: the board was
    // unhidden empty in the new league's colours and filled in whenever the
    // data arrived, which is the whole of why the step read as slow.
    await loadLeague(league, kind);
    // Then the step, as one movement: the list goes, and the board is up the
    // moment it has gone. The board is built while the list fades - the fade
    // runs on the compositor, and the build is the one piece of work left that
    // would otherwise sit between the list going and the board showing.
    const leaving = leavePage(el.home, "in");
    const board = buildLeague();
    await leaving;
    left = true;
    // Before paintLeague, because a render reads this to decide which screen
    // it is painting.
    app.view = "board";
    // From here a swipe in from the edge of the screen is the board's own
    // gesture rather than the platform's (ui/back.js).
    holdBack();
    el.home.hidden = true;
    el.board.hidden = false;
    el.board.classList.remove("is-page-leaving");
    if (el.leagueBar) el.leagueBar.hidden = false;
    // The swap and the paint in one task, so the board is never on screen
    // without a board on it. The field measures itself to scroll the open week
    // into the middle (ui/pitch.js), which is why this follows the unhide
    // rather than coming before it.
    paintLeague(board);
    window.history.replaceState(null, "", leagueHash(league.code, app.kind));
    // The whole board arrives, topline and all: coming from the home page this
    // is a page change, so the thing that rises is the page. playSwitch is for
    // the other kind of arrival - a switch between one league's pools, where
    // the topline is deliberately left solid because the picker that was just
    // tapped is in it.
    enterPage(el.board, "in");
    // The list this came from could be a rename or a pool behind. Checked now
    // the board is up, rather than being waited for before it.
    if (known) revalidateLeague(clean);
  } catch (error) {
    app.view = "home";
    releaseBack();
    app.league = null;
    app.homeMessage = `Could not open that league: ${error.message}`;
    // Drawn again with the reason, which also takes the opening mark off the
    // card. It arrives only if it had left - or was never up, a link followed
    // from a board; a page that stayed put has nowhere to arrive from.
    renderHomeView();
    if (left || !fromHome) enterPage(el.home, "out");
  } finally {
    el.shell?.classList.remove("is-swapping");
    // Whichever way it went, neither page is still leaving: the board is up, or
    // the home page is back with the reason it did not open. The direction goes
    // with it, since a page left holding the scale it was travelling at would
    // sit there wrong. Only the leaving half - the page that has just arrived
    // is still arriving, and enterPage clears up after itself.
    el.home?.classList.remove(...PAGE_LEAVE_CLASSES);
    el.board?.classList.remove(...PAGE_LEAVE_CLASSES);
    app.switching = false;
  }
}

/**
 * How long to leave the main thread alone before asking for a plan.
 *
 * Long enough for the board's entrance to be over. Where the search runs on a
 * worker this is only when the request goes out, and it could be sooner; where
 * it falls back to running here it is the whole of what keeps a few hundred
 * milliseconds of frozen main thread away from an animation that is part way
 * through - one caught by that does not quietly continue, it stalls and jumps.
 *
 * A quarter of a second, which is the length of a page arriving. Not read from
 * that, though: this is a decision about when to start work, not a duration
 * that has to match a keyframe, and the two are free to drift.
 */
const RECOMMEND_DELAY_MS = 260;

/**
 * A lock or an unlock changes what the coach has to plan around, so the search
 * runs again. Where it runs on this thread, this is how long to leave the
 * board alone first - about the length of the lock's own feedback (the ring is
 * 850 ms starting 80 ms in, see lock-pulse in motion.css). It is a floor, not
 * the rule: the search then waits on the motion itself (stillness), so a
 * keyframe still running when the timer fires is finished, not cut. Where a
 * worker runs the search this is not used at all.
 */
const REPLAN_DELAY_MS = 1000;

/**
 * Run the optimiser once the board the user asked for is on screen and
 * settled. Only reached where there is no worker to hand the search to: with
 * one, the search has already gone out with the render that painted the
 * stand-in, and lands as its own repaint.
 */
function scheduleRecommendation(delay = RECOMMEND_DELAY_MS) {
  if (app.recommendTimer) return;
  app.recommendTimer = setTimeout(async () => {
    app.recommendTimer = null;
    // Never under a keyframe: the search runs on this thread and stalls it
    // (stillness). The delay is when to start looking; the motion is what
    // says when it is safe to.
    await stillness();
    if (app.view !== "board" || app.recommendTimer) return;
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
    // Only while a board is the screen. The countdown's node outlives the
    // board being put away - the home page hides the markup rather than
    // clearing it - so without this the tick went on reading a board nobody
    // was looking at, and once its refresh slot had passed it asked for a
    // render a second, on the home page, in the middle of an open.
    if (app.view !== "board" || app.switching) return;
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

/**
 * Open one of the drawer's panels.
 *
 * The bar and the panels, and nothing else. All three panels are kept current
 * by every board render, so which one is showing is not a reason to rebuild the
 * board - and a full render here would ask for a plan on the tap that opened a
 * tab, which on a cold board meant the whole season search on it.
 */
function selectTab(id) {
  if (id === app.activeTab) return;
  app.activeTab = id;
  renderTabs(el.tabs, app.activeTab, selectTab);
}

function handleAction({ action, week, slot, team }) {
  if (!app.store.canWrite) return;
  // The controls are disabled in review; this is the same rule, held here too.
  if (lastBoard?.eliminated) return;

  const key = slotKey(week, slot);
  const current = app.entry.picks[key] ?? {};
  // What the slot holds on the board that was tapped, and the week it is in.
  const heldWeek = lastBoard?.weeks.find((entry) => entry.week === week) ?? null;
  const held = heldWeek?.picks[slot] ?? null;

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
        app.entry.picks[key] = {
          ...current,
          locked: true,
          coachTeam: held.isRecommended ? held.team : (held.coachCall?.team ?? null),
          // And the coach's board for the week as it stood, so the team list
          // keeps its ranks once the decision is taken (plan.js, rankTeams).
          coachRanked: heldWeek?.coachRanked.map((option) => option.team) ?? null,
          // The line as it stood, so the board can say which way it has moved
          // since (plan.js sinceLock).
          spread: Number.isFinite(held.spread) ? held.spread : null,
          by: ME,
          at: Date.now(),
        };
      }
      break;
    default:
      return;
  }

  app.effect = { week, slot, className: EFFECT_FOR[action] };

  // A lock or an unlock changes what the coach has to plan around, and the
  // search that answers it blocks the main thread. Paint the change
  // first and let the timer run the search once the feedback has played. An
  // action that did not move the plan comes straight out of the memo.
  // Restart rather than inherit an earlier recommendation timer. Otherwise a
  // timer created just before the tap can still run during the feedback motion.
  clearTimeout(app.recommendTimer);
  app.recommendTimer = null;
  render({ search: false, settle: REPLAN_DELAY_MS });
  scheduleSave();
}

/**
 * New rules for the pool, from the settings sheet.
 *
 * They live in the shared entry beside the picks (see core/rules.js), so this
 * is the same write a lock is and lands on the other device the same way.
 * Null puts the pool back on its plan's rules by storing none.
 *
 * A rule change moves everything the coach was planning around - the number of
 * slots, what a pick has to do, what can be forgiven - so the search is owed
 * again. Paint first and let it run once the new board is on screen, exactly
 * as a lock does.
 */
function applyRules(rules) {
  if (!app.store.canWrite) return;

  // Dropped rather than emptied: no key is what "follows the plan" looks
  // like on disk, where an empty object would read as a rule set of its own.
  const next = { ...app.entry };
  delete next.rules;
  if (rules) {
    // What a pick has to do is the pool's, fixed when the league was made, and
    // not a rule anyone stores: the sheet no longer offers it, and a value
    // carried here would only be the pool's own read back.
    const stored = { ...rules };
    delete stored.objective;
    next.rules = stored;
  }
  app.entry = next;
  // A week can lose the slot the sideline was filling. The week itself is
  // settled in render(), which knows which weeks the new rules leave.
  app.activeSlot = 0;

  clearTimeout(app.recommendTimer);
  app.recommendTimer = null;
  render({ search: false, settle: REPLAN_DELAY_MS });
  scheduleSave();
}

/**
 * A new name for the league, for everyone in it.
 *
 * The name is the league's own column rather than part of its entry, so this
 * is a directory write rather than a board one: nothing about the season
 * changes, so there is no re-plan and no save to coalesce.
 */
async function applyRename(name) {
  if (!app.store.canWrite || !app.league) return;
  try {
    const saved = await renameLeague(app.league.code, name);
    app.league = { ...app.league, name: saved };
    app.leagues = app.leagues.map((league) =>
      league.code === app.league.code ? { ...league, name: saved } : league,
    );
    document.title = titleFor(app.league, app.kind);
    app.message = "";
  } catch (error) {
    app.message = error.message;
  }
  render({ search: false });
}

/**
 * Take the open league down, for everyone in it, from the settings sheet. The
 * sheet has already asked twice. A failure stays on the board with the reason;
 * success lands on the home page, which is the only place left to be.
 */
async function deleteCurrentLeague() {
  const league = app.league;
  if (!league || !app.store?.canWrite) return;
  try {
    await deleteLeague(league.code);
  } catch (error) {
    app.message = error.message;
    render({ search: false });
    return;
  }
  app.unsubscribe?.();
  app.unsubscribe = null;
  app.league = null;
  app.kind = null;
  app.homeMessage = `${league.name} has been deleted.`;
  await reloadLeagues();
  goHome();
}

/**
 * Take one pool out of the open league, for everyone in it. The board moves to
 * the league's first remaining pool. The directory refuses to remove the last
 * one, and the sheet does not offer it.
 */
async function removeCurrentPool(kind) {
  const league = app.league;
  if (!league || !app.store?.canWrite) return;
  try {
    await removePool(league.code, kind);
    const fresh = (await leagueByCode(league.code)) ?? {
      ...league,
      kinds: league.kinds.filter((id) => id !== kind),
    };
    await reloadLeagues();
    app.message = "";
    await openLeague(fresh, null);
    window.history.replaceState(null, "", leagueHash(fresh.code, app.kind));
  } catch (error) {
    app.message = error.message;
    render({ search: false });
  }
}

/** Which board a write belongs to: a league's code and one of its pools. */
function openScope() {
  return app.league && app.kind ? `${app.league.code}/${app.kind}` : null;
}

/**
 * The write waiting to go out, and the board it belongs to.
 *
 * Held with its own store and its own copy of the entry rather than reading
 * app.store and app.entry when the timer fires. A pool switch inside the
 * quarter second a save is coalescing over used to send the new pool's entry
 * to the new pool's store and lose the change the old one was waiting to
 * write.
 */
let pendingSave = null;

/** Coalesce rapid taps on one board into one write. */
function scheduleSave() {
  const scope = openScope();
  const store = app.store;
  if (!scope || !store) return;

  // A write waiting for another board is sent rather than replaced: its entry
  // is that pool's, and this one has no business coalescing with it.
  if (pendingSave && pendingSave.scope !== scope) flushSave();

  clearTimeout(pendingSave?.timer);
  pendingSave = {
    scope,
    store,
    entry: structuredClone(app.entry),
    timer: setTimeout(sendSave, 250),
  };
}

/** Send the waiting write now. Called before a board is taken down. */
function flushSave() {
  if (!pendingSave) return;
  clearTimeout(pendingSave.timer);
  sendSave();
}

function sendSave() {
  const save = pendingSave;
  pendingSave = null;
  if (!save) return;

  save.store
    .save(save.entry)
    .then(() => {
      // Another board is open now, so this one's notices are not ours to
      // clear and its render is not ours to ask for.
      if (openScope() !== save.scope) return;
      if (!app.message.startsWith("Could not sync")) return;
      app.message = "";
      render({ search: false });
    })
    .catch((error) => {
      if (openScope() !== save.scope) return;
      app.message = `Could not sync this change: ${error.message}`;
      render({ search: false });
    });
}

/** The tab's title: the league, and which of its pools when it has several. */
function titleFor(league, kind) {
  const pool = league.kinds.length > 1 ? ` · ${POOL_KINDS[kind].label}` : "";
  return `${league.name}${pool} · ${APP_NAME}`;
}

/** Repaint for a pool: its season's palette, turned warm when its picks have to lose. */
function themeFor(kind) {
  const pool = POOL_KINDS[kind];
  applyTheme(pool?.sport ?? null, pool?.objective);
}

/**
 * Load one of a league's boards and take over the screen.
 *
 * A league is a code (its name and its members) plus one or more pools, each a
 * season played for winners or for losers, each with a shared board of its own
 * priced off the schedule, lines and ratings every league on that season
 * shares. `wanted` says which board to open; a pool the league does not run -
 * a stale link, an old cached list - falls back to its first. Opening is a
 * full reload rather than a filter over the last: old subscriptions are torn
 * down first, and nothing from the previous board survives.
 *
 * @param {{code:string, name:string, kinds:string[]}} league
 * @param {string|null} [wanted] A kind id.
 */
async function openLeague(league, wanted = null) {
  await loadLeague(league, wanted);
  paintLeague();
}

/**
 * The half of an open that waits: the season's files and the pool's row.
 *
 * Nothing here touches the screen, which is what lets a caller coming from the
 * home page hold both pages where they are until there is a board to put up.
 * The board used to be unhidden before this ran, so every one of these round
 * trips was spent looking at an empty one - the palette had changed, the
 * league bar was blank, and the field arrived a moment later. Its own colours
 * come with it now (paintLeague).
 *
 * @param {{code:string, name:string, kinds:string[]}} league
 * @param {string|null} [wanted] A kind id.
 */
async function loadLeague(league, wanted = null) {
  const kinds = normaliseKinds(league.kinds);
  if (kinds.length === 0) kinds.push(KIND_IDS[0]);
  const kind = kinds.includes(wanted) ? wanted : kinds[0];
  const { sport, objective } = POOL_KINDS[kind];
  // A change waiting on the board being left goes out before its store does.
  flushSave();
  app.unsubscribe?.();
  app.unsubscribe = null;
  clearTimeout(app.recommendTimer);
  app.recommendTimer = null;
  clearTimeout(app.previewTimer);
  app.previewTimer = null;
  app.message = "";

  // The store opens alongside the files rather than after them. One is a
  // database round trip and the others are static fetches, and they have
  // nothing to say to each other; waiting for the files first put the two
  // end to end for no reason. And the round trip is usually not owed at all:
  // the home page's refresh read this pool's row whole a moment ago, so the
  // store opens on that copy and checks it behind the board (store/rows.js).
  const opening = createStore(league.code, kind, { seed: knownRow(league.code, kind) }).then(
    async (store) => ({
      store,
      entry: await store.init(),
    }),
  );
  // A data file that will not load throws below. Without this the store's own
  // failure would be unhandled while that error is on its way out.
  opening.catch(() => {});

  // The five the board cannot open without throw; the four behind them each
  // have a default and are allowed to be missing. The refresh job's fit to
  // this season's pulls (form.json) does not exist until the first run that
  // has something to fit, so a league whose season has not started prices the
  // weeks ahead off ratings.json instead; then the league's calibrated model
  // (defaults otherwise), player availability (nothing reported otherwise)
  // and the pool's numbers (survival mode otherwise).
  const [plan, teams, odds, schedule, ratings, form, calibration, availability, pool] =
    await Promise.all(
      BOARD_FILES.map((name, index) => {
        const request = loadJson(name, sport);
        return index < BOARD_FILES_REQUIRED ? request : request.catch(() => null);
      }),
    );

  // The board's defaults are the season's plan played the way this pool was
  // made to be played: the objective is the pool's, fixed with the league, and
  // reaches the model here rather than as a rule anyone can change.
  plan.rules = { ...plan.rules, objective };

  app.league = { ...league, kinds };
  app.kind = kind;
  app.plan = plan;
  app.teams = teams;
  app.odds = odds;
  app.schedule = schedule;
  app.ratings = ratings;
  app.form = form;
  app.calibration = calibration;
  app.availability = availability;
  app.pool = pool;
  app.viewWeek = Math.min(Math.max(odds.currentWeek ?? 1, 1), plan.weeks.length);
  app.activeSlot = 0;

  document.title = titleFor(app.league, kind);

  const { store, entry } = await opening;
  app.store = store;
  app.entry = entry;
  app.unsubscribe = app.store.subscribe((entry) => {
    // A late push from the store we just replaced - another league, or this
    // league's other pool - must not land on this board.
    if (app.league?.code !== league.code || app.kind !== kind) return;
    // The store confirming our own save, or a poll that found nothing new, is
    // not a change. Rendering it would rebuild the deck under the feedback
    // still playing for the tap that caused it, and play it a second time.
    if (sameEntry(entry, app.entry)) return;
    app.entry = entry;
    // Held, not painted, when the board is not the screen: between this
    // subscription and the first paint of the league it belongs to, and for
    // as long as the person is back on the home page with the league still
    // open behind it. The next build reads it either way.
    if (app.view !== "board") return;
    // Paint another user's change immediately, then let the season optimiser
    // catch up after the interaction has settled. Running it inline here made
    // a realtime update feel just as heavy as the original lock/unlock tap.
    clearTimeout(app.recommendTimer);
    app.recommendTimer = null;
    render({ search: false, settle: REPLAN_DELAY_MS });
  });
}

/**
 * And the half that does not wait: the pool's colours and the first paint of
 * its board, in one task, so nothing of the new league is ever on screen
 * without the rest of it.
 *
 * Built once and painted. An eliminated entry opens on the week it ended
 * rather than the week the league is in: the board is a review now, and that
 * is the page to review. The week it opens on has to be known before the
 * render, and the render used to build the whole board a second time to find
 * out.
 *
 * The season search goes out with this build where there is a worker to run
 * it on (core/search.js): off the main thread it costs the entrance nothing,
 * and the board that used to be rebuilt a quarter of a second later purely to
 * ask for it now asks on the way up. Without a worker the search would freeze
 * the arrival, so it is deferred as before and this build stands in.
 */
function paintLeague(board = buildLeague()) {
  themeFor(app.kind);
  render({ board });
}

/**
 * The first build of a loaded league, ahead of its paint. Pure work, no screen:
 * a caller with a page still fading can spend the fade on it (openBoard), so
 * the paint that follows the fade has nothing left to compute.
 */
function buildLeague() {
  app.arriving = true;
  const board = buildBoard({ ...boardInputs(), allowSearch: Boolean(searchRunner()) });
  if (board.eliminated && board.eliminatedWeek) app.viewWeek = board.eliminatedWeek;
  return board;
}

/**
 * Check the directory's copy of the open league behind the board.
 *
 * A rename or a pool removed on somebody else's phone should be picked up, but
 * not in front of the board: opening a league this device is already in used to
 * wait on a query for a row it was holding, and so did every switch between one
 * league's pools. So the board goes up on what is known and this corrects it if
 * there is anything to correct.
 *
 * A pool that has gone is left alone here. The board showing it is stale, but a
 * league bar whose pools do not include the one on screen is broken, and the
 * next open sorts it out either way.
 */
function revalidateLeague(code) {
  leagueByCode(code)
    .then((fresh) => {
      if (!fresh || app.league?.code !== code) return;
      const kinds = normaliseKinds(fresh.kinds);
      const known = kinds.includes(app.kind) ? kinds : app.league.kinds;
      if (fresh.name === app.league.name && String(known) === String(app.league.kinds)) return;
      app.league = { ...app.league, name: fresh.name, kinds: known };
      document.title = titleFor(app.league, app.kind);
      render({ search: false });
    })
    .catch(() => {
      /* the copy in hand is the board that is open */
    });
}

/** What the league bar can ask for: another of the league's pools, or home. */
const BAR_HANDLERS = { onPool: (kind) => switchPool(kind), onHome: () => goHome() };

/**
 * Handler for the league bar's picker: another of the open league's boards.
 *
 * Rebuilding a board is not instant: the recommendation is a beam search over
 * the whole remaining season, and it runs synchronously. So the tap is answered
 * before the work starts, not after it. The picker and the palette move on the
 * frame you touch them, the board fades out, and the new one fades in when it
 * is ready. Without the two frames of waiting, the fade-out would be computed
 * and then never painted, because the search blocks the main thread before the
 * browser gets a chance.
 */
async function switchPool(kind) {
  if (app.switching || !app.league || kind === app.kind) return;

  app.switching = true;
  renderLeagueBar(el.league, { league: app.league, kind }, BAR_HANDLERS);
  el.shell?.classList.add("is-swapping");
  await twoFrames();
  // The colour tokens switch with the new board's first paint (paintLeague).
  // Let the old board finish its 160ms exit first so borders and badges cannot
  // flash the incoming palette while they are still visible.
  await new Promise((resolve) => setTimeout(resolve, 150));

  try {
    // The league as this device holds it, opened at once: it is the same
    // league, and the pool being asked for is one of its own. A rename or a
    // pool removed elsewhere is picked up behind the board rather than in
    // front of it, so the switch is not waiting on the directory.
    const league = app.league;
    await openLeague(league, kind);
    window.history.replaceState(null, "", leagueHash(league.code, app.kind));
    revalidateLeague(league.code);
  } catch (error) {
    // Put the board back the way it was, including its colours.
    renderLeagueBar(el.league, { league: app.league, kind: app.kind }, BAR_HANDLERS);
    themeFor(app.kind);
    app.message = `Could not open that pool: ${error.message}`;
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
 * The door: the app's access code, once per device.
 *
 * Ahead of the name and of everything else, so a league link sent to someone
 * without the code opens nothing - not the join, not the home page. The check
 * is the digest in config.js against the code typed (core/passcode.js), and a
 * device that has passed keeps the digest, so it is asked once and asked again
 * only when the code is changed. With no digest configured there is no door.
 *
 * This is the app's code. A league's code is a separate credential and gets a
 * person into one league (store/directory.js); the two never meet.
 */
async function requireAccess() {
  const { digest, salt, iterations } = CONFIG.passcode;
  if (!digest || accessGranted(digest)) return;

  document.body.classList.add("is-gated");
  await requirePasscode(el.start, {
    check: async (typed) => (await derivePasscodeDigest(typed, salt, iterations)) === digest,
  });
  grantAccess(digest);
  document.body.classList.remove("is-gated");
}

/**
 * The name, once per device.
 *
 * This is the whole of the identity the app has: it goes on the picks and
 * locks so a league with several people in it can say whose they are, and it
 * is stored on the phone that typed it. A device that has given one is let
 * straight through.
 *
 * It is asked for before anything loads because the first thing after it may
 * be joining a league from a link, and a member with no name is a row in a
 * list that says nothing.
 */
async function requireIdentity() {
  const saved = myName();
  if (saved) {
    app.name = saved;
    return;
  }

  document.body.classList.add("is-gated");
  const name = await requireName(el.start);
  setMyName(name);
  app.name = name;
  document.body.classList.remove("is-gated");
}

/**
 * What the startup screen says while the board loads: one of these, drawn at
 * random each launch, so the wait reads as the pre-game rather than a spinner.
 * The page ships the first one as its default for the moment before this runs.
 */
const STARTUP_LINES = Object.freeze([
  "Chalking up the field…",
  "Painting the end zones…",
  "Setting the chains…",
  "Warming up the kicker…",
  "Taping the ankles…",
  "Walking out for the coin toss…",
  "Checking the wind at midfield…",
  "Drawing up the game plan…",
  "Reading the coverage…",
  "Inflating the footballs…",
]);

function callTheStartupLine() {
  if (!el.startupStatus) return;
  el.startupStatus.textContent = STARTUP_LINES[Math.floor(Math.random() * STARTUP_LINES.length)];
}

/**
 * Where in the play the layer is handed over, as a fraction of one cycle.
 *
 * The keyframes are in motion.css: the ball is gathered in at 68%, holds
 * there, and everything begins to fade at 84%. The beat to leave on is the
 * one just past the catch, not the one before the fade - the fade the play
 * was about to do is done by the layer instead, and waiting for it left the
 * screen frozen for a fifth of a second between the ball stopping and the
 * board arriving. Measured over CDP at the old 84%: the last frame the
 * compositor drew was the catch, then nothing at all until the handoff. Six
 * points past the catch is an eighth of a second - long enough for the eye to
 * see the ball land, short enough that the layer lifting reads as the end of
 * the same movement rather than as a cut.
 */
const PLAY_LANDED = 0.74;

/** How long the handoff takes: the layer fading out over the board rising in. */
const HANDOFF_MS = 700;

/** Every animation the startup play is made of, the route's own included. */
function startupPlays() {
  if (!el.startup || !document.getAnimations) return [];
  return document
    .getAnimations()
    .filter((play) => el.startup.contains(play.effect?.target ?? null));
}

/** How long one cycle of the play lasts, as the animation itself reports it. */
function playCycle(play) {
  return Number(play?.effect?.getComputedTiming?.().duration) || 0;
}

/**
 * The first paint, or as near as the browser will admit to one.
 *
 * Chrome and Firefox report it, so the entry itself is what is waited on.
 * Safari does not, and there two animation frames is the soonest the page can
 * have drawn. Either way the wait is bounded: a launch straight into a
 * background tab may never paint at all, and that must not leave the board
 * behind a startup screen nobody is looking at.
 */
function firstPaint(ceiling) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ceiling);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    if (PerformanceObserver.supportedEntryTypes?.includes("paint")) {
      const observer = new PerformanceObserver(() => {
        observer.disconnect();
        done();
      });
      observer.observe({ type: "paint", buffered: true });
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(done));
  });
}

/**
 * Hold the pre-game play at its first frame until the page is on screen, and
 * hand back the play itself, which is the clock everything after this is timed
 * against.
 *
 * The play is a CSS animation, so its clock starts the moment the stylesheets
 * apply - and that is well before anything is painted. The fonts arrive from
 * Google, and a stylesheet still on the way blocks both the first paint and
 * this module; an installed app opens behind the system's own splash screen on
 * top of that. Measured on a warm launch, the throw was three hundred
 * milliseconds in before the screen showed anything, and a slow one can spend
 * the whole cycle behind a blank screen: what the launch then hands over is
 * the tail of a play nobody saw, which is why it read as snapping to the end
 * of the animation and putting the board up immediately after.
 *
 * So the play is held at nought - where the ball has not been thrown yet -
 * and released on the first paint. The stylesheet holds it there from the
 * start (animation-play-state in motion.css), so nothing has been drawn when
 * it is wound back here and there is nothing to see in the winding. It is
 * wound back whatever the clock says: this used to stand aside once a paint
 * had been reported, on the theory that a play already on screen should not
 * be restarted - but on a warm installed launch the shell paints and the play
 * runs on behind the system's own splash, and what that reasoning handed the
 * beat below was a clock past the catch and a layer that lifted at once.
 *
 * Under reduced motion there is no animation to hold (base.css) and this finds
 * none: the null it hands back is what turns the floor below off.
 */
async function startTheStartupPlay() {
  const plays = startupPlays();
  const play = plays.find((entry) => entry.animationName === "startup-throw") ?? plays[0] ?? null;
  if (!play) return null;
  for (const entry of plays) {
    entry.pause();
    entry.currentTime = 0;
  }
  const cycle = playCycle(play);
  await firstPaint(cycle || HANDOFF_MS);
  // Released both ways: the class is for the stylesheet's hold, play() for the
  // animations themselves, so the play starts here whether or not the browser
  // keeps honouring animation-play-state once a script has touched an animation.
  el.startup?.classList.add("is-playing");
  for (const entry of plays) entry.play();
  return play;
}

/**
 * Keep the startup layer up until the first throw of the play has landed.
 *
 * The floor is read off the play's own clock rather than kept on a stopwatch
 * beside it, so the handoff falls on the beat however long the loading took.
 * The first throw is the only one worth holding the layer for: past that beat
 * the play has already been watched - a slow launch, or a first run that
 * stopped to ask for a name - and waiting on the next throw would be a wait of
 * its own, so the board goes straight up.
 */
function playToTheBeat(play) {
  const cycle = playCycle(play);
  if (!cycle) return Promise.resolve();
  const beat = cycle * PLAY_LANDED;
  // The clock counts every cycle the play has run, not the one it is in.
  const elapsed = Number(play.currentTime ?? 0);
  if (elapsed >= beat) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, beat - elapsed));
}

/** Hand the fully rendered board over from the startup layer. */
async function finishStartup() {
  if (!el.startup) return;
  if (el.startupStatus) el.startupStatus.textContent = "Board ready";
  // The play is stopped where it stands rather than left running under the
  // fade. On the beat it is stopped on the ball is already still, at the far
  // end; anywhere else - a launch slow enough to have looped - a cycle that
  // wrapped round mid-fade threw the ball back to the near end and re-drew the
  // route across a layer on its way out, which is a snap of its own.
  for (const play of startupPlays()) play.pause();
  el.startup.classList.add("is-ready");
  // Reveal the board beneath the fading layer, making this one handoff rather
  // than a blank beat followed by a second entrance.
  document.body.classList.remove("is-starting");

  const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : HANDOFF_MS;
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

/**
 * What the address bar is asking for.
 *
 * #/join/CODE is the link that gets sent around: it joins first, so the person
 * who opened it is in the members before the board draws. #/l/CODE/KIND is
 * what an open board leaves behind, so a reload comes back to it; without the
 * pool it opens the league's first.
 */
async function openFromHash() {
  const asked = codeFromHash(window.location.hash);
  if (!asked) return false;

  if (asked.action === "join") {
    try {
      const league = await joinLeague(asked.code);
      await reloadLeagues();
      await openBoard(league.code, null, { league });
      return true;
    } catch (error) {
      app.homeMessage = `That invite did not open: ${error.message}`;
      return false;
    }
  }

  const known = app.leagues.find((league) => league.code === asked.code) ?? null;
  if (!known && !sharingAvailable()) return false;
  await openBoard(asked.code, asked.kind, { league: known });
  return app.view === "board";
}

async function main() {
  callTheStartupLine();
  // Started here, at the top, and awaited at the bottom: the play is held at
  // its first frame until the page is on screen, and it is what says when the
  // layer has been up long enough. Not awaited here - the loading below has no
  // reason to wait on the first paint.
  const play = startTheStartupPlay();
  // Every visit begins in the first sport's palette, which is what the start
  // screen and the home page wear before any league is open.
  applyTheme(null);
  // Where the season search runs. On a worker, where there is one, so a
  // re-plan no longer freezes the board that is being re-planned.
  useWorkerForSearch();
  // A search handed off lands after the board that asked for it was painted.
  // This is what paints it in - the plan, or the rehearsal of a lock behind
  // the "if locked" number (memoisedPreview in core/plan.js) - once the board
  // is still, so a landing never cuts the tap's own feedback short.
  onSearchSettled(repaintAfterMotion);
  // Whatever this device kept under the app's old name comes across before
  // anything reads storage, so a rename is not a logout.
  adoptOldStorage();
  // The door first, then the name: a device with neither sees two cards in a
  // row, and a link followed without the code goes no further than the door.
  await requireAccess();
  await requireIdentity();

  await reloadLeagues();
  const opened = await openFromHash();

  // The first render defers the season search so the board can paint; behind
  // the startup layer there is nothing to protect, so it is asked for and
  // waited on there instead.
  if (opened) await settleBeforeReveal();

  if (!opened) {
    // No link, or a link that did not open: the home page, and a board is one
    // tap from it. A single league is not opened automatically - a person with
    // one league still wants to see its code and share it.
    app.view = "home";
    renderHomeView();
  }

  await playToTheBeat(await play);
  await finishStartup();
  startClock();
  registerServiceWorker();

  // Drag the board sideways to turn the week. The surfaces are the three
  // regions a week is about - its card, the team list and the drive - each
  // bound once rather than to anything a render replaces. The field is not one
  // of them: it pans its own yard lines. Nor is the depth chart, which says the
  // same thing whatever week is open. What is left to skip is what a sideways
  // drag already means something in.
  watchDrags(
    { parts: slidingParts, canTurn, turn: turnWeek },
    {
      surfaces: [el.call, el.weekPanel, el.pathPanel],
      ignore: ["input", "textarea", "select", "dialog", ".league-bar__menu"],
    },
  );

  // Back and forward, and a link tapped while the app is already open.
  window.addEventListener("hashchange", () => {
    const asked = codeFromHash(window.location.hash);
    if (!asked) {
      if (app.view !== "home") goHome();
      return;
    }
    const showing = asked.code === app.league?.code && (!asked.kind || asked.kind === app.kind);
    if (!showing) openFromHash();
  });
}

/**
 * Ask for the season search the first render put off, and hold the startup
 * layer over the board until it lands.
 *
 * The first render defers the search so a board can paint before waiting on
 * it. At startup that deferral worked against us: the timer fired a few
 * hundred milliseconds after the board was built, which was often partway
 * through the crossfade from the startup layer - and where the search runs on
 * the main thread, the fade stalled and jumped for it. Behind the startup layer
 * neither costs anything to look at, since its own play runs on the
 * compositor, so this is where the search goes.
 */
async function settleBeforeReveal() {
  if (app.recommendTimer) {
    clearTimeout(app.recommendTimer);
    app.recommendTimer = null;
    render();
  }
  // Handed to a worker, the plan arrives after the build that asked for it
  // rather than in it.
  await searchesSettled();
  if (lastBoard?.recommendationPending) render({ search: false });
}

main().catch((error) => {
  document.body.classList.remove("is-gated");
  document.body.classList.remove("is-starting");
  if (el.startup) el.startup.hidden = true;
  if (el.start) el.start.hidden = true;
  // textContent, not innerHTML: this message carries whatever a failure had to
  // say for itself - a server's response, a parse error quoting the input back
  // - and the rest of the app has one rule about that (core/format.js).
  const notice = document.createElement("div");
  notice.className = "notice notice--warn";
  notice.textContent = `Could not load the board: ${error.message}`;
  el.notices.replaceChildren(notice);
  console.error(error);
});
