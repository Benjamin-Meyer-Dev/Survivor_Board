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
 */

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

  // The entrance only plays when the tab actually changed - otherwise every
  // lock and pick would re-flash the panel.
  const changed = activeId !== lastRendered;
  lastRendered = activeId;
  applyPanels(activeId, changed);
}

function buildTabBar(root) {
  root.innerHTML = TABS.map(
    (tab) => `
      <button type="button" class="tab" role="tab"
              id="tab-${tab.id}" data-tab="${tab.id}"
              aria-controls="${tab.panel}"
              aria-selected="false" tabindex="-1">${tab.label}</button>`,
  ).join("");

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

/** Cancels the in-flight entrance, if there is one. */
let finishEntrance = null;

/** Show the active panel and hide the rest; the new one rises into place. */
function applyPanels(activeId, animate) {
  finishEntrance?.();

  const panels = TABS.map((tab) => document.getElementById(tab.panel)).filter(Boolean);
  const to = document.getElementById(TABS.find((tab) => tab.id === activeId)?.panel);
  if (!to) return;

  for (const panel of panels) panel.hidden = panel !== to;
  if (!animate || prefersReducedMotion()) return;

  to.classList.add("is-entering");
  const timer = setTimeout(() => finishEntrance?.(), 320);
  finishEntrance = () => {
    clearTimeout(timer);
    to.classList.remove("is-entering");
    finishEntrance = null;
  };
}

function prefersReducedMotion() {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
