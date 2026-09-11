/**
 * The drawer's tabs: Sideline, Drive, Bench.
 *
 * A real tablist: roving tabindex, arrow/Home/End keys, aria-selected, and
 * `hidden` on the panels rather than `display:none` in a stylesheet, so the
 * state lives in one place. Every new page load begins on the sideline. From
 * 900px wide the stylesheet shows all three panels side by side and hides
 * the bar; the state here still says which one a phone would be on.
 *
 * The bar is built ONCE and updated in place afterwards: renderTabs runs on
 * every board render, and rewriting the markup would drop the focus of a
 * keyboard user mid-arrow.
 *
 * The indicator is one mark that slides between the tabs rather than an
 * underline lit under each of them in turn - the same thing the field's bracket
 * does with its yard lines, and for the same reason: a transform on one element
 * says which way the drawer moved, where three fades only say that it did.
 */

import { afterMotion, prefersReducedMotion } from "./motion.js";

export const TABS = Object.freeze([
  { id: "week", label: "Sideline", panel: "view-week" },
  { id: "path", label: "The drive", panel: "view-path" },
  { id: "burn", label: "Bench", panel: "view-burn" },
]);

/** Every visit opens on the sideline, regardless of the previous session. */
export function initialTab() {
  return TABS[0].id;
}

/** Latest handler, so the listeners bound on the first render stay current. */
let onTab = () => {};
let lastRendered = null;

/**
 * @param {HTMLElement} root The element with role="tablist".
 * @param {string} activeId
 * @param {(id: string) => void} onSelect
 */
export function renderTabs(root, activeId, onSelect) {
  onTab = onSelect;

  if (!root.firstElementChild) buildTabBar(root);

  for (const button of root.querySelectorAll("[data-tab]")) {
    const isActive = button.dataset.tab === activeId;
    button.setAttribute("aria-selected", String(isActive));
    button.tabIndex = isActive ? 0 : -1;
  }

  // Which tab the mark stands under. Every tab is an equal share of the bar, so
  // its place in the list is the whole of what the stylesheet needs.
  const at = TABS.findIndex((tab) => tab.id === activeId);
  root.style.setProperty("--tab", String(Math.max(at, 0)));

  // The entrance only plays when the tab actually changed - otherwise every
  // lock and pick would re-flash the panel. Which way the drawer travelled is
  // the two tabs' places in the bar, so a step right and a step back read
  // differently rather than both being a rise.
  const was = TABS.findIndex((tab) => tab.id === lastRendered);
  const changed = activeId !== lastRendered;
  const direction = changed && was >= 0 && at >= 0 ? Math.sign(at - was) : 0;
  lastRendered = activeId;
  applyPanels(activeId, changed, direction);
}

function buildTabBar(root) {
  root.style.setProperty("--tabs", String(TABS.length));
  root.innerHTML = `${TABS.map(
    (tab) => `
      <button type="button" class="tab" role="tab"
              id="tab-${tab.id}" data-tab="${tab.id}"
              aria-controls="${tab.panel}"
              aria-selected="false" tabindex="-1">${tab.label}</button>`,
  ).join("")}
      <span class="tab-marker" aria-hidden="true"></span>`;

  const buttons = [...root.querySelectorAll("[data-tab]")];

  buttons.forEach((button, index) => {
    button.addEventListener("click", () => onTab(button.dataset.tab));

    button.addEventListener("keydown", (event) => {
      const moves = {
        ArrowRight: index + 1,
        ArrowLeft: index - 1,
        Home: 0,
        End: buttons.length - 1,
      };
      const next = moves[event.key];
      if (next === undefined) return;

      event.preventDefault();
      const target = buttons[(next + buttons.length) % buttons.length];
      target.focus();
      onTab(target.dataset.tab);
    });
  });
}

/** The panel currently arriving, so a second tab change can cut its entrance. */
let entering = null;
/** The panel on its way out, and the change it belongs to. */
let leaving = null;
/** The latest tab change, so one overtaken part way through gives way to it. */
let change = null;

/**
 * Show the active panel and hide the rest: the one being left goes the way the
 * drawer is travelling, and the one asked for comes in behind it.
 *
 * In two beats rather than one, because the panels stack: on a phone only one
 * is in the layout at a time, and showing both to cross-fade them would push
 * the drawer to twice its height for the length of the fade. So the exit is
 * kept short - it is dead time in front of the thing somebody asked for - and
 * the entrance follows it.
 *
 * How long either takes is the stylesheet's business alone - the classes come
 * off when the keyframes they name have finished (see ui/motion.js), so
 * shortening panel-enter in motion.css cannot leave one hanging on afterwards.
 *
 * @param {string} activeId
 * @param {boolean} animate
 * @param {number} direction -1 for a step towards the start of the bar, +1
 *   towards the end, 0 where there is no direction to give - the first paint,
 *   or a panel shown again by a render.
 */
function applyPanels(activeId, animate, direction = 0) {
  const panels = TABS.map((tab) => document.getElementById(tab.panel)).filter(Boolean);
  const to = document.getElementById(TABS.find((tab) => tab.id === activeId)?.panel);
  if (!to) return;

  // A change already in flight owns the panels until it has finished. Every
  // render calls this, and a pick or a lock has nothing to say about which
  // panel is showing - it used to strip the entrance off a panel that was
  // still arriving.
  if (!animate && (change || entering)) return;

  const from = panels.find((panel) => !panel.hidden && panel !== to);
  const show = () => {
    for (const panel of panels) panel.hidden = panel !== to;
  };

  // Whatever an earlier change was still playing is not what the drawer is
  // doing now. Cleared before this one starts, so a panel cannot be left
  // wearing an exit it will never finish.
  settlePanels(panels);

  if (!animate || prefersReducedMotion() || !from) {
    change = null;
    show();
    if (animate && !prefersReducedMotion()) enter(to, direction);
    return;
  }

  const mine = {};
  change = mine;
  leaving = from;
  if (direction) from.style.setProperty("--slide", String(direction));
  from.classList.add("is-leaving");
  afterMotion(from, { subtree: false }).then(() => {
    // Overtaken: a later tab change has already decided what is on screen.
    if (change !== mine) return;
    change = null;
    leaving = null;
    from.classList.remove("is-leaving");
    from.style.removeProperty("--slide");
    show();
    enter(to, direction);
  });
}

/**
 * The panel arriving. Shown and told to enter in the one task: a panel that
 * was display:none has no animation on it to reset, so the class goes straight
 * on rather than through playOnce, which would first read offsetWidth to force
 * the browser to drop a finished play - a layout of the whole page for a panel
 * that had nothing to drop.
 */
function enter(panel, direction) {
  entering = panel;
  if (direction) panel.style.setProperty("--slide", String(direction));
  panel.classList.add("is-entering", ...(direction ? ["is-directed"] : []));
  afterMotion(panel, { subtree: false }).then(() => {
    panel.classList.remove("is-entering", "is-directed");
    panel.style.removeProperty("--slide");
    if (entering === panel) entering = null;
  });
}

/** Whatever an earlier change left on the panels, off. */
function settlePanels(panels) {
  change = null;
  entering?.classList.remove("is-entering", "is-directed");
  leaving?.classList.remove("is-leaving");
  entering = null;
  leaving = null;
  for (const panel of panels) panel.style.removeProperty("--slide");
}
