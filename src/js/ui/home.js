/**
 * The home page: your leagues.
 *
 * Everything a person does that is not picking a team happens here - which
 * leagues this device is in, making another, joining someone else's, and
 * handing out the code that lets them join yours.
 *
 * A league can play more than one season - an NFL pool and a college pool for
 * the same people - so making one is a matter of ticking the seasons it plays,
 * and its card opens each of its boards in turn. One code covers them all.
 *
 * A league's code is shown on its card rather than hidden behind a share
 * sheet, because the code is the whole of how anyone else gets in: it has to
 * be readable off a screenshot and repeatable down a phone line, and Copy link
 * is the convenience rather than the mechanism.
 *
 * Rebuilt on every render, unlike the masthead controls: nothing here animates
 * from a previous position, and the list changes shape as leagues arrive.
 *
 * Rendering only: app.js owns creating, joining, leaving and opening. When a
 * create or a join throws, the reason is shown inside the form that asked,
 * under its field, rather than as a notice at the top of the page.
 */

import { SPORTS, SPORT_IDS, normaliseSports } from "../sports.js";
import { formatCode, joinLink, normaliseCode, isCode } from "../core/code.js";
import { escapeHtml } from "../core/format.js";

/**
 * @param {HTMLElement} root
 * @param {object} state
 * @param {string} state.name This person's name.
 * @param {Array<object>} state.leagues From store/directory.js refreshMyLeagues,
 *   each with its `sports` and its `rules` by season.
 * @param {boolean} state.shared Whether leagues can be shared from this build.
 * @param {boolean} state.loading Whether the shared copy is still on its way.
 * @param {string} state.message A line to show above the list, or "".
 * @param {object} handlers onOpen(code, sport), onCreate({name, sports}),
 *   onJoin(code), onLeave(code), onRenameMe(). onCreate and onJoin may reject;
 *   the message is shown in their form.
 */
export function renderHome(root, state, handlers) {
  if (!root) return;
  root.innerHTML = homeMarkup(state);
  wire(root, handlers);
}

function homeMarkup({ name, leagues, shared, loading, message }) {
  return `
    <section class="home">
      <header class="home__head">
        <div>
          <p class="u-eyebrow home__eyebrow">Your leagues</p>
          <h2 class="home__title">${escapeHtml(name || "Survivor Board")}</h2>
        </div>
        <button type="button" class="home__name" data-act="rename-me">Not you?</button>
      </header>

      ${message ? `<div class="notice notice--warn home__message">${escapeHtml(message)}</div>` : ""}

      ${
        shared
          ? ""
          : `<div class="notice home__message">
               Sharing is off in this build, so leagues and their codes stay on this
               device. Everything else works.
             </div>`
      }

      <div class="home__list">
        ${
          leagues.length
            ? leagues.map(card).join("")
            : `<p class="home__empty">
                 ${loading ? "Looking for your leagues…" : "No leagues yet. Make one below, or join one with a code someone sent you."}
               </p>`
        }
      </div>

      <div class="home__forms">
        <form class="home__form" data-act="create">
          <h3 class="home__form-title">New league</h3>
          <label class="home__label" for="home-name">What is it called?</label>
          <input class="home__input" id="home-name" name="name" type="text" maxlength="60"
                 placeholder="The Office Pool" autocomplete="off" />
          <p class="home__form-error" role="alert" hidden></p>
          <fieldset class="home__choices-group">
            <legend class="home__label">Which seasons?</legend>
            <div class="home__choices">
              ${SPORT_IDS.map(
                (id) => `
                <label class="home__choice">
                  <input type="checkbox" name="sports" value="${id}" />
                  <span>${escapeHtml(SPORTS[id].label)}</span>
                </label>`,
              ).join("")}
            </div>
          </fieldset>
          <p class="home__hint">
            Tick every season this league plays: one code brings people into all of them,
            with a board for each. One pick a week or two, buy backs, and whether picks
            have to win or lose are set per season inside the league, from the gear
            beside its name.
          </p>
          <button type="submit" class="home__btn home__btn--go" disabled>Create league</button>
        </form>

        <form class="home__form" data-act="join">
          <h3 class="home__form-title">Join a league</h3>
          <label class="home__label" for="home-code">Paste the code you were sent</label>
          <input class="home__input home__input--code" id="home-code" name="code" type="text"
                 placeholder="BXQK-7HRT-M4WD" autocomplete="off" autocapitalize="characters"
                 spellcheck="false" />
          <p class="home__form-error" role="alert" hidden></p>
          <p class="home__hint">
            Twelve characters, dashes optional. Everyone in a league shares its boards:
            you will see the same picks and locks as the rest of them, and they will see
            yours.
          </p>
          <button type="submit" class="home__btn">Join</button>
        </form>
      </div>
    </section>`;
}

function card(league) {
  const sports = seasonsOf(league);
  const several = sports.length > 1;

  // One line per season the league plays, named when there is more than one,
  // and the head count once for the league: its members are the same people
  // whichever board they are on.
  const lines = sports
    .map((sport) => {
      const line = rulesLine(league.rules?.[sport]);
      if (!line) return null;
      return several ? `${SPORTS[sport].label}: ${line}` : line;
    })
    .filter(Boolean);
  if (league.members > 1) {
    const people = `${league.members} people`;
    if (lines.length === 1 && !several) lines[0] += ` · ${people}`;
    else lines.push(people);
  }

  return `
    <article class="home__card${league.missing ? " home__card--missing" : ""}"
             data-league="${escapeHtml(league.code)}">
      <div class="home__card-head">
        <h3 class="home__card-name">${escapeHtml(league.name)}</h3>
        <span class="home__card-chips">
          ${sports
            .map(
              (sport) =>
                `<span class="chip chip--${league.rules?.[sport]?.objective === "lose" ? "danger" : "picked"}">${escapeHtml(SPORTS[sport].short)}</span>`,
            )
            .join("")}
        </span>
      </div>

      ${lines.map((line) => `<p class="home__card-rules">${escapeHtml(line)}</p>`).join("")}

      <div class="home__code">
        <span class="home__code-label">Code</span>
        <code class="home__code-value">${escapeHtml(formatCode(league.code))}</code>
      </div>

      ${
        league.missing
          ? `<p class="home__card-warn">
               This code did not answer. It may be a league that was deleted, or the
               network. Leaving takes it off this device only.
             </p>`
          : ""
      }

      <div class="home__card-actions">
        ${sports
          .map(
            (sport) => `
        <button type="button" class="home__btn home__btn--go" data-act="open"
                data-sport="${sport}">${several ? `Open ${escapeHtml(SPORTS[sport].label)}` : "Open"}</button>`,
          )
          .join("")}
        <button type="button" class="home__btn" data-act="copy">Copy link</button>
        <button type="button" class="home__btn home__btn--quiet" data-act="leave">Leave</button>
      </div>
    </article>`;
}

/**
 * The seasons a league plays, for its card. The directory hands every league
 * over with `sports`; one with none the repo still carries is drawn as a league
 * of the first season rather than as a card with no board to open.
 */
function seasonsOf(league) {
  const sports = normaliseSports(league.sports ?? [league.sport]);
  return sports.length ? sports : [SPORT_IDS[0]];
}

/**
 * What one of a league's pools is, in one line: what a pick has to do, how
 * many a week, and what it forgives. Read off the rules that are actually
 * stored, so a pool running something other than its season's usual says so
 * here rather than only once you are inside it.
 *
 * Null until the rules are known - the cached list a home page is drawn from
 * before the network answers may not carry them yet, and a line that guesses
 * "1 pick a week" at a two-pick pool is worse than no line at all.
 */
function rulesLine(rules) {
  if (!rules) return null;
  const picks = rules.picksPerWeek ?? 1;
  const parts = [
    `${picks} pick${picks === 1 ? "" : "s"} a week`,
    rules.objective === "lose" ? "picks must lose" : "picks must win",
  ];
  const buyBacks = rules.buyBacks ?? 0;
  const weeks = (rules.buyBackWeeks ?? []).length;
  parts.push(
    buyBacks
      ? `${buyBacks} buy back${buyBacks === 1 ? "" : "s"} over ${weeks} week${weeks === 1 ? "" : "s"}`
      : "no buy backs",
  );
  return parts.join(" · ");
}

function wire(root, handlers) {
  root.querySelector('[data-act="rename-me"]')?.addEventListener("click", handlers.onRenameMe);

  const create = root.querySelector('form[data-act="create"]');
  if (create) {
    syncCreate(create);
    create.addEventListener("change", () => syncCreate(create));
    create.addEventListener("submit", (event) => {
      event.preventDefault();
      const sports = chosenSports(create);
      if (sports.length === 0) {
        showProblem(create, "Tick at least one season for the league to play.");
        return;
      }
      attempt(create, () => handlers.onCreate({ name: create.elements.name.value, sports }));
    });
  }

  root.querySelector('form[data-act="join"]')?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const typed = form.elements.code.value;
    if (!isCode(typed)) {
      showProblem(form, "That code is not twelve characters. Check it and try again.");
      return;
    }
    attempt(form, () => handlers.onJoin(normaliseCode(typed)));
  });

  for (const node of root.querySelectorAll(".home__card")) {
    const code = node.dataset.league;
    for (const open of node.querySelectorAll('[data-act="open"]')) {
      open.addEventListener("click", () => handlers.onOpen(code, open.dataset.sport));
    }
    node
      .querySelector('[data-act="leave"]')
      .addEventListener("click", () => handlers.onLeave(code));

    const copy = node.querySelector('[data-act="copy"]');
    copy.addEventListener("click", async () => {
      const link = joinLink(code);
      try {
        await navigator.clipboard.writeText(link);
        copy.textContent = "Link copied";
      } catch {
        // Clipboard refused - an insecure origin, or a browser that asks. The
        // code is on the card either way, which is the part that matters.
        copy.textContent = "Copy failed";
      }
      setTimeout(() => {
        copy.textContent = "Copy link";
      }, 1800);
    });
  }
}

/** The seasons ticked in the create form, in the order they are offered. */
function chosenSports(form) {
  return [...form.querySelectorAll('input[name="sports"]:checked')].map((input) => input.value);
}

/**
 * Create is held until a season is ticked. A league of no seasons would have
 * no board to open, so the button says what is missing by being unavailable
 * rather than by failing after the tap.
 */
function syncCreate(form) {
  form.querySelector('button[type="submit"]').disabled = chosenSports(form).length === 0;
}

/**
 * Run a form's handler and keep its answer in the form.
 *
 * A join or a create that does not go through is reported under the field it
 * concerns, and nothing else moves: the person is at the bottom of the page
 * with a thumb on the button, and a re-render to raise a notice at the top
 * would also have wiped what they typed, which is the thing they now need to
 * check.
 */
async function attempt(form, action) {
  showProblem(form, "");
  try {
    await action();
  } catch (error) {
    showProblem(form, error?.message || "That did not go through. Try again.");
  }
}

function showProblem(form, message) {
  const line = form.querySelector(".home__form-error");
  line.textContent = message;
  line.hidden = !message;
}
