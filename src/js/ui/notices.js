/**
 * One-line banners: a message from app.js, storage mode, and any rule break
 * on the board.
 */

import { escapeHtml } from "../core/format.js";

export function renderNotices(root, { store, board, message }) {
  const notices = [];

  if (message) notices.push(message);

  if (!store.shared) {
    notices.push(
      "Shared saving is off, so picks, locks and results stay on this device only. The coach's suggestions and the odds are still current.",
    );
  }

  // Unreachable once the passcode gate has passed, since the same digest opens
  // the store. Kept so a mismatch says something rather than greying out buttons.
  if (!store.canWrite) {
    notices.push("You are viewing in read-only mode. This device's passcode does not match.");
  }

  for (const conflict of board.conflicts) {
    notices.push(
      `Rule break: ${conflict.team} is now picked in both week ${conflict.weeks[0]} and week ${conflict.weeks[1]}. Swap one of them.`,
    );
  }

  root.innerHTML = notices
    .map((text) => `<div class="notice notice--warn">${escapeHtml(text)}</div>`)
    .join("");
}
