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

import { CONFIG } from "./config.js";
import { POOL_KINDS, KIND_IDS, resolveSport, normaliseKinds } from "./sports.js";
import { buildBoard, slotKey, sameEntry } from "./core/plan.js";
import { createStore } from "./store/index.js";
import {
  createLeague,
  joinLeague,
  leaveLeague,
  leagueByCode,
  myLeagues,
  myName,
  myId,
  refreshMyLeagues,
  renameLeague,
  setMyName,
  sharingAvailable,
} from "./store/directory.js";
import { codeFromHash, leagueHash, normaliseCode } from "./core/code.js";
import { renderLeagueSwitch } from "./ui/league-switch.js";
import { renderSettings } from "./ui/settings.js";
import { renderHome } from "./ui/home.js";
import { renderStrip } from "./ui/strip.js";
import { renderWeekDeck } from "./ui/week-panel.js";
import { renderLadder } from "./ui/ladder.js";
import { renderBurnBoard } from "./ui/burn-board.js";
import { renderNotices } from "./ui/notices.js";
import { renderTabs, initialTab } from "./ui/tabs.js";
import { requireName } from "./ui/name.js";
import { formatDuration } from "./core/refresh.js";

const el = {
  start: document.getElementById("start"),
  home: document.getElementById("home"),
  board: document.getElementById("board"),
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
  settings: document.getElementById("settings"),
  /** The picker and the gear together: a board's controls, hidden on the home page. */
  tools: document.querySelector(".masthead__tools"),
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
  /** The pool's size and pick popularity, kept by hand. Null is survival mode. */
  pool: null,
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
const EFFECT_FOR = { lock: "fx-lock", pick: "fx-swap" };

/**
 * Feedback has to be applied AFTER the render that produced the new markup -
 * innerHTML replaces the node, so anything set beforehand is thrown away.
 *
 * @returns {{className:string, nodes:HTMLElement[]}|null} What was decorated,
 *   so the render can keep other motion off the same nodes.
 */
function playEffect() {
  const effect = app.effect;
  app.effect = null;
  if (!effect) return null;

  const slide = el.deck.querySelectorAll(".week-slide")[effect.week - 1];
  if (!slide) return null;

  const slots =
    effect.slot === null
      ? [...slide.querySelectorAll(".slot")]
      : [slide.querySelectorAll(".slot")[effect.slot]].filter(Boolean);

  for (const slot of slots) {
    slot.classList.add(effect.className);
    afterAnimations(slot, () => slot.classList.remove(effect.className));
  }
  return { className: effect.className, nodes: slots };
}

/**
 * Run `done` once every animation under `node` has finished.
 *
 * An effect's keyframes sit on the slot's children and its ::after, staggered,
 * so they end at different times. Listening for animationend on the slot heard
 * the FIRST of them bubble up and dropped the class while the rest were still
 * running: a ring or a wash was cut short, and on a pick the numbers and
 * actions fell through to the settle keyframe mid-flight and played again from
 * the start. An animation cancelled by a re-render counts as finished, and
 * with motion reduced there is nothing to wait for.
 */
function afterAnimations(node, done) {
  const animations = node.getAnimations?.({ subtree: true }) ?? [];
  Promise.allSettled(animations.map((animation) => animation.finished)).then(done);
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
  const shell = el.shell;
  if (!shell) return;
  shell.classList.remove("is-switching");
  // Forces the browser to drop the finished animation before it is re-added,
  // so a second switch plays rather than doing nothing.
  void shell.offsetWidth;
  shell.classList.add("is-switching");
  setTimeout(() => shell.classList.remove("is-switching"), 500);
}

/**
 * Local identity, saved as `by` on every lock and result: the device's id and
 * the name this person gave on first run. The board does not show it, but a
 * league with several people in it records who did what and when.
 */
const ME = myId();

/**
 * Read a data file. The artifact build has no sibling files to fetch, so the
 * bundler inlines the three JSON blobs on `globalThis.SURVIVOR_DATA` and this
 * short-circuits. On Pages it fetches normally.
 */
async function loadJson(name, sport = POOL_KINDS[app.kind]?.sport) {
  // Per sport, not per league: every league on the NFL schedule is priced off
  // the one data/nfl pull, however many of them there are.
  const folder = resolveSport(sport);
  const preloaded = globalThis.SURVIVOR_DATA?.[folder]?.[name];
  if (preloaded) return structuredClone(preloaded);

  const response = await fetch(`${CONFIG.dataPath}/${folder}/${name}?v=${Date.now()}`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Could not load ${folder}/${name} (${response.status})`);
  return response.json();
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
  };
}

/** Capture stable UI nodes before a render so changed replacements can settle in. */
function captureMotionState() {
  const state = new Map();
  for (const node of el.shell?.querySelectorAll("[data-motion-key]") ?? []) {
    state.set(node.dataset.motionKey, motionSignature(node));
  }
  return state;
}

/**
 * What counts as the node's state for the settle: its classes and its content,
 * minus two things. Motion classes (the settle itself and the fx- action
 * keyframes) are feedback, not state; a render landing while one is still
 * playing must not read it as a change and settle the node again. And a child
 * marked data-motion-ignore is left out, because the settle does not animate
 * it: a slot's team list is rewritten whenever the sibling slot picks, and the
 * slot's head should not move for that.
 */
function motionSignature(node) {
  const classes = [...node.classList]
    .filter((name) => name !== "is-data-updated" && !name.startsWith("fx-"))
    .join(" ");
  const content = node.querySelector(":scope > [data-motion-ignore]")
    ? [...node.children]
        .filter((child) => !child.hasAttribute("data-motion-ignore"))
        .map((child) => child.outerHTML)
        .join("")
    : node.innerHTML;
  return `${classes}|${content}`;
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
  // Nothing to settle while the startup layer still covers the board: the
  // search filling in behind it is the board arriving, not the board changing.
  if (previous.size === 0 || app.switching || document.body.classList.contains("is-starting"))
    return;

  const skip = new Set(effect?.nodes ?? []);
  const changed = [];
  for (const node of el.shell?.querySelectorAll("[data-motion-key]") ?? []) {
    if (skip.has(node)) continue;
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
  if (app.view === "home") {
    renderHomeView();
    return;
  }

  const previousMotion = captureMotionState();
  const board = buildBoard({ ...boardInputs(), allowSearch: search });

  lastBoard = board;
  renderLeagueSwitch(
    el.league,
    { league: app.league, kind: app.kind, leagues: app.leagues },
    openFromSwitch,
  );
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
  });
  renderNotices(el.notices, { store: app.store, board, message: app.message });
  renderStrip(el.strip, board);
  renderTabs(el.tabs, app.activeTab, selectTab);
  renderWeekDeck(el.deck, board, app.viewWeek, {
    // Once the run is over the board is a review, and a review is read-only:
    // nothing more can be picked or locked, whatever the store allows.
    canWrite: app.store.canWrite && !board.eliminated,
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
  // The action's own feedback first, so the settle knows which slot to leave
  // to it.
  const effect = playEffect();
  playDataUpdates(previousMotion, effect);

  if (board.recommendationPending) scheduleRecommendation(settle);
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
  // The picker and the gear are a board's controls. On the home page the
  // picker would offer only "Home" and the gear would open a sheet about
  // nothing, so neither is shown.
  if (el.tools) el.tools.hidden = true;
  document.title = "Survivor Board";

  renderLeagueSwitch(el.league, { league: null, leagues: app.leagues }, openFromSwitch);
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
        openBoard(code, kind);
      },
      // Neither of these catches: a failure throws back to the form, which
      // shows the reason under its own field. The message at the top of the
      // page is for what goes wrong away from the forms - an invite link that
      // did not open, a board that would not load.
      onCreate: async ({ name, kinds }) => {
        app.homeMessage = "";
        const league = await createLeague({ name, kinds });
        await reloadLeagues();
        openBoard(league.code);
      },
      onJoin: async (code) => {
        app.homeMessage = "";
        const league = await joinLeague(code);
        await reloadLeagues();
        openBoard(league.code);
      },
      onLeave: async (code) => {
        await leaveLeague(code);
        if (app.league?.code === code) app.league = null;
        await reloadLeagues();
        renderHomeView();
      },
      onRenameMe: async () => {
        document.body.classList.add("is-gated");
        const name = await requireName(el.start, {
          name: app.name,
          heading: "Who's picking?",
          action: "Save",
        });
        document.body.classList.remove("is-gated");
        setMyName(name);
        app.name = name;
        renderHomeView();
      },
    },
  );
}

/** The home page's list, from this device first and the shared rows after. */
async function reloadLeagues() {
  app.leagues = myLeagues();
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
function goHome() {
  app.view = "home";
  if (window.location.hash)
    window.history.pushState(null, "", window.location.pathname + window.location.search);
  renderHomeView();
}

/**
 * Open a league's board by code - and, for a league of several pools, which
 * one - from the home page, the switch or a link.
 *
 * Failures put the person back on the home page with the reason, because a
 * half-open board - a code that no longer exists, a season whose data will not
 * load - is not a place anyone can do anything from.
 */
async function openBoard(code, kind = null) {
  const clean = normaliseCode(code);
  if (app.switching) return;
  app.switching = true;
  el.shell?.classList.add("is-swapping");

  try {
    const league = await leagueByCode(clean);
    if (!league) throw new Error("That league could not be found.");
    // Before openLeague, because it ends in the first render of the new board
    // and a render reads this to decide which screen it is painting.
    app.view = "board";
    el.home.hidden = true;
    el.board.hidden = false;
    if (el.tools) el.tools.hidden = false;
    await openLeague(league, kind);
    window.history.replaceState(null, "", leagueHash(league.code, app.kind));
    playSwitch();
  } catch (error) {
    app.view = "home";
    app.league = null;
    app.homeMessage = `Could not open that league: ${error.message}`;
    renderHomeView();
  } finally {
    el.shell?.classList.remove("is-swapping");
    app.switching = false;
  }
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
 * A lock or an unlock changes what the coach has to plan around, so the search
 * runs again. This is how long its feedback keyframes need to finish first: the
 * lock ring is the longest of them, 850 ms starting 80 ms in (see lock-pulse
 * in motion.css). The render that follows the search rebuilds the slot, and a
 * keyframe still running then is simply gone.
 */
const REPLAN_DELAY_MS = 1000;

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
  // The controls are disabled in review; this is the same rule, held here too.
  if (lastBoard?.eliminated) return;

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
        app.entry.picks[key] = {
          ...current,
          locked: true,
          coachTeam: held.isRecommended ? held.team : (held.coachCall?.team ?? null),
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
  // A week can lose the slot it was being viewed through, and an empty deck
  // page is not a place to be left standing.
  app.viewWeek = Math.min(app.viewWeek, app.plan.weeks.length);

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

/** Coalesce rapid taps into one write. */
function scheduleSave() {
  clearTimeout(app.saveTimer);
  app.saveTimer = setTimeout(() => {
    app.store
      .save(structuredClone(app.entry))
      .then(() => {
        if (!app.message.startsWith("Could not sync")) return;
        app.message = "";
        render({ search: false });
      })
      .catch((error) => {
        app.message = `Could not sync this change: ${error.message}`;
        render({ search: false });
      });
  }, 250);
}

/** The tab's title: the league, and which of its pools when it has several. */
function titleFor(league, kind) {
  const pool = league.kinds.length > 1 ? ` · ${POOL_KINDS[kind].label}` : "";
  return `${league.name}${pool} · Survivor Board`;
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
  const kinds = normaliseKinds(league.kinds);
  if (kinds.length === 0) kinds.push(KIND_IDS[0]);
  const kind = kinds.includes(wanted) ? wanted : kinds[0];
  const { sport, objective } = POOL_KINDS[kind];
  app.unsubscribe?.();
  app.unsubscribe = null;
  clearTimeout(app.recommendTimer);
  app.recommendTimer = null;
  app.message = "";

  const [plan, teams, odds, schedule, ratings, form, calibration, availability, pool] =
    await Promise.all([
      loadJson("plan.json", sport),
      loadJson("teams.json", sport),
      loadJson("odds.json", sport),
      loadJson("schedule.json", sport),
      loadJson("ratings.json", sport),
      // The refresh job's fit to this season's pulls, and one of the data files
      // the board can open without. It does not exist until the first run that
      // has something to fit, so a league whose season has not started is not
      // an error: the board prices the weeks ahead off ratings.json instead.
      loadJson("form.json", sport).catch(() => null),
      // Three more the board can open without: the league's calibrated model
      // (defaults otherwise), player availability (nothing reported otherwise)
      // and the pool's numbers (survival mode otherwise).
      loadJson("calibration.json", sport).catch(() => null),
      loadJson("availability.json", sport).catch(() => null),
      loadJson("pool.json", sport).catch(() => null),
    ]);

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

  document.title = titleFor(app.league, kind);

  app.store = await createStore(league.code, kind);
  app.entry = await app.store.init();
  themeFor(kind);
  app.unsubscribe = app.store.subscribe((entry) => {
    // A late push from the store we just replaced - another league, or this
    // league's other pool - must not land on this board.
    if (app.league?.code !== league.code || app.kind !== kind) return;
    // The store confirming our own save, or a poll that found nothing new, is
    // not a change. Rendering it would rebuild the deck under the feedback
    // still playing for the tap that caused it, and play it a second time.
    if (sameEntry(entry, app.entry)) return;
    app.entry = entry;
    // Paint another user's change immediately, then let the season optimiser
    // catch up after the interaction has settled. Running it inline here made
    // a realtime update feel just as heavy as the original lock/unlock tap.
    clearTimeout(app.recommendTimer);
    app.recommendTimer = null;
    render({ search: false, settle: REPLAN_DELAY_MS });
  });

  // An eliminated entry opens on the week it ended rather than the week the
  // league is in: the board is a review now, and that is the page to review.
  const opening = buildBoard({ ...boardInputs(), allowSearch: false });
  if (opening.eliminated && opening.eliminatedWeek) app.viewWeek = opening.eliminatedWeek;
  render({ search: false });
}

/**
 * Handler for the masthead switch: another board - a league and one of its
 * pools, as "CODE/KIND" - or the home page.
 *
 * Rebuilding a board is not instant: the recommendation is a beam search over
 * the whole remaining season, and it runs synchronously. So the tap is answered
 * before the work starts, not after it. The switch and the palette move on the
 * frame you touch them, the board fades out, and the new one fades in when it
 * is ready. Without the two frames of waiting, the fade-out would be computed
 * and then never painted, because the search blocks the main thread before the
 * browser gets a chance.
 */
async function openFromSwitch(target) {
  if (app.switching) return;
  if (target === "home") {
    goHome();
    return;
  }
  const [code, kind = null] = target.split("/");
  if (code === app.league?.code && (kind ?? app.kind) === app.kind) return;

  app.switching = true;
  renderLeagueSwitch(el.league, { league: { code }, kind, leagues: app.leagues }, openFromSwitch);
  el.shell?.classList.add("is-swapping");
  await twoFrames();
  // The colour tokens switch inside openLeague. Let the old board finish its
  // 160ms exit first so borders and badges cannot flash the incoming palette
  // while they are still visible.
  await new Promise((resolve) => setTimeout(resolve, 150));

  try {
    const league = await leagueByCode(code);
    if (!league) throw new Error("that league could not be found");
    await openLeague(league, kind);
    window.history.replaceState(null, "", leagueHash(league.code, app.kind));
  } catch (error) {
    // Put the board back the way it was, including its colours.
    renderLeagueSwitch(
      el.league,
      { league: app.league, kind: app.kind, leagues: app.leagues },
      openFromSwitch,
    );
    themeFor(app.kind);
    app.message = `Could not open that league: ${error.message}`;
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
      await openBoard(league.code);
      return true;
    } catch (error) {
      app.homeMessage = `That invite did not open: ${error.message}`;
      return false;
    }
  }

  const known = app.leagues.some((league) => league.code === asked.code);
  if (!known && !sharingAvailable()) return false;
  await openBoard(asked.code, asked.kind);
  return app.view === "board";
}

async function main() {
  // Every visit begins in the first sport's palette, which is what the start
  // screen and the home page wear before any league is open.
  applyTheme(null);
  await requireIdentity();

  await reloadLeagues();
  const opened = await openFromHash();

  // The first render defers the season search so the board can paint; behind
  // the startup layer there is nothing to protect, so it runs there instead.
  if (opened) settleBeforeReveal();

  if (!opened) {
    // No link, or a link that did not open: the home page, and a board is one
    // tap from it. A single league is not opened automatically - a person with
    // one league still wants to see its code and share it.
    app.view = "home";
    renderHomeView();
  }

  await startupMinimum();
  await finishStartup();
  startClock();
  registerServiceWorker();

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
 * Run the season search the first render put off, while the startup layer
 * still covers the board.
 *
 * The first render defers the search so a board can paint before the main
 * thread freezes for it. At startup that deferral worked against us: the
 * timer fired a few hundred milliseconds after the board was built, which was
 * often partway through the crossfade from the startup layer, and the fade
 * stalled and jumped. Behind the startup layer the freeze costs nothing to
 * look at, since its play runs on the compositor, so the search goes there.
 */
function settleBeforeReveal() {
  if (!app.recommendTimer) return;
  clearTimeout(app.recommendTimer);
  app.recommendTimer = null;
  render();
}

main().catch((error) => {
  document.body.classList.remove("is-gated");
  document.body.classList.remove("is-starting");
  if (el.startup) el.startup.hidden = true;
  if (el.start) el.start.hidden = true;
  el.notices.innerHTML = `<div class="notice notice--warn">Could not load the board: ${error.message}</div>`;
  console.error(error);
});
