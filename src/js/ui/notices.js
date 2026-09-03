/**
 * One-line banners: a message from app.js, storage mode, and anything the
 * refresh workflow flagged.
 */

import { escapeHtml } from "../core/format.js";

export function renderNotices(root, { store, board, message }) {
  const notices = [];

  if (message) notices.push(message);

  if (!store.shared) {
    notices.push(
      "Shared saving is off, so locks and results stay on this device only. The plan and the odds are still current.",
    );
  }

  // Unreachable once the passcode gate has passed, since the same value opens
  // the store. Kept so a mismatch says something rather than greying out buttons.
  if (!store.canWrite) {
    notices.push("You are viewing in read-only mode. This device's passcode does not match.");
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

  root.innerHTML = notices
    .map((text) => `<div class="notice notice--warn">${escapeHtml(text)}</div>`)
    .join("");
}
