/**
 * A league's own sheet: its name, its code, and the rules it runs on.
 *
 * The gear beside the league picker opens a modal `<dialog>` holding
 * everything about a league that is not a pick. The code and the link to join
 * by are at the top, because handing those out is the most common reason to
 * open it, and the name is edited in place there; taking the pool or the
 * league down sits with them, since all three are about the league itself
 * rather than about how it is played. Those stay put. Only the rules scroll -
 * which weeks of the season it runs over, how many picks a week, how many buy
 * backs, and which weeks a buy back can cover. Native dialog, so the focus
 * trap, the backdrop, Esc and the top layer are the platform's rather than
 * three hundred lines of ours.
 *
 * Edits are a draft until Save. Changing a rule re-plans the season - a beam
 * search over every remaining week - so committing on each tap would run it
 * five times while someone made up their mind, and every run blocks the main
 * thread. The draft also makes Cancel mean something.
 *
 * The rules are shared, not per-device: they are a property of the pool, so
 * Save writes them into the same entry the picks live in and the other phone
 * repaints with them. Which is also why this sheet is write-gated exactly like
 * a lock - a read-only device can read the rules and change nothing.
 *
 * Built ONCE and updated in place, like the tab bar and the pool picker: this
 * runs on every board render, and replacing the markup under an open dialog
 * would close it. A render while the sheet is open leaves the draft alone; the
 * fields are refreshed from the board only when it is shut.
 *
 * Rendering only: app.js owns the save.
 */

import {
  MAX_PICKS_PER_WEEK,
  MAX_BUY_BACKS,
  mergeRules,
  sameRules,
  onlyEditable,
  coverWeeks,
} from "../core/rules.js";
import { formatCode, joinLink } from "../core/code.js";
import { escapeHtml } from "../core/format.js";
import { POOL_KINDS } from "../sports.js";

/** Latest handlers and board, so the listeners bound on the first render stay current. */
let onSaveRules = () => {};
let onRenameLeague = () => {};
let current = null;
/** The rules being edited. Null while the sheet is shut. */
let draft = null;
/** Which take-down - "remove" or "delete" - is waiting on its second tap. */
let danger = null;

/* A cog with teeth, filled, so it reads as settings and not as a sun. */
const GEAR_ICON = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
  </svg>`;

/* The copy icon set into the code's box, and what it turns into for a moment. */
const COPY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>`;
const DONE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20 6-11 11-5-5" /></svg>`;
/* The cross in the sheet's corner; a copy that failed wears the same one. */
const CLOSE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>`;
const FAILED_ICON = CLOSE_ICON;

/**
 * @param {HTMLElement} root
 * @param {object|null} board Result of buildBoard(), or null on the home page,
 *   where there is no league open and so nothing for the gear to hold.
 * @param {object} handlers
 * @param {boolean} handlers.canWrite
 * @param {(rules:object|null) => void} handlers.onSave The rules to store, or
 *   null to go back to the ones the season ships.
 * @param {{code:string, name:string, kinds?:string[]}} [handlers.league] The
 *   open league, for its code and its name.
 * @param {string|null} [handlers.kind] Which of the league's pools the board
 *   is showing, as a kind id; the rules in the sheet are that pool's.
 * @param {(name:string) => void} [handlers.onRename]
 * @param {(kind:string) => void} [handlers.onRemovePool] Take one pool out of
 *   the league, for everyone in it. Asked for twice here before it is called.
 * @param {(code:string) => void} [handlers.onDeleteLeague] Take the league
 *   down, for everyone in it. Likewise asked for twice.
 */
export function renderSettings(
  root,
  board,
  { canWrite, onSave, league = null, kind = null, onRename, onRemovePool, onDeleteLeague },
) {
  if (!root) return;
  onSaveRules = onSave;
  onRenameLeague = onRename ?? (() => {});
  current = {
    board,
    canWrite,
    league,
    kind,
    onRemovePool: onRemovePool ?? (() => {}),
    onDeleteLeague: onDeleteLeague ?? (() => {}),
  };

  if (!root.firstElementChild) buildSheet(root);

  const dialog = root.querySelector(".settings");
  const button = root.querySelector(".settings__open");

  // No league, no rules to hold: the home page has its own controls, and a
  // gear there would open a sheet about nothing.
  button.hidden = !board;
  if (!board) {
    if (dialog.open) dialog.close();
    return;
  }

  button.classList.toggle("settings__open--custom", Boolean(board.rulesCustom));
  button.title = board.rulesCustom ? "Pool rules (changed from the plan)" : "Pool rules";

  // The name and the code are the league's; the rules in the sheet are one
  // pool's, and the title says which - and so whether its picks win or lose,
  // now that the sheet no longer asks. On every render rather than in paint:
  // the sheet is built once, and a switch to the league's other pool would
  // otherwise leave the old pool in the title until it opened.
  const pool = POOL_KINDS[kind];
  root.querySelector(".settings__title").textContent = pool ? `League · ${pool.label}` : "League";

  // Mid-edit: the draft is the truth on screen, and a board arriving from
  // another device must not pull the fields out from under the person typing.
  if (dialog.open) return;
  draft = null;
}

function buildSheet(root) {
  root.innerHTML = `
    <button type="button" class="settings__open" aria-haspopup="dialog" aria-label="Pool rules">
      ${GEAR_ICON}
    </button>
    <dialog class="settings" aria-labelledby="settings-title" tabindex="-1" autofocus>
      <form class="settings__form" method="dialog">
        <div class="settings__head">
          <div class="settings__head-row">
            <h2 class="settings__title" id="settings-title">League</h2>
            <button type="button" class="settings__close" aria-label="Close">${CLOSE_ICON}</button>
          </div>
          <label class="settings__label" for="settings-name">Name</label>
          <input class="settings__input settings__name" id="settings-name" type="text" maxlength="60"
                 autocomplete="off" placeholder="Name the league"
                 title="Tap to rename. Enter, or tapping away, saves it" />
          <p class="settings__label" id="settings-code-label">Code to join</p>
          <div class="settings__code-box">
            <code class="settings__code" aria-labelledby="settings-code-label"></code>
            <button type="button" class="settings__copy" aria-label="Copy the link to join"
                    title="Copy the link to join">${COPY_ICON}</button>
          </div>
          <p class="settings__pool" hidden>
            Read-only on this device: the rules can be read here and not changed.
          </p>
          <div class="settings__take"></div>
        </div>
        <div class="settings__body"></div>
        <div class="settings__foot">
          <button type="button" class="settings__btn settings__btn--quiet settings__cancel">Cancel</button>
          <button type="button" class="settings__btn settings__btn--go settings__save">Save rules</button>
        </div>
      </form>
    </dialog>`;

  const dialog = root.querySelector(".settings");
  const form = root.querySelector(".settings__form");
  const name = root.querySelector(".settings__name");

  // The name is edited in place: tapping away saves it, and a blank or
  // unchanged field puts the stored name back. Enter blurs the field, which
  // saves it the same way; left alone it would submit the form, and a form on
  // a dialog closes it.
  name.addEventListener("change", () => {
    const typed = name.value.trim();
    if (!typed || typed === current.league?.name) {
      name.value = current.league?.name ?? "";
      return;
    }
    onRenameLeague(typed);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (document.activeElement === name) name.blur();
  });

  // The link to join, on the clipboard, and the icon says so for a moment: a
  // tick, or a cross when the browser refused - an insecure origin, or a
  // permission declined. The code is on screen either way, which is the part
  // anyone actually needs.
  root.querySelector(".settings__copy").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    let state = "done";
    try {
      await navigator.clipboard.writeText(joinLink(current.league.code));
    } catch {
      state = "failed";
    }
    button.innerHTML = state === "done" ? DONE_ICON : FAILED_ICON;
    button.classList.add(`settings__copy--${state}`);
    button.title = state === "done" ? "Link copied" : "Copy failed";
    setTimeout(() => {
      button.innerHTML = COPY_ICON;
      button.classList.remove(`settings__copy--${state}`);
      button.title = "Copy the link to join";
    }, 1800);
  });

  root.querySelector(".settings__open").addEventListener("click", () => {
    draft = onlyEditable(current.board.rules);
    danger = null;
    paint(root);
    dialog.showModal();
    // The sheet itself takes focus, not the name field: a field focused on
    // open brings the keyboard up on a phone before the sheet has been read.
    dialog.focus();
  });

  // Two ways out that keep nothing: the cross in the corner, for a thumb that
  // is still at the top of the sheet, and Cancel at the foot beside Save.
  for (const out of root.querySelectorAll(".settings__close, .settings__cancel")) {
    out.addEventListener("click", () => {
      draft = null;
      dialog.close();
    });
  }

  root.querySelector(".settings__save").addEventListener("click", () => {
    const next = draft;
    draft = null;
    dialog.close();
    if (!next) return;
    // Back to exactly what the plan ships: store nothing, so the pool follows
    // the file again and a later re-plan of it reaches this board.
    onSaveRules(sameRules(next, current.board.ruleDefaults) ? null : next);
  });

  // One listener for every control in the sheet: they are rebuilt on each
  // paint, so binding per control would leak a listener per keystroke. On the
  // form rather than on the body, because the take-down buttons live in the
  // pinned head and the rules in the part that scrolls, and both are rebuilt
  // by the same paint.
  form.addEventListener("click", (event) => {
    const take = event.target.closest("[data-danger]");
    if (take) {
      takeDown(root, dialog, take.dataset.danger);
      return;
    }
    const control = event.target.closest("[data-rule]");
    if (!control || !draft) return;
    const { rule, value } = control.dataset;

    if (rule === "buyBackWeeks") {
      const week = Number(value);
      const weeks = new Set(draft.buyBackWeeks);
      if (weeks.has(week)) weeks.delete(week);
      else weeks.add(week);
      draft.buyBackWeeks = [...weeks];
    } else {
      draft[rule] = Number(value);
    }

    // The count comes first and the weeks follow it: the weeks are only shown
    // once there is a buy back to cover one, so a count stepped past the weeks
    // chosen lights the earliest open weeks of the run to hold it, and the
    // pills show which. Without this a pool granting none, with no weeks lit,
    // could never be given one - the clamp below would put it straight back.
    if (rule === "buyBacks") {
      draft.buyBackWeeks = coverWeeks(draft, current.board.seasonWeeks);
    }

    // One rule bounds the next - the run of weeks decides which of them a buy
    // back can cover, and those decide how many buy backs there can be - so
    // the draft goes back through the model's own clamps rather than through a
    // second set of them written out here. A week dropped by a narrowed run is
    // dropped for good, and so is a count left with no week to spend itself in:
    // the pills and the number show what is left, so nothing is hidden.
    draft = onlyEditable(mergeRules(draft, draft, current.board.seasonWeeks));

    paint(root, control);
  });

  // A tap outside the sheet, which on a modal dialog lands on the dialog
  // element itself rather than on anything inside it. Closing on that is what
  // every other sheet on a phone does.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });

  // Esc, the backdrop, the cross and Cancel all end up here.
  dialog.addEventListener("close", () => {
    draft = null;
    danger = null;
  });
}

/**
 * Removing a pool and deleting the league, each in two taps: the first turns
 * the button into a question, the second acts and shuts the sheet. Either is
 * for everyone in the league, which is why a question is asked at all - and
 * asked in place, in the sheet's own words, rather than in a browser dialog
 * that would look like nothing else on the board.
 */
function takeDown(root, dialog, step) {
  const { league, kind } = current;
  switch (step) {
    case "remove":
    case "delete":
      danger = step;
      paint(root);
      break;
    case "cancel":
      danger = null;
      paint(root);
      break;
    case "confirm-remove":
      danger = null;
      draft = null;
      dialog.close();
      current.onRemovePool(kind);
      break;
    case "confirm-delete":
      danger = null;
      draft = null;
      dialog.close();
      current.onDeleteLeague(league?.code);
      break;
    default:
      break;
  }
}

/**
 * Taking a pool out of the league, and taking the league down. Pinned in the
 * head with the name and the code, because all three are about the league
 * rather than about how it is played, and because a button that ends a league
 * for everyone in it should not be something you have to go looking for at the
 * bottom of a scroll. The last pool cannot go on its own - a league with no
 * board is nothing to open - so that button waits for the league to be deleted
 * instead, and says so on itself rather than in a line under the pair.
 */
function takeDownMarkup() {
  const { league, kind } = current;
  const pool = POOL_KINDS[kind];
  const name = league?.name ?? "this league";
  const last = (league?.kinds?.length ?? 1) <= 1;

  if (danger === "remove" && pool) {
    return `
    <div class="settings__danger">
      <p class="settings__danger-ask">
        Remove ${escapeHtml(pool.label)} from ${escapeHtml(name)} for everyone in it? Its
        board, and every pick on it, goes with it.
      </p>
      <div class="settings__danger-row">
        <button type="button" class="settings__btn settings__btn--danger"
                data-danger="confirm-remove">Yes, remove ${escapeHtml(pool.label)}</button>
        <button type="button" class="settings__btn settings__btn--quiet"
                data-danger="cancel">Keep it</button>
      </div>
    </div>`;
  }

  if (danger === "delete") {
    return `
    <div class="settings__danger">
      <p class="settings__danger-ask">
        Delete ${escapeHtml(name)} for everyone in it? Every pool and every pick goes
        with it, and its code stops working.
      </p>
      <div class="settings__danger-row">
        <button type="button" class="settings__btn settings__btn--danger"
                data-danger="confirm-delete">Yes, delete the league</button>
        <button type="button" class="settings__btn settings__btn--quiet"
                data-danger="cancel">Keep it</button>
      </div>
    </div>`;
  }

  return `
    <div class="settings__danger">
      <div class="settings__danger-row">
        <button type="button" class="settings__btn settings__btn--quiet" data-danger="remove"
                ${last || !pool ? "disabled" : ""}
                title="${last ? "A league keeps its last pool: deleting the league is what takes it down" : `Remove ${escapeHtml(pool?.label ?? "this pool")} from the league, for everyone in it`}"
                >Remove ${escapeHtml(pool?.label ?? "this pool")}</button>
        <button type="button" class="settings__btn settings__btn--danger" data-danger="delete"
                title="Delete the league for everyone in it">Delete league</button>
      </div>
    </div>`;
}

/**
 * The sheet's fields, from the draft.
 *
 * The body is rebuilt rather than reconciled - three groups of controls is
 * not enough DOM to be worth diffing - so `keep` is the control that was just
 * used, and focus is put back on its replacement afterwards. Without it a
 * keyboard or switch user stepping picks a week up would find their focus
 * back at the top of the document, and every subsequent choice would need the
 * sheet navigated again from the start.
 */
function paint(root, keep = null) {
  const { board, canWrite, league } = current;

  const name = root.querySelector(".settings__name");
  // Not while it is being typed in: a render landing between keystrokes would
  // put the stored name back and take the edit with it.
  if (document.activeElement !== name) name.value = league?.name ?? "";
  name.disabled = !canWrite;
  root.querySelector(".settings__code").textContent = league
    ? formatCode(league.code)
    : "not shared";
  root.querySelector(".settings__copy").disabled = !league;
  root.querySelector(".settings__pool").hidden = canWrite;

  const rules = draft ?? onlyEditable(board.rules);
  // The whole calendar, and the run of it this pool plays. The run is the
  // draft's rather than the board's, so the weeks on offer follow the start
  // and end being chosen instead of the ones last saved.
  const season = board.seasonWeeks;
  const weeks = season.filter((week) => week >= rules.startWeek && week <= rules.endWeek);
  // As many buy backs as the run has weeks to spend them in: stepping the
  // count up lights weeks as it goes, so the weeks already chosen are not the
  // ceiling here the way they are in the model.
  const maxBuyBacks = Math.min(MAX_BUY_BACKS, weeks.length);

  // No control for what a pick has to do: that is the kind of pool this is,
  // fixed when the league was made and named in the title above.
  root.querySelector(".settings__body").innerHTML = `
    ${group({
      legend: "Start week",
      controls: stepper("startWeek", rules.startWeek, {
        min: season[0] ?? rules.startWeek,
        max: rules.endWeek,
      }),
    })}

    ${group({
      legend: "End week",
      controls: stepper("endWeek", rules.endWeek, {
        min: rules.startWeek,
        max: season.at(-1) ?? rules.endWeek,
      }),
    })}

    ${group({
      legend: "Picks a week",
      controls: stepper("picksPerWeek", rules.picksPerWeek, {
        min: 1,
        max: maxPicksPerWeek(weeks.length, board.totalTeams),
      }),
    })}

    ${group({
      legend: "Buy backs",
      controls: stepper("buyBacks", rules.buyBacks, { min: 0, max: maxBuyBacks }),
    })}

    ${
      // Which weeks a buy back can cover is a question only once there is one:
      // a pool that grants none has nothing to put in the row, and an empty
      // row of pills reads as a rule left unset rather than as one that does
      // not apply.
      rules.buyBacks > 0
        ? group({
            legend: "Buy Back Weeks",
            stack: true,
            controls: `<div class="settings__weeks">
        ${weeks
          .map(
            (week) => `
          <button type="button" class="settings__week" data-rule="buyBackWeeks"
                  data-value="${week}"
                  aria-pressed="${rules.buyBackWeeks.includes(week)}">${week}</button>`,
          )
          .join("")}
      </div>`,
          })
        : ""
    }`;

  root.querySelector(".settings__take").innerHTML = takeDownMarkup();

  for (const control of root.querySelectorAll(".settings__body [data-rule]")) {
    if (!canWrite) control.disabled = true;
  }
  // Read-only devices can read what the league runs and change none of it,
  // and that includes taking any of it down.
  for (const button of root.querySelectorAll(".settings__take [data-danger]")) {
    if (!canWrite) button.disabled = true;
  }
  root.querySelector(".settings__save").disabled = !canWrite;

  if (!keep) return;
  const { rule, value, step } = keep.dataset;
  // The same control: for a step, the one going the same way, unless it has
  // just run out of room, in which case the other; for a week, the same week.
  // Named for what they are rather than "group", which is the markup helper
  // this function calls: a const of that name here shadows it for the whole
  // of paint, and the fields would never be built at all.
  const siblings = [...root.querySelectorAll(`.settings__body [data-rule="${rule}"]`)];
  const same = step
    ? siblings.find((control) => control.dataset.step === step && !control.disabled)
    : siblings.find((control) => control.dataset.value === value);
  (same ?? siblings.find((control) => !control.disabled) ?? siblings.at(-1))?.focus();
}

/**
 * The most picks a week this pool has teams for.
 *
 * No team twice is the one rule that is not negotiable here, so a pool taking
 * more picks than it has teams to spend runs out before its run does: the last
 * weeks hold fewer picks than the rules ask for and the season probability
 * collapses. So the step simply stops there. Eighteen NFL weeks at two a week
 * needs thirty-six teams and the league has thirty-two - which is why a full
 * NFL season takes one a week, and why shortening the run is what makes room
 * for two.
 */
function maxPicksPerWeek(weeks, totalTeams) {
  if (!totalTeams || !weeks) return MAX_PICKS_PER_WEEK;
  return Math.max(1, Math.min(MAX_PICKS_PER_WEEK, Math.floor(totalTeams / weeks)));
}

/**
 * One rule: its name and its control beside it. A group that needs the width -
 * the weeks - stacks instead.
 */
function group({ legend, controls, stack = false }) {
  return `
    <div class="settings__group${stack ? " settings__group--stack" : ""}" role="group"
         aria-label="${escapeHtml(legend)}">
      <span class="settings__legend">${escapeHtml(legend)}</span>
      <div class="settings__control">${controls}</div>
    </div>`;
}

/**
 * A count with a step either side, like a scoreboard: the number, large, and
 * a minus and a plus that go grey at the ends of the range. A zero is shown
 * as one, like every other count on a board.
 */
function stepper(rule, value, { min, max }) {
  const shown = String(value);
  const step = (to, direction, words) => `
        <button type="button" class="settings__step" data-rule="${rule}" data-step="${direction}"
                data-value="${to}" aria-label="${escapeHtml(words)}"
                ${to < min || to > max ? "disabled" : ""}>${direction === "down" ? "−" : "+"}</button>`;
  return `
    <div class="settings__stepper">
      ${step(value - 1, "down", "Fewer")}
      <output class="settings__count" aria-live="polite">${escapeHtml(shown)}</output>
      ${step(value + 1, "up", "More")}
    </div>`;
}
