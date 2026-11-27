/**
 * Putting a list in your own order: hold an item, and it lifts and follows
 * the finger; the others step aside to make its room; let go and it settles
 * into the place it was dropped. The home page's leagues use it (ui/home.js).
 *
 * The hold is what tells a drag from a scroll. The list scrolls under a finger
 * like any other, so a press only becomes a drag once it has stayed put for
 * HOLD_MS - moving first is a scroll, and the browser has it. Once lifted, the
 * list's own scrolling is held off for the rest of the touch (a non-passive
 * touchmove that says no), and the list scrolls itself instead when the item is
 * carried to its top or bottom edge.
 *
 * The item really moves in the page as it is carried: each time its centre
 * crosses a neighbour's, the node goes before or after that neighbour, the
 * browser lays the list out again, and the neighbours that moved slide from
 * where they were to where they now are. Leaving the layout to the browser is
 * what lets items of different heights, and a list laid out as a grid of
 * several columns on a wide screen, reorder without any of it being worked out
 * here. The lifted item is drawn at the finger whatever the layout says, by a
 * translate measured against its own layout box.
 *
 * Crossing is measured against the neighbour's centre and not its edge, which
 * is what keeps two items of different heights from swapping back and forth:
 * once the swap is made, the tall one's centre is well behind the finger, and
 * going back means moving back past it.
 *
 * A release that lifted anything never clicks what it was released on - the
 * press was a hold, not a tap - and the order is only handed back when it
 * changed. With motion reduced nothing slides, and everything still moves.
 */

import { afterMotion, prefersReducedMotion } from "./motion.js";

/** How long a press has to stay put to lift. Under a long press's half second. */
const HOLD_MS = 380;

/** How far a press may wander and still be the same press, rather than a scroll. */
const SLOP_PX = 8;

/** How close to the list's top or bottom the item has to be carried to scroll it. */
const EDGE_PX = 64;

/** The fastest the list scrolls itself, in pixels a frame, at the very edge. */
const SCROLL_PX = 16;

/** How long a neighbour takes to step aside. */
const STEP_MS = 200;

/**
 * Let the items of a list be put in order by hand.
 *
 * @param {HTMLElement} list The list itself: the scroll box, and the parent of
 *   the items. Its `position` must make it the items' offset parent.
 * @param {object} options
 * @param {string} options.items What an item is, as a selector.
 * @param {string} [options.ignore] What a hold may not start on.
 * @param {(item:HTMLElement) => boolean} [options.canStart] Whether this item
 *   can be lifted now.
 * @param {(keys:string[]) => void} options.onDrop The items' `data-key`s in
 *   their new order, when a drop changed it.
 * @param {() => void} [options.onEnd] Every drop, changed or not, after onDrop:
 *   for a caller that held a render back while the item was lifted.
 * @returns {{lifted: () => boolean}} Whether an item is being carried: a render
 *   that put the list in order now would pull it out from under the finger.
 */
export function watchReorder(
  list,
  { items, ignore = "", canStart = () => true, onDrop, onEnd = () => {} },
) {
  let hold = null;
  let drag = null;
  let settling = 0;
  let swallowClick = false;
  const stepping = new WeakMap();

  const itemsOf = () => [...list.children].filter((node) => node.matches(items));
  const keysOf = () => itemsOf().map((node) => node.dataset.key);

  /** Where an item's layout box is on screen, whatever it is being drawn at. */
  const boxOf = (node) => {
    const frame = list.getBoundingClientRect();
    const left = frame.left + list.clientLeft + node.offsetLeft - list.scrollLeft;
    const top = frame.top + list.clientTop + node.offsetTop - list.scrollTop;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    return {
      left,
      top,
      right: left + width,
      bottom: top + height,
      cx: left + width / 2,
      cy: top + height / 2,
      width,
      height,
    };
  };

  /** One column, as a phone lays the list out: the item then only travels up and down. */
  const oneColumn = () => {
    const all = itemsOf();
    return all.length < 2 || all.every((node) => node.offsetLeft === all[0].offsetLeft);
  };

  list.addEventListener("pointerdown", (event) => {
    if (hold || drag) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const item = event.target.closest(items);
    if (!item || item.parentElement !== list) return;
    if (ignore && event.target.closest(ignore)) return;
    if (!canStart(item)) return;
    hold = {
      item,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(lift, HOLD_MS),
    };
  });

  list.addEventListener("pointermove", (event) => {
    if (!hold || event.pointerId !== hold.pointerId) return;
    if (Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > SLOP_PX) letGo();
  });

  const release = (event) => {
    if (hold && event.pointerId === hold.pointerId) letGo();
  };
  list.addEventListener("pointerup", release);
  list.addEventListener("pointercancel", release);

  // While an item is carried its pointer is followed on the window, not the
  // list: the finger can be over anything by the time it moves or lets go -
  // past the list's edge, or over the page behind it - and the release has to
  // be heard wherever it lands, or the item is left lifted for good.
  const carry = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
  };
  const putDown = (event) => {
    if (drag && event.pointerId === drag.pointerId) drop();
  };

  // Once lifted, the touch is the item's and not the list's: without this the
  // list scrolls under the item as it is carried, and Chrome takes the touch
  // over and cancels the drag. Not passive, or it is not allowed to say no.
  list.addEventListener(
    "touchmove",
    (event) => {
      if (drag) event.preventDefault();
    },
    { passive: false },
  );

  // A held press on a phone is also the platform's long press: the menu it
  // offers, and the text it selects, are not what this hold is for.
  list.addEventListener("contextmenu", (event) => {
    if (hold || drag) event.preventDefault();
  });

  // The release that ends a lift lands on whatever the finger was over - the
  // item's open button, say - and must not press it.
  list.addEventListener(
    "click",
    (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );

  /** A press let go of, or wandered off, before it lifted. */
  function letGo() {
    clearTimeout(hold?.timer);
    hold = null;
  }

  function lift() {
    const { item, pointerId, x, y } = hold;
    hold = null;
    if (!item.isConnected || item.parentElement !== list) return;
    const box = boxOf(item);
    drag = {
      item,
      pointerId,
      startX: x,
      startY: y,
      x,
      y,
      origin: { x: box.left, y: box.top },
      size: { width: box.width, height: box.height },
      single: oneColumn(),
      order: keysOf(),
      // Read before the item is drawn anywhere but its slot. The items keep
      // their sizes while one is carried, so the list keeps its length.
      scrollLimit: scrollLimitOf(),
      raf: 0,
    };
    try {
      item.setPointerCapture(pointerId);
    } catch {
      /* the pointer has already gone: the next event drops it */
    }
    window.addEventListener("pointermove", carry);
    window.addEventListener("pointerup", putDown);
    window.addEventListener("pointercancel", putDown);
    list.classList.add("is-reordering");
    item.classList.add("is-lifted");
    // A tick under the thumb where the platform has one, so the lift is felt
    // as well as seen. Refused without a tap behind it, which is fine.
    try {
      navigator.vibrate?.(8);
    } catch {
      /* no vibration motor, or no permission: the lift still shows */
    }
    const tick = () => {
      if (!drag) return;
      scrollAtEdge();
      follow();
      retarget();
      drag.raf = requestAnimationFrame(tick);
    };
    drag.raf = requestAnimationFrame(tick);
  }

  /** Draw the lifted item at the finger, wherever its layout box now is. */
  function follow() {
    const { item, origin } = drag;
    const now = boxOf(item);
    const dx = origin.x - now.left + (drag.single ? 0 : drag.x - drag.startX);
    const dy = origin.y - now.top + (drag.y - drag.startY);
    item.style.setProperty("--lift-x", `${Math.round(dx)}px`);
    item.style.setProperty("--lift-y", `${Math.round(dy)}px`);
  }

  /**
   * Carried to the top or bottom of the list, the list scrolls to meet it -
   * as far as the list goes and no further. The browser's own limit will not
   * do: the item is drawn where the finger is, and an item drawn below the
   * last one makes the list that much longer to the browser, so holding it at
   * the bottom edge scrolled on into nothing, the item carrying the end of the
   * list down ahead of it.
   */
  function scrollAtEdge() {
    const frame = list.getBoundingClientRect();
    const above = drag.y - frame.top;
    const below = frame.bottom - drag.y;
    let speed = 0;
    if (above < EDGE_PX) speed = -SCROLL_PX * Math.min(1, (EDGE_PX - above) / EDGE_PX);
    else if (below < EDGE_PX) speed = SCROLL_PX * Math.min(1, (EDGE_PX - below) / EDGE_PX);
    if (!speed) return;
    const to = Math.max(0, Math.min(drag.scrollLimit, list.scrollTop + speed));
    if (Math.abs(to - list.scrollTop) >= 0.5) list.scrollTop = to;
  }

  /** How far the list scrolls with every item in its own slot. */
  function scrollLimitOf() {
    let bottom = 0;
    for (const node of itemsOf()) bottom = Math.max(bottom, node.offsetTop + node.offsetHeight);
    const foot = parseFloat(getComputedStyle(list).paddingBottom) || 0;
    return Math.max(0, bottom + foot - list.clientHeight);
  }

  /**
   * Where the item belongs now: after every other item its centre has passed.
   * An item in a row above is passed; in a row below, not; in its own row, by
   * the centre - up and down in one column, across in several.
   */
  function retarget() {
    const { item, origin, size } = drag;
    const cx = origin.x + size.width / 2 + (drag.single ? 0 : drag.x - drag.startX);
    const cy = origin.y + size.height / 2 + (drag.y - drag.startY);
    const others = itemsOf().filter((node) => node !== item);
    let passed = 0;
    for (const node of others) {
      const box = boxOf(node);
      const past = cy > box.bottom || (cy >= box.top && (drag.single ? cy > box.cy : cx > box.cx));
      if (past) passed += 1;
    }
    // Where it is now: as many others before it as its index says.
    const at = itemsOf().indexOf(item);
    if (passed === at) return;
    // The others it has passed go across it, rather than it going past them.
    // The item never leaves the page that way, and that matters: a node taken
    // out of the page - which is what moving it is - loses the pointer it was
    // holding, and the release then lands on the page rather than on it.
    step(others, () => {
      if (passed > at) {
        // Carried down past these: each goes over to before it, in order.
        for (const node of others.slice(at, passed)) item.before(node);
      } else {
        // Carried up past these: each goes over to after it, the nearest last.
        for (const node of others.slice(passed, at).reverse()) item.after(node);
      }
    });
    follow();
  }

  /**
   * Put the others where the item's new place has them, and slide each from
   * where it was drawn to where it now is. From where it was DRAWN, so a
   * neighbour still sliding from the last step carries on from where it got
   * to rather than jumping back to start the next one.
   */
  function step(others, move) {
    const reduced = prefersReducedMotion();
    const was = reduced
      ? null
      : new Map(others.map((node) => [node, node.getBoundingClientRect()]));
    if (!reduced) for (const node of others) stepping.get(node)?.cancel();
    move();
    if (reduced) return;
    for (const node of others) {
      const before = was.get(node);
      const after = node.getBoundingClientRect();
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      const slide = node.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
        { duration: STEP_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
      );
      stepping.set(node, slide);
      slide.finished.then(
        () => stepping.get(node) === slide && stepping.delete(node),
        () => {},
      );
    }
  }

  /** Let go: the item settles into its place, and the new order goes back. */
  function drop() {
    const { item, pointerId, order, raf } = drag;
    cancelAnimationFrame(raf);
    drag = null;
    window.removeEventListener("pointermove", carry);
    window.removeEventListener("pointerup", putDown);
    window.removeEventListener("pointercancel", putDown);
    try {
      item.releasePointerCapture(pointerId);
    } catch {
      /* already released */
    }
    swallowClick = true;
    // A click that never comes - a release off the list - must not swallow the
    // next real one.
    setTimeout(() => {
      swallowClick = false;
    }, 400);

    settling += 1;
    item.classList.add("is-dropping");
    item.classList.remove("is-lifted");
    item.style.setProperty("--lift-x", "0px");
    item.style.setProperty("--lift-y", "0px");
    afterMotion(item, { subtree: false }).then(() => {
      item.classList.remove("is-dropping");
      item.style.removeProperty("--lift-x");
      item.style.removeProperty("--lift-y");
      settling -= 1;
      if (!drag && settling === 0) list.classList.remove("is-reordering");
    });

    const now = keysOf();
    if (now.join("\n") !== order.join("\n")) onDrop(now);
    onEnd();
  }

  return { lifted: () => Boolean(drag) };
}
