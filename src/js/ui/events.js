/**
 * One listener per region, bound to the element a render does not replace.
 *
 * The board's panels are rebuilt from innerHTML - a pick is a render, and a
 * render rewrites the week's card and the whole team list under it. Binding a
 * listener to each button afterwards meant several dozen fresh closures per
 * render, all of them thrown away by the next one, and every module carrying
 * the same loop to attach them.
 *
 * So the listener goes on the panel's own root, which is in the page from the
 * first paint and outlives everything inside it, and the event's target says
 * which control was hit. The handler itself does change per render - it closes
 * over the board that was drawn - so the latest one is kept here and the DOM
 * listener is bound once. Nothing to unbind, and a rebuilt panel is live the
 * moment its markup lands.
 */

/** Per root: the current handler for each type/selector pair bound on it. */
const bound = new WeakMap();

/**
 * @param {HTMLElement|null} root The element that survives the render.
 * @param {string} type An event type that bubbles.
 * @param {string} selector Matched with closest() from the event's target, so a
 *   tap on a control's own children counts as a tap on the control.
 * @param {(target:HTMLElement, event:Event) => void} handle Replaces whatever
 *   was bound for this pair before, so the handler is never a render behind.
 */
export function delegate(root, type, selector, handle) {
  if (!root) return;

  let handlers = bound.get(root);
  if (!handlers) {
    handlers = new Map();
    bound.set(root, handlers);
  }

  const key = `${type}|${selector}`;
  const existing = handlers.get(key);
  if (existing) {
    existing.handle = handle;
    return;
  }

  const entry = { handle };
  handlers.set(key, entry);
  root.addEventListener(type, (event) => {
    const target = event.target?.closest?.(selector);
    // contains(): closest() can climb out of the root when the region is
    // nested inside another that binds the same selector.
    if (target && root.contains(target)) entry.handle(target, event);
  });
}
