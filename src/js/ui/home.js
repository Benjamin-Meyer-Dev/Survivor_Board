/**
 * The home page: your leagues.
 *
 * Everything a person does that is not picking a team happens here - which
 * leagues this device is in, making another, joining someone else's, and
 * handing out the code that lets them join yours.
 *
 * A league's code is shown on its card rather than hidden behind a share
 * sheet, because the code is the whole of how anyone else gets in: it has to
 * be readable off a screenshot and repeatable down a phone line, and Copy link
 * is the convenience rather than the mechanism.
 *
 * Rebuilt on every render, unlike the masthead controls: nothing here animates
 * from a previous position, and the list changes shape as leagues arrive.
 *
 * Rendering only: app.js owns creating, joining, leaving and opening.
 */

import { SPORTS, SPORT_IDS } from "../sports.js";
import { formatCode, joinLink, normaliseCode, isCode } from "../core/code.js";
import { escapeHtml } from "../core/format.js";

/**
 * @param {HTMLElement} root
 * @param {object} state
 * @param {string} state.name This person's name.
 * @param {Array<object>} state.leagues From store/directory.js refreshMyLeagues.
 * @param {boolean} state.shared Whether leagues can be shared from this build.
 * @param {boolean} state.loading Whether the shared copy is still on its way.
 * @param {string} state.message A line to show above the list, or "".
 * @param {object} handlers onOpen, onCreate, onJoin, onLeave, onRenameMe
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
          <fieldset class="home__choices-group">
            <legend class="home__label">Which season?</legend>
            <div class="home__choices">
              ${SPORT_IDS.map(
                (id, index) => `
                <label class="home__choice">
                  <input type="radio" name="sport" value="${id}" ${index === 0 ? "checked" : ""} />
                  <span>${escapeHtml(SPORTS[id].label)}</span>
                </label>`,
              ).join("")}
            </div>
          </fieldset>
          <p class="home__hint">
            One pick a week or two, buy backs, and whether picks have to win or lose are
            all set in the league itself, from the gear beside its name.
          </p>
          <button type="submit" class="home__btn home__btn--go">Create league</button>
        </form>

        <form class="home__form" data-act="join">
          <h3 class="home__form-title">Join a league</h3>
          <label class="home__label" for="home-code">Paste the code you were sent</label>
          <input class="home__input home__input--code" id="home-code" name="code" type="text"
                 placeholder="BXQK-7HRT-M4WD" autocomplete="off" autocapitalize="characters"
                 spellcheck="false" />
          <p class="home__hint">
            Twelve characters, dashes optional. Everyone in a league shares one board:
            you will see the same picks and locks as the rest of them, and they will see
            yours.
          </p>
          <button type="submit" class="home__btn">Join</button>
        </form>
      </div>
    </section>`;
}

function card(league) {
  const sport = SPORTS[league.sport] ?? SPORTS[SPORT_IDS[0]];
  return `
    <article class="home__card${league.missing ? " home__card--missing" : ""}"
             data-league="${escapeHtml(league.code)}">
      <div class="home__card-head">
        <h3 class="home__card-name">${escapeHtml(league.name)}</h3>
        <span class="chip chip--${league.rules?.objective === "lose" ? "danger" : "picked"}">${escapeHtml(sport.short)}</span>
      </div>

      ${rulesLine(league) ? `<p class="home__card-rules">${escapeHtml(rulesLine(league))}</p>` : ""}

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
        <button type="button" class="home__btn home__btn--go" data-act="open">Open</button>
        <button type="button" class="home__btn" data-act="copy">Copy link</button>
        <button type="button" class="home__btn home__btn--quiet" data-act="leave">Leave</button>
      </div>
    </article>`;
}

/**
 * What a league is, in one line: the season it plays, what a pick has to do,
 * how many a week, and what it forgives. Read off the rules that are actually
 * stored, so a league running something other than its season's usual says so
 * here rather than only once you are inside it.
 *
 * Null until the rules are known - the cached list a home page is drawn from
 * before the network answers may not carry them yet, and a line that guesses
 * "1 pick a week" at a two-pick league is worse than no line at all.
 */
function rulesLine(league) {
  const rules = league.rules;
  if (!rules) return null;
  const picks = rules.picksPerWeek ?? 1;
  const parts = [
    `${picks} pick${picks === 1 ? "" : "s"} a week`,
    rules.objective === "lose" ? "picks must lose" : "picks must win",
  ];
  const buyBacks = rules.buyBacks ?? 0;
  parts.push(
    buyBacks
      ? `${buyBacks} buy back${buyBacks === 1 ? "" : "s"} over ${(rules.buyBackWeeks ?? []).length} week${(rules.buyBackWeeks ?? []).length === 1 ? "" : "s"}`
      : "no buy backs",
  );
  if (league.members > 1) parts.push(`${league.members} people`);
  return parts.join(" · ");
}

function wire(root, handlers) {
  root.querySelector('[data-act="rename-me"]')?.addEventListener("click", handlers.onRenameMe);

  root.querySelector('form[data-act="create"]')?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    handlers.onCreate({
      name: form.elements.name.value,
      sport: form.elements.sport.value,
    });
  });

  root.querySelector('form[data-act="join"]')?.addEventListener("submit", (event) => {
    event.preventDefault();
    const typed = event.currentTarget.elements.code.value;
    if (!isCode(typed)) {
      handlers.onJoinError("That code is not twelve characters. Check it and try again.");
      return;
    }
    handlers.onJoin(normaliseCode(typed));
  });

  for (const node of root.querySelectorAll(".home__card")) {
    const code = node.dataset.league;
    node.querySelector('[data-act="open"]').addEventListener("click", () => handlers.onOpen(code));
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
