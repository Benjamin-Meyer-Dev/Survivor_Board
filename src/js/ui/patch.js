/**
 * Putting markup on the page without replacing what has not changed.
 *
 * Every region used to be rebuilt from innerHTML on every render, and a render
 * is what every tap does. That threw away far more than it changed - a pick
 * moves one slot, one yard line and a few marks, and it rebuilt every season
 * row and every card on the bench, twice: once for the tap and once when the
 * season search landed a moment later. Worse, the node the tap's own feedback
 * was playing on was one of the nodes thrown away, so the search landing
 * mid-keyframe cut the motion dead (see playEffect and repaintAfterMotion in
 * app.js for the other half of that fix).
 *
 * Two ways in, both keyed on what the markup SAYS rather than on what the node
 * has become. A node on the page picks up state the markup does not carry - a
 * feedback class, an inline animation delay, `hidden` from the filter, the
 * bracket's own class toggles - and comparing the live outerHTML would call
 * every one of those a change. So each node remembers the markup it was made
 * from, and a node is kept when the new markup for it is the same string.
 *
 *   paint(root, html)        one region, all or nothing: skipped when the
 *                            string is what it was, so a region a render did
 *                            not change keeps its nodes and whatever they
 *                            were doing.
 *   reconcile(parent, html)  keyed children: each child in `html` carries a
 *                            data-key, and a child already on the page under
 *                            that key is kept when its markup has not
 *                            changed, moved when its place has, and replaced
 *                            otherwise. What the new markup does not name is
 *                            removed.
 *
 * Both return whether anything on the page changed, so a caller can skip the
 * work that only follows a change (measuring the field, say).
 *
 * The text between children - the newlines and indentation a template literal
 * carries - is dropped from a reconciled parent. Every parent here is a grid
 * or a flex column, where whitespace between items draws nothing, and keeping
 * it would leave the parent collecting it render after render.
 */

/** The markup a painted region was last given. */
const painted = new WeakMap();

/** The markup a reconciled child was made from. */
const SOURCE = Symbol("source");

/**
 * @param {HTMLElement|null} root
 * @param {string} html
 * @returns {boolean} Whether the page changed.
 */
export function paint(root, html) {
  if (!root) return false;
  if (painted.get(root) === html) return false;
  root.innerHTML = html;
  painted.set(root, html);
  return true;
}

/**
 * @param {HTMLElement|null} parent
 * @param {string} html The parent's children, each with a `data-key`.
 * @returns {boolean} Whether the page changed.
 */
export function reconcile(parent, html) {
  if (!parent) return false;
  const template = document.createElement("template");
  template.innerHTML = html;

  const existing = new Map();
  for (const child of parent.children) {
    const key = child.dataset.key;
    if (key !== undefined && !existing.has(key)) existing.set(key, child);
  }

  let changed = false;
  const wanted = [];
  for (const next of [...template.content.children]) {
    const source = next.outerHTML;
    const held = existing.get(next.dataset.key);
    if (held && held[SOURCE] === source) {
      existing.delete(next.dataset.key);
      wanted.push(held);
      continue;
    }
    next[SOURCE] = source;
    changed = true;
    wanted.push(next);
  }

  // What the new markup does not name goes - the children under keys it
  // dropped, the ones it replaced, and the text between them.
  const keep = new Set(wanted);
  for (const node of [...parent.childNodes]) {
    if (!keep.has(node)) {
      node.remove();
      changed = true;
    }
  }

  // Into order, moving only what is out of place. A node already at its index
  // is left alone, which is what keeps a kept node's motion running.
  wanted.forEach((node, index) => {
    const at = parent.children[index] ?? null;
    if (at !== node) {
      parent.insertBefore(node, at);
      changed = true;
    }
  });
  return changed;
}

/**
 * A region's fixed frame, built once: the wrapper a reconciled list lives in,
 * with whatever static markup sits beside it. Returns the root's first
 * element, which is the frame.
 *
 * @param {HTMLElement} root
 * @param {string} html
 */
export function frame(root, html) {
  if (!root.firstElementChild) root.innerHTML = html;
  return root.firstElementChild;
}
