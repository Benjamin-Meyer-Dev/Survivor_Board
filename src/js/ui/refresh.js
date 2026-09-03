/**
 * The manual refresh control.
 *
 * Renders into the "Lines refreshed" strip cell, which is where freshness
 * already lives. Rendering only; app.js owns the request itself.
 */

import { escapeHtml } from "../core/format.js";
import { refreshState, formatCountdown } from "../core/refresh.js";

/**
 * @param {HTMLElement} root
 * @param {object} view
 * @param {object|undefined} view.refresh entry.refresh
 * @param {string} view.status transient message from the last attempt
 * @param {boolean} view.canWrite
 * @param {() => void} onRefresh
 */
export function renderRefresh(root, view, onRefresh) {
  if (!root) return;

  const { state, remainingMs, by } = refreshState(view.refresh);
  const busy = state === "watching";
  const disabled = state !== "ready" || !view.canWrite;

  const label = busy ? "Checking…" : state === "cooling" ? formatCountdown(remainingMs) : "Refresh";

  root.innerHTML = `
    <button type="button" class="refresh__btn" ${disabled ? "disabled" : ""}
            aria-live="polite"
            title="${escapeHtml(
              state === "ready"
                ? "Pull current lines now. Does not change the 6 hour schedule."
                : `Requested by ${by ?? "someone"}. Available again in ${formatCountdown(remainingMs)}.`,
            )}">
      <span class="refresh__spinner" ${busy ? "" : "hidden"}></span>
      ${escapeHtml(label)}
    </button>
    ${view.status ? `<span class="refresh__status">${escapeHtml(view.status)}</span>` : ""}`;

  const button = root.querySelector("button");
  if (button && !disabled) button.addEventListener("click", onRefresh);
}
