/**
 * The field, drawn in markup: painted end zones with the app's name split
 * across them - one word in each, the way a home team's is - hash marks, yard
 * numbers at both sidelines and the ball at midfield. The lines themselves are
 * the stylesheet's (`.stadium` in components.css).
 *
 * Decorative and inert - aria-hidden, no pointer events - so it can stand
 * behind whatever is on top of it: the start screen's card, or the home page.
 * Where it sits and how big it is are the caller's to say, with a class of
 * its own on the wrapper.
 */
import { APP_NAME_WORDS } from "../config.js";

const [FIRST_WORD, SECOND_WORD] = APP_NAME_WORDS;

/**
 * @param {{top?:string, bottom?:string}} [words] What the end zones say: by
 *   default the first word of the name at the top and the second at the bottom.
 * @returns {string}
 */
export function stadiumMarkup({ top = FIRST_WORD, bottom = SECOND_WORD } = {}) {
  return `
    <div class="stadium" aria-hidden="true">
      <span class="stadium__endzone stadium__endzone--top">${escape(top)}</span>
      <span class="stadium__endzone stadium__endzone--bottom">${escape(bottom)}</span>
      <span class="stadium__hashes stadium__hashes--left"><i></i><i></i><i></i><i></i><i></i></span>
      <span class="stadium__hashes stadium__hashes--right"><i></i><i></i><i></i><i></i><i></i></span>
      <span class="stadium__yard-number stadium__yard-number--20"><i>20</i><i>20</i></span>
      <span class="stadium__yard-number stadium__yard-number--40"><i>40</i><i>40</i></span>
      <span class="stadium__yard-number stadium__yard-number--opposing-40"><i>40</i><i>40</i></span>
      <span class="stadium__yard-number stadium__yard-number--opposing-20"><i>20</i><i>20</i></span>
      <svg class="stadium__ball" viewBox="0 0 34 21" aria-hidden="true">
        <ellipse cx="17" cy="10.5" rx="15.6" ry="9.2" fill="none" stroke="currentColor"
                 stroke-width="2.1" />
        <path d="M9.5 10.5h15M12 8.6v3.8M14.5 8.6v3.8M17 8.6v3.8M19.5 8.6v3.8M22 8.6v3.8"
              stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
    </div>`;
}

function escape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;");
}
