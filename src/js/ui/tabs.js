/**
 * Tab bar for the three views.
 *
 * A real tablist: roving tabindex, arrow/Home/End keys, aria-selected, and
 * `hidden` on the panels rather than `display:none` in a stylesheet, so the
 * state lives in one place. Every new page load begins on This Week.
 *
 * The bar is built ONCE and updated in place afterwards. renderTabs runs on
 * every board render, and rewriting the markup would hand the browser a brand
 * new marker element each time; a new element has no previous position, so the
 * underline would teleport instead of sliding.
 *
 * Switching panels is a cross-fade over an animated height rather than a swap:
 * the three views are wildly different heights, and a hard cut made the page
 * jump under your thumb.
 */

/** Long enough to read as a move, short enough not to be in the way. */
const FADE_MS = 220;
const SLIDE_MS = 280;

export const TABS = Object.freeze([
  { id: "week", label: "This Week", panel: "view-week" },
  { id: "path", label: "Gameplan", panel: "view-path" },
  { id: "burn", label: "Depth Chart", panel: "view-burn" },
]);

/** Every visit opens on This Week, regardless of the previous session. */
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

  const index = Math.max(
    TABS.findIndex((tab) => tab.id === activeId),
    0,
  );
  root.querySelector(".tab-marker")?.style.setProperty("--i", String(index));

  for (const button of root.querySelectorAll("[data-tab]")) {
    const isActive = button.dataset.tab === activeId;
    button.setAttribute("aria-selected", String(isActive));
    button.tabIndex = isActive ? 0 : -1;
  }

  // The transition only plays when the tab actually changed - otherwise every
  // lock and swap would re-flash the view.
  const changed = activeId !== lastRendered;
  lastRendered = activeId;

  applyPanels(activeId, changed);
}

function buildTabBar(root) {
  root.innerHTML = `
    ${TABS.map(
      (tab) => `
      <button type="button" class="tab" role="tab"
              id="tab-${tab.id}" data-tab="${tab.id}"
              aria-controls="${tab.panel}"
              aria-selected="false" tabindex="-1">${tab.label}</button>`,
    ).join("")}
    <span class="tab-marker" aria-hidden="true" style="--n:${TABS.length};--i:0"></span>`;

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

/** Cancels the in-flight cross-fade, if there is one. */
let finishTransition = null;

/**
 * Show the active panel and hide the rest.
 *
 * When animating, the outgoing panel is lifted out of flow and faded over the
 * incoming one while their container is transitioned from the old height to
 * the new. Taking it out of flow is also what makes the target height
 * measurable: with both panels in flow the container is as tall as the two of
 * them together.
 */
function applyPanels(activeId, animate) {
  // A render landing mid-transition settles it first, so the two never fight
  // over the same inline styles.
  finishTransition?.();

  const container = document.getElementById("views");
  const panels = TABS.map((tab) => document.getElementById(tab.panel)).filter(Boolean);
  const to = document.getElementById(TABS.find((tab) => tab.id === activeId)?.panel);
  const from = panels.find((panel) => !panel.hidden && panel !== to);

  if (!to) return;

  if (!animate || !from || !container || prefersReducedMotion()) {
    for (const panel of panels) panel.hidden = panel !== to;
    return;
  }

  const startHeight = container.offsetHeight;

  to.hidden = false;
  from.classList.add("view--leaving");
  // Now that `from` is absolute, the container's natural height is `to`'s.
  const endHeight = to.offsetHeight;

  container.classList.add("views--moving");
  container.style.height = `${startHeight}px`;
  void container.offsetHeight;
  container.style.height = `${endHeight}px`;

  to.classList.add("is-entering");

  let done = false;
  finishTransition = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    finishTransition = null;

    from.classList.remove("view--leaving");
    to.classList.remove("is-entering");
    container.classList.remove("views--moving");
    container.style.removeProperty("height");
    for (const panel of panels) panel.hidden = panel !== to;
  };

  const timer = setTimeout(finishTransition, Math.max(FADE_MS, SLIDE_MS) + 60);
}

function prefersReducedMotion() {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
