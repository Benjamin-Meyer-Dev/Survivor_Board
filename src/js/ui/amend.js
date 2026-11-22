/**
 * The two sheets a correction asks through (core/amend.js).
 *
 * A played week is the pool's record, so nothing about it changes on a tap:
 * the team chosen is read back with what it costs - the result the week takes
 * on, and the later weeks that lose the team - and only a yes writes it. When
 * later weeks did lose their team, the second sheet lists them and takes the
 * person to each in turn; app.js brings it back after every lock until none
 * are left.
 *
 * Both wear the home page's confirm sheet (components.css, .home__sheet), the
 * board having no sheet of its own that asks a question.
 */
import { escapeHtml } from "../core/format.js";
import { closeDialog, keepOpen } from "./motion.js";

const CLOSE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>`;

/** The one dialog both sheets are drawn into, made on first use. */
let sheet = null;
/** How the sheet in hand answers when it is closed without a choice. */
let settle = null;

function dialog() {
  if (sheet?.isConnected) return sheet;
  sheet = document.createElement("dialog");
  sheet.className = "home__sheet home__sheet--confirm amend";
  sheet.setAttribute("aria-labelledby", "amend-title");
  sheet.tabIndex = -1;
  // Escape and the cross both come through here.
  sheet.addEventListener("close", () => {
    const done = settle;
    settle = null;
    done?.(null);
  });
  document.body.append(sheet);
  return sheet;
}

/**
 * Put away whichever sheet is up, answering it "no", because the board it was
 * asked about is going. The sheet lives on the body rather than on the board,
 * so nothing else takes it down: one left up across a league change used to
 * take its yes to the next board and lock the first one's team into it.
 */
export function dismissAmend() {
  if (!sheet?.open) return;
  closeDialog(sheet, { now: true });
}

/** Fill the sheet, open it, and resolve with the button's value or null. */
function ask(markup) {
  const root = dialog();
  // A sheet already up answers "no" before it is replaced.
  settle?.(null);
  keepOpen(root);
  root.innerHTML = markup;
  return new Promise((resolve) => {
    settle = resolve;
    root.querySelector("[data-close]")?.addEventListener("click", () => closeDialog(root));
    for (const button of root.querySelectorAll("[data-answer]")) {
      button.addEventListener("click", () => {
        if (settle !== resolve) return;
        settle = null;
        resolve(button.dataset.answer);
        closeDialog(root);
      });
    }
    if (!root.open) root.showModal();
    root.focus();
  });
}

function head(title) {
  return `<div class="home__sheet-head">
      <h3 class="home__sheet-title" id="amend-title">${escapeHtml(title)}</h3>
      <button type="button" class="home__icon home__sheet-close" data-close aria-label="Close">${CLOSE}</button>
    </div>`;
}

/** "week 6", "weeks 6 and 9", "weeks 6, 9 and 11". */
function weeksPhrase(weeks) {
  const unique = [...new Set(weeks)].sort((a, b) => a - b);
  if (unique.length === 1) return `week ${unique[0]}`;
  return `weeks ${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`;
}

/**
 * Ask before a correction is written.
 *
 * @param {{week:number, team:string, result:"W"|"L"|null, replacing:string|null,
 *   displaced:Array<{week:number, locked:boolean}>}} change
 * @returns {Promise<boolean>} Whether to write it.
 */
export async function confirmAmend({ week, team, result, replacing, displaced }) {
  const name = `<strong>${escapeHtml(team)}</strong>`;
  const what = replacing
    ? `Swap the <strong>${escapeHtml(replacing)}</strong> for the ${name} in week ${week}.`
    : `Lock in the ${name} for week ${week}.`;
  const outcome =
    result === "W"
      ? " The game is final, so the week goes down as a win."
      : result === "L"
        ? " The game is final, so the week goes down as a loss."
        : "";
  const later = displaced.length
    ? `<p class="home__confirm-ask amend__warn">The ${name} are already ${
        displaced.every((gone) => gone.locked) ? "locked in" : "picked"
      } for ${weeksPhrase(displaced.map((gone) => gone.week))}. A team is only used once, so ${
        displaced.length === 1 ? "that week loses them and needs" : "those weeks lose them and need"
      } a new pick.</p>`
    : "";
  const answer =
    await ask(`${head(replacing ? `Change week ${week}'s pick?` : `Record week ${week}'s pick?`)}
    <div class="home__form">
      <p class="home__confirm-ask">${what}${outcome}</p>
      ${later}
      <div class="home__confirm-row">
        <button type="button" class="home__btn home__btn--go" data-answer="yes">Yes, ${
          replacing ? "change it" : "record it"
        }</button>
        <button type="button" class="home__btn home__btn--quiet" data-answer="no">Cancel</button>
      </div>
    </div>`);
  return answer === "yes";
}

/**
 * The later weeks a correction emptied, each a way to it.
 *
 * @param {Array<{week:number, slot:number, team:string}>} weeks
 * @param {number} slots The most picks any week of the pool takes, so a
 *   two-pick week can say which of its slots.
 * @returns {Promise<{week:number, slot:number}|null>} The one chosen, or null
 *   for later.
 */
export async function chooseRepair(weeks, slots = 1) {
  const n = weeks.length;
  const rows = weeks
    .map(
      (gone, index) =>
        `<button type="button" class="home__btn amend__week" data-answer="${index}">
          <span>Week ${gone.week}${slots > 1 ? ` · pick ${gone.slot + 1}` : ""}</span>
          <span class="amend__was">was the ${escapeHtml(gone.team)}</span>
        </button>`,
    )
    .join("");
  const answer =
    await ask(`${head(`${n} week${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} a new pick`)}
    <div class="home__form">
      <p class="home__confirm-ask">The correction took ${
        n === 1 ? "this week's team" : "these weeks' teams"
      }. Pick ${n === 1 ? "it" : "each"} again before the pool plays on.</p>
      <div class="amend__weeks">${rows}</div>
      <div class="home__confirm-row">
        <button type="button" class="home__btn home__btn--quiet" data-answer="later">Later</button>
      </div>
    </div>`);
  if (answer === null || answer === "later") return null;
  return weeks[Number(answer)] ?? null;
}
