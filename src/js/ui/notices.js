/**
 * One-line banners: storage mode and anything the refresh workflow flagged.
 *
 * The read-only banner is the one you can act on: tapping it asks for the pool
 * passphrase, which is the only way writes get unlocked on a device.
 */

import { escapeHtml } from "../core/format.js";

export function renderNotices(root, { store, board, unlockMessage }, { onUnlock } = {}) {
  const notices = [];

  if (!store.shared) {
    notices.push(
      "Shared saving is off, so locks and results stay on this device only. The plan and the odds are still current.",
    );
  }

  for (const conflict of board.conflicts) {
    notices.push(
      `Rule break: ${conflict.team} is now picked in both week ${conflict.weeks[0]} and week ${conflict.weeks[1]}. Swap one of them.`,
    );
  }

  for (const flag of board.flagged) {
    notices.push(
      `Week ${flag.week}: ${flag.team} is only ${Math.abs(flag.spread).toFixed(1)} points. Consider a backup.`,
    );
  }

  const html = notices.map((text) => `<div class="notice notice--warn">${escapeHtml(text)}</div>`);

  if (!store.canWrite) {
    const text =
      unlockMessage || "You are viewing in read-only mode. Tap to enter the pool passphrase.";
    html.unshift(
      `<button type="button" class="notice notice--warn notice--action" data-action="unlock">${escapeHtml(text)}</button>`,
    );
  }

  root.innerHTML = html.join("");
  root.querySelector('[data-action="unlock"]')?.addEventListener("click", () => onUnlock?.());
}
