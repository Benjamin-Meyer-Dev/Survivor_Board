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

import { playOnce, prefersReducedMotion } from "./motion.js";

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
  // lock and pick would re-flash the panel.
  const changed = activeId !== lastRendered;
  lastRendered = activeId;
  applyPanels(activeId, changed);
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

/**
 * Show the active panel and hide the rest; the new one rises into place.
 *
 * How long the entrance takes is the stylesheet's business alone - the class
 * comes off when the keyframes it names have finished (see ui/motion.js), so
 * shortening panel-enter in motion.css cannot leave the class hanging on
 * afterwards.
 */
function applyPanels(activeId, animate) {
  entering?.classList.remove("is-entering");
  entering = null;

  const panels = TABS.map((tab) => document.getElementById(tab.panel)).filter(Boolean);
  const to = document.getElementById(TABS.find((tab) => tab.id === activeId)?.panel);
  if (!to) return;

  for (const panel of panels) panel.hidden = panel !== to;
  if (!animate || prefersReducedMotion()) return;

  entering = to;
  playOnce(to, ["is-entering"]).then(() => {
    if (entering === to) entering = null;
  });
}
