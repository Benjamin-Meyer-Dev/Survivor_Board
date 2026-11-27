/**
 * Putting a list in your own order: hold an item, and it lifts and follows
 * the finger; the others rock where they sit, to say they can be moved among,
 * and step aside to make its room; let go and it settles into the place it was
 * dropped. The home page's leagues use it (ui/home.js).
 *
 * The hold is what tells a drag from a scroll. The list scrolls under a finger
 * like any other, so a press only becomes a drag once it has stayed put for
 * HOLD_MS - moving first is a scroll, and the browser has it. Once lifted, the
 * list's own scrolling is held off for the rest of the touch (a non-passive
 * touchmove that says no), and the list scrolls itself instead when the item is
 * carried to its top or bottom edge - or past them, over whatever holds still
 * above the list, which scrolls it as fast as it goes.
 *
 * What the finger carries is a copy of the item, drawn over the whole page.
 * The list is a scroll box, and a scroll box clips what is inside it: the item
 * itself, carried up over the page's head, went under the head with the cards
 * it was being carried past. The copy is not in the list, so nothing clips it,
 * and it goes over the head while the list goes on reordering underneath. The
 * item stays where it was in the list, unseen, holding its own place open -
 * and holding the pointer, since a node taken out of the page loses the
 * pointer it was holding and the release then lands nowhere.
 *
 * The item really moves in the list as it is carried: each time the copy's
 * centre crosses a neighbour's, the neighbours go before or after the item,
 * the browser lays the list out again, and the neighbours that moved slide
 * from where they were to where they now are. Leaving the layout to the
 * browser is what lets items of different heights, and a list laid out as a
 * grid of several columns on a wide screen, reorder without any of it being
 * worked out here.
 *
 * Crossing is measured against the neighbour's centre and not its edge, which
 * is what keeps two items of different heights from swapping back and forth:
 * once the swap is made, the tall one's centre is well behind the finger, and
 * going back means moving back past it.
 *
 * A release that lifted anything never clicks what it was released on - the
 * press was a hold, not a tap - and the order is only handed back when it
 * changed. With motion reduced nothing rocks or slides, and everything still
 * moves.
 */

import { prefersReducedMotion } from "./motion.js";

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

/** How long the copy takes to settle into the item's place once let go. */
const DROP_MS = 220;

/**
 * How far the others rock each way while one is carried, and how long one rock
 * there and back takes. A phone's home screen rocks its icons a degree or two,
 * but an icon is a fingertip wide and a card is the screen's width: the same
 * angle swings a card's corners five or six pixels, which is a card falling
 * over rather than a card ready to move. Under a degree moves them two or three.
 */
const ROCK_DEG = 0.7;
const ROCK_MS = 280;

/** How long a rocking item takes to come to rest when the carry ends. */
const REST_MS = 120;

/** motion.css's --ease-out, for the settle the frames drive themselves. */
const easeOut = cubicBezier(0.22, 0.75, 0.28, 1);

/**
 * Let the items of a list be put in order by hand.
 *
 * @param {HTMLElement} list The list itself: the scroll box, and the parent of
 *   the items. Its `position` must make it the items' offset parent.
 * @param {object} options
 * @param {string} options.items What an item is, as a selector.
 * @param {string} [options.ignore] What a hold may not start on.
 * @param {(item:HTMLElement) => boolean} [options.canStart] Whether this item
 *   can be lifted now - and so whether it rocks while another is carried.
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
  const rocking = new WeakMap();

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
  // past the list's edge, or over the page's head above it - and the release
  // has to be heard wherever it lands, or the item is left lifted for good.
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
      key: item.dataset.key,
      copy: copyOf(item, box),
      pointerId,
      startX: x,
      startY: y,
      x,
      y,
      origin: { x: box.left, y: box.top },
      size: { width: box.width, height: box.height },
      single: oneColumn(),
      order: keysOf(),
      // Read before anything rocks: a turned card's corners stick out past
      // its box, and the browser counts that into how far the list scrolls.
      scrollLimit: Math.max(0, list.scrollHeight - list.clientHeight),
      rockers: [],
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
    // Chrome keeps the node it has anchored a scroll box's position to where
    // it was on screen when the layout around it changes, and the node it picks
    // is the item: so every place the item moved up, the list scrolled up a
    // place to keep it where it was, the copy passed another card, and the
    // list ran itself to the top. The list's scrolling is this script's until
    // the copy has landed.
    list.style.overflowAnchor = "none";
    // The copy goes up in the same frame the item goes out, so nothing blinks.
    document.body.append(drag.copy);
    item.classList.add("is-held");
    // Laid out where it starts before it is told to lift, or the lift has no
    // before to grow from and lands in one frame.
    void drag.copy.offsetWidth;
    drag.copy.classList.add("is-lifted");
    drag.rockers = itemsOf().filter((node) => node !== item && canStart(node));
    if (!prefersReducedMotion()) for (const node of drag.rockers) rock(node);
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

  /**
   * The copy the finger carries: the item as it stands, at the spot it stands
   * on, fixed to the screen and over everything on it. Nothing in it can be
   * pressed or read out, and none of its ids are left to be found twice.
   */
  function copyOf(item, box) {
    const copy = item.cloneNode(true);
    copy.removeAttribute("data-key");
    for (const node of [copy, ...copy.querySelectorAll("[id]")]) node.removeAttribute("id");
    copy.setAttribute("aria-hidden", "true");
    copy.inert = true;
    copy.classList.add("is-carried");
    Object.assign(copy.style, {
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
    return copy;
  }

  /** Draw the copy at the finger: across too, where the list has columns. */
  function follow() {
    const dx = drag.single ? 0 : drag.x - drag.startX;
    const dy = drag.y - drag.startY;
    place(drag.copy, dx, dy);
  }

  /**
   * Carried to the top or bottom of the list, the list scrolls to meet it -
   * as far as the list goes and no further. Carried past the top, over the
   * head above the list, it scrolls at its fastest, and the item's place keeps
   * moving up the list underneath.
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

  /**
   * Where the item belongs now: after every other item the copy's centre has
   * passed. An item in a row above is passed; in a row below, not; in its own
   * row, by the centre - up and down in one column, across in several. Items
   * scrolled up under the head are rows above, so a copy held over the head
   * passes fewer of them as the list scrolls down to meet it.
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
    // The others it has passed go across it, rather than it going past them,
    // so the item never leaves the page and never lets go of the pointer.
    step(others, () => {
      if (passed > at) {
        // Carried down past these: each goes over to before it, in order.
        for (const node of others.slice(at, passed)) item.before(node);
      } else {
        // Carried up past these: each goes over to after it, the nearest last.
        for (const node of others.slice(passed, at).reverse()) item.after(node);
      }
    });
  }

  /**
   * Put the others where the item's new place has them, and slide each from
   * where it was drawn to where it now is. From where it was DRAWN, so a
   * neighbour still sliding from the last step carries on from where it got
   * to rather than jumping back to start the next one. The slide is on
   * `transform` and the rock on `rotate`, so one never stops the other.
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

  /**
   * Rock an item to and fro, as a phone's home screen does its icons while one
   * is being moved. Each starts level, a beat apart, one way or the other, at
   * its own pace, so the list never rocks as one block.
   */
  function rock(node) {
    rocking.get(node)?.cancel();
    const lean = (Math.random() < 0.5 ? 1 : -1) * ROCK_DEG;
    const swing = node.animate(
      [
        { rotate: "0deg", easing: "ease-out" },
        { rotate: `${lean}deg`, easing: "ease-in" },
        { rotate: "0deg", easing: "ease-out" },
        { rotate: `${-lean}deg`, easing: "ease-in" },
        { rotate: "0deg" },
      ],
      {
        duration: ROCK_MS * (0.9 + Math.random() * 0.2),
        delay: Math.random() * 90,
        iterations: Infinity,
      },
    );
    rocking.set(node, swing);
  }

  /** And back to rest: from wherever the rock had got to, not with a jump. */
  function rest(node) {
    const swing = rocking.get(node);
    if (!swing) return;
    const at = getComputedStyle(node).rotate;
    swing.cancel();
    rocking.delete(node);
    if (!node.isConnected || !at || at === "none" || parseFloat(at) === 0) return;
    const settle = node.animate([{ rotate: at }, { rotate: "0deg" }], {
      duration: REST_MS,
      easing: "ease-out",
    });
    rocking.set(node, settle);
    settle.finished.then(
      () => rocking.get(node) === settle && rocking.delete(node),
      () => {},
    );
  }

  /** Let go: the copy settles into the item's place, and the new order goes back. */
  function drop() {
    const { item, key, copy, pointerId, order, raf, rockers, origin } = drag;
    const from = {
      x: origin.x + (drag.single ? 0 : drag.x - drag.startX),
      y: origin.y + (drag.y - drag.startY),
    };
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

    for (const node of rockers) rest(node);
    settle({ item, key, copy, origin, from });

    const now = keysOf();
    if (now.join("\n") !== order.join("\n")) onDrop(now);
    onEnd();
  }

  /**
   * The copy goes from where it was let go to the item's place, shrinking back
   * to size on the way, and the item shows again under it as it lands. Driven
   * a frame at a time because the place can move while it goes: a place let go
   * of under the head is scrolled out into the open first, on the same curve,
   * and a render the carry held back may land meanwhile and put a new node
   * where the item was.
   */
  function settle({ item, key, copy, origin, from }) {
    settling += 1;
    const live = () =>
      item.isConnected ? item : (itemsOf().find((node) => node.dataset.key === key) ?? null);
    const scrollFrom = list.scrollTop;
    const scrollTo = scrollToShow(item);
    const done = () => {
      copy.remove();
      item.classList.remove("is-held");
      live()?.classList.remove("is-held");
      settling -= 1;
      if (drag || settling > 0) return;
      list.classList.remove("is-reordering");
      list.style.removeProperty("overflow-anchor");
    };
    copy.classList.remove("is-lifted");
    if (prefersReducedMotion()) {
      list.scrollTop = scrollTo;
      done();
      return;
    }
    copy.classList.add("is-dropping");
    let target = { x: from.x, y: from.y };
    const start = performance.now();
    const frame = (now) => {
      const t = Math.min(1, (now - start) / DROP_MS);
      const eased = easeOut(t);
      if (scrollTo !== scrollFrom) list.scrollTop = scrollFrom + (scrollTo - scrollFrom) * eased;
      const node = live();
      if (node) {
        const box = boxOf(node);
        target = { x: box.left, y: box.top };
      }
      place(
        copy,
        from.x + (target.x - from.x) * eased - origin.x,
        from.y + (target.y - from.y) * eased - origin.y,
      );
      if (t < 1) requestAnimationFrame(frame);
      else done();
    };
    requestAnimationFrame(frame);
  }

  /** Where the list has to be scrolled to for all of the item to be seen. */
  function scrollToShow(item) {
    const frame = list.getBoundingClientRect();
    const box = boxOf(item);
    const top = frame.top + list.clientTop;
    const bottom = top + list.clientHeight;
    let to = list.scrollTop;
    if (box.top < top) to -= top - box.top;
    else if (box.bottom > bottom) to += box.bottom - bottom;
    return Math.max(0, Math.min(list.scrollHeight - list.clientHeight, to));
  }

  return { lifted: () => Boolean(drag) };
}

/** Move a carried copy by whole pixels from the spot it was put down on. */
function place(copy, dx, dy) {
  copy.style.setProperty("--lift-x", `${Math.round(dx)}px`);
  copy.style.setProperty("--lift-y", `${Math.round(dy)}px`);
}

/**
 * A CSS cubic-bézier timing function as a function of progress, for motion
 * driven a frame at a time rather than handed to the browser.
 */
function cubicBezier(x1, y1, x2, y2) {
  const along = (a, b, t) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return (x) => {
    if (x <= 0 || x >= 1) return x <= 0 ? 0 : 1;
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let i = 0; i < 24; i += 1) {
      const at = along(x1, x2, t);
      if (Math.abs(at - x) < 1e-4) break;
      if (at < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return along(y1, y2, t);
  };
}
