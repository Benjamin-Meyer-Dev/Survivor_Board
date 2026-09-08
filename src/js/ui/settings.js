/**
 * A league's own sheet: its name, its code, and the rules it runs on.
 *
 * The gear beside the league picker opens a modal `<dialog>` holding
 * everything about a league that is not a pick. The code and the link to join
 * by are at the top, because handing those out is the most common reason to
 * open it; the four rules a league can change are below - whether a pick has
 * to win or lose, how many picks a week, how many buy backs, and which weeks a
 * buy back can cover. Native dialog, so the focus trap, the backdrop, Esc and
 * the top layer are the platform's rather than three hundred lines of ours.
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

import { MAX_PICKS_PER_WEEK, MAX_BUY_BACKS, sameRules, onlyEditable } from "../core/rules.js";
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
    <dialog class="settings" aria-labelledby="settings-title">
      <form class="settings__form" method="dialog">
        <div class="settings__head">
          <h2 class="settings__title" id="settings-title">League</h2>
          <label class="settings__label" for="settings-name">Name</label>
          <div class="settings__rename">
            <input class="settings__input" id="settings-name" type="text" maxlength="60"
                   autocomplete="off" />
            <button type="button" class="settings__btn settings__rename-go">Rename</button>
          </div>
          <p class="settings__label">Code to join</p>
          <div class="settings__share">
            <code class="settings__code"></code>
            <button type="button" class="settings__btn settings__copy">Copy link</button>
          </div>
          <p class="settings__pool"></p>
        </div>
        <div class="settings__body"></div>
        <div class="settings__foot">
          <button type="button" class="settings__btn settings__btn--quiet settings__reset">Back to the plan</button>
          <div class="settings__actions">
            <button type="button" class="settings__btn settings__btn--quiet settings__cancel">Cancel</button>
            <button type="button" class="settings__btn settings__btn--go settings__save">Save rules</button>
          </div>
        </div>
      </form>
    </dialog>`;

  const dialog = root.querySelector(".settings");
  const body = root.querySelector(".settings__body");

  root.querySelector(".settings__rename-go").addEventListener("click", () => {
    const typed = root.querySelector(".settings__input").value.trim();
    if (!typed || typed === current.league?.name) return;
    onRenameLeague(typed);
  });

  root.querySelector(".settings__copy").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await navigator.clipboard.writeText(joinLink(current.league.code));
      button.textContent = "Link copied";
    } catch {
      // Refused by the browser - an insecure origin, or a permission prompt
      // declined. The code is on screen either way, which is the part anyone
      // actually needs.
      button.textContent = "Copy failed";
    }
    setTimeout(() => {
      button.textContent = "Copy link";
    }, 1800);
  });

  root.querySelector(".settings__open").addEventListener("click", () => {
    draft = onlyEditable(current.board.rules);
    danger = null;
    paint(root);
    dialog.showModal();
  });

  root.querySelector(".settings__cancel").addEventListener("click", () => {
    draft = null;
    dialog.close();
  });

  // The plan's own rules, back in the fields rather than saved from under you:
  // the sheet still has to be saved, so "back to the plan" is undoable by
  // cancelling like anything else here.
  root.querySelector(".settings__reset").addEventListener("click", () => {
    draft = onlyEditable(current.board.ruleDefaults);
    paint(root);
  });

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
  // paint, so binding per control would leak a listener per keystroke.
  body.addEventListener("click", (event) => {
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
      draft.buyBackWeeks = [...weeks].sort((a, b) => a - b);
      // The count can never exceed the weeks it has to spend itself on.
      draft.buyBacks = Math.min(draft.buyBacks, draft.buyBackWeeks.length);
    } else {
      draft[rule] = Number(value);
    }

    paint(root, control);
  });

  // A tap outside the sheet, which on a modal dialog lands on the dialog
  // element itself rather than on anything inside it. Closing on that is what
  // every other sheet on a phone does.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });

  // Esc, the backdrop and Cancel all end up here.
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
 * The foot of the body: taking a pool out of the league, and taking the league
 * down. The last pool cannot go on its own - a league with no board is nothing
 * to open - so that button waits for the league to be deleted instead.
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
                ${last || !pool ? "disabled" : ""}>Remove ${escapeHtml(pool?.label ?? "this pool")}</button>
        <button type="button" class="settings__btn settings__btn--danger"
                data-danger="delete">Delete league</button>
      </div>
      <p class="settings__hint">
        ${
          last
            ? "A league keeps its last pool: deleting the league is what takes it down."
            : "Either one is for everyone in the league, and asks once more before it acts."
        }
      </p>
    </div>`;
}

/**
 * The sheet's fields, from the draft.
 *
 * The body is rebuilt rather than reconciled - four groups of buttons is not
 * enough DOM to be worth diffing - so `keep` is the control that was just
 * used, and focus is put back on its replacement afterwards. Without it a
 * keyboard or switch user pressing "2 picks a week" would find their focus
 * back at the top of the document, and every subsequent choice would need the
 * sheet navigated again from the start.
 */
function paint(root, keep = null) {
  const { board, canWrite, league } = current;

  const name = root.querySelector(".settings__input");
  // Not while it is being typed in: a render landing between keystrokes would
  // put the stored name back and take the edit with it.
  if (document.activeElement !== name) name.value = league?.name ?? "";
  name.disabled = !canWrite;
  root.querySelector(".settings__rename-go").disabled = !canWrite;
  root.querySelector(".settings__code").textContent = league
    ? formatCode(league.code)
    : "not shared";

  const rules = draft ?? onlyEditable(board.rules);
  const weeks = board.weeks.map((week) => week.week);
  const maxBuyBacks = Math.min(MAX_BUY_BACKS, rules.buyBackWeeks.length);

  root.querySelector(".settings__pool").innerHTML = canWrite
    ? `These are the whole pool's rules: saving them changes the board on every device.
       ${board.rulesCustom ? "This pool is running its own, not the plan's." : ""}`
    : `Read-only on this device, so the rules can be read here and not changed.`;

  // No control for what a pick has to do: that is the kind of pool this is,
  // fixed when the league was made and named in the title above.
  root.querySelector(".settings__body").innerHTML = `
    ${group({
      legend: "Picks a week",
      hint: shortfallHint(rules.picksPerWeek, weeks.length, board.totalTeams),
      controls: segmented(
        "picksPerWeek",
        rules.picksPerWeek,
        Array.from({ length: MAX_PICKS_PER_WEEK }, (_, index) => ({
          value: index + 1,
          label: String(index + 1),
        })),
      ),
    })}

    ${group({
      legend: "Weeks a buy back covers",
      hint: "Tap the weeks a loss can be bought back in. The path takes more risk in them, because it can afford to.",
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
    })}

    ${group({
      legend: "Buy backs",
      hint: maxBuyBacks
        ? "How many of those weeks a loss can actually be bought back in. Spent, not refunded: the team stays burned either way."
        : "Pick the weeks a buy back can cover first.",
      controls: segmented(
        "buyBacks",
        rules.buyBacks,
        Array.from({ length: maxBuyBacks + 1 }, (_, index) => ({
          value: index,
          label: index === 0 ? "None" : String(index),
        })),
      ),
    })}

    ${takeDownMarkup()}`;

  for (const control of root.querySelectorAll(".settings__body [data-rule]")) {
    control.disabled = !canWrite;
  }
  // Read-only devices can read what the league runs and change none of it,
  // and that includes taking any of it down.
  for (const button of root.querySelectorAll(".settings__body [data-danger]")) {
    if (!canWrite) button.disabled = true;
  }
  root.querySelector(".settings__save").disabled = !canWrite;
  root.querySelector(".settings__reset").disabled = !canWrite;

  if (!keep) return;
  const { rule, value } = keep.dataset;
  // The same control, or - for a buy back count that the weeks have just taken
  // away - the nearest one still standing in that group.
  // Named for what they are rather than "group", which is the markup helper
  // this function calls: a const of that name here shadows it for the whole
  // of paint, and the fields would never be built at all.
  const siblings = [...root.querySelectorAll(`.settings__body [data-rule="${rule}"]`)];
  const same = siblings.find((control) => control.dataset.value === value);
  (same ?? siblings.at(-1))?.focus();
}

/**
 * What picks-a-week costs in teams.
 *
 * No team twice is the one rule that is not negotiable here, so a pool taking
 * more picks than it has teams to spend runs out before the season does - and
 * the board says so honestly, in weeks that hold fewer picks than the rules
 * ask for and a season probability that collapses. Better to say it here,
 * while the number is being chosen, than to leave someone to work out why
 * their path reads zero.
 */
function shortfallHint(picksPerWeek, weeks, totalTeams) {
  const needed = picksPerWeek * weeks;
  const kept =
    "Fewer picks than a week already holds hides the extra slots. Nothing saved in them is lost, and raising this again brings them back.";
  if (!totalTeams || needed <= totalTeams) return kept;
  return `${weeks} weeks at ${picksPerWeek} a week needs ${needed} teams and this pool has ${totalTeams}, so the last weeks will run short. ${kept}`;
}

function group({ legend, hint, controls }) {
  return `
    <fieldset class="settings__group">
      <legend class="settings__legend">${escapeHtml(legend)}</legend>
      ${controls}
      <p class="settings__hint">${escapeHtml(hint)}</p>
    </fieldset>`;
}

/** A row of choices, one of them on. */
function segmented(rule, active, options) {
  return `
    <div class="settings__choices">
      ${options
        .map(
          (option) => `
        <button type="button" class="settings__choice" data-rule="${rule}"
                data-value="${escapeHtml(String(option.value))}"
                aria-pressed="${String(option.value) === String(active)}"
                >${escapeHtml(option.label)}</button>`,
        )
        .join("")}
    </div>`;
}
