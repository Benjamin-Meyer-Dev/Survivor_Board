/**
 * League codes.
 *
 * A code is the whole of how someone gets into a league: there are no
 * accounts, so knowing the code is the credential. That decides everything
 * about its shape.
 *
 * Twelve characters from a 31-letter alphabet is about 59 bits, which is far
 * past guessing at any rate a static site and a shared key could be asked to
 * serve.
 *
 * The alphabet leaves out every character that gets misread when a code is
 * spoken across a room or typed off a screenshot: I, L and 1 for each other, O
 * and 0 for each other. None of them can appear in a code, so a code cannot be
 * copied down as the wrong one - and normalising drops them rather than
 * guessing which letter was meant, because a code with one in it was misread
 * somewhere and "no league has that code" is a better answer than someone
 * else's league.
 *
 * Shown in groups of four (BXQK-7HRT-M4WD) because that is how a person reads
 * one back to you, and stored and compared without the dashes.
 */

/** 31 characters: no I, L, O, 0 or 1, the ones that are read as each other. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Twelve characters, in three groups of four. */
const CODE_LENGTH = 12;
const GROUP = 4;

/**
 * A new code. Uses the platform's cryptographic random source rather than
 * Math.random: this is a credential, and a predictable one would let a league
 * be walked into rather than joined.
 *
 * @returns {string} Twelve characters, no dashes.
 */
export function newCode() {
  return randomLetters(CODE_LENGTH);
}

/**
 * `length` letters of the alphabet, each drawn evenly. Rejection sampling,
 * because 256 is not a multiple of 31: taking the modulo of every byte would
 * make the first eight letters of the alphabet slightly likelier than the
 * rest, and a credential should not have a shape.
 */
function randomLetters(length) {
  const out = [];
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= limit || out.length === length) continue;
      out.push(ALPHABET[byte % ALPHABET.length]);
    }
  }
  return out.join("");
}

/**
 * A typed code, as the thing to look up: upper-cased, and stripped of
 * everything that is not part of a code - the dashes it is shown with, the
 * spaces a person types, and the characters the alphabet refuses.
 *
 * @param {string} value Anything a person or a URL might carry.
 * @returns {string} The normalised code, which may be any length: the caller
 *   decides whether what it got is long enough to look up (see isCode).
 */
export function normaliseCode(value) {
  return [...String(value ?? "").toUpperCase()]
    .filter((character) => ALPHABET.includes(character))
    .join("")
    .slice(0, CODE_LENGTH);
}

/** Whether a normalised code is a whole one, and so worth looking up. */
export function isCode(value) {
  return normaliseCode(value).length === CODE_LENGTH;
}

/** A code as it is shown to a person: groups of four, dash separated. */
export function formatCode(code) {
  const clean = normaliseCode(code);
  const groups = [];
  for (let index = 0; index < clean.length; index += GROUP) {
    groups.push(clean.slice(index, index + GROUP));
  }
  return groups.join("-");
}

/* --- a person's id --------------------------------------------------------- */

/**
 * A person's id: eight letters of the same alphabet, shown as two groups of
 * four (K7QM-3WXP).
 *
 * It is what a lock and a member row carry to say whose they are, and it is
 * minted on the first phone a person uses. Read off that phone and typed into
 * another, it makes the second phone the same person - the same member row,
 * the same picks, the same leagues (claimId in store/directory.js) - rather
 * than a second member with the same name. Eight letters is about 40 bits,
 * which is enough that no two people will ever draw the same one; it is not
 * a secret, any more than a name is, and whoever holds a league's code can
 * already write to it.
 *
 * Ids from before this were `d-` and eight base-36 characters, and every lock
 * and member row from then still carries one. They stay valid as they are:
 * normalising keeps that shape, and it is shown as it is stored.
 */
const PERSON_ID_LENGTH = 8;
const LEGACY_ID = /^d-[a-z0-9]{4,16}$/;

export function newPersonId() {
  return randomLetters(PERSON_ID_LENGTH);
}

/**
 * A typed id, as the thing to look up: a legacy device id lower-cased and
 * kept whole, anything else upper-cased and stripped to the alphabet.
 *
 * @param {string} value Anything a person might type or paste.
 * @returns {string} May be short of an id: the caller decides whether what
 *   it got is whole (see isPersonId).
 */
export function normalisePersonId(value) {
  const typed = String(value ?? "")
    .trim()
    .toLowerCase();
  if (LEGACY_ID.test(typed)) return typed;
  return [...typed.toUpperCase()]
    .filter((character) => ALPHABET.includes(character))
    .join("")
    .slice(0, PERSON_ID_LENGTH);
}

/** Whether a normalised id is a whole one, and so worth looking up. */
export function isPersonId(value) {
  const id = normalisePersonId(value);
  return LEGACY_ID.test(id) || id.length === PERSON_ID_LENGTH;
}

/** An id as it is shown to a person: two groups of four; a legacy id as it is. */
export function formatPersonId(id) {
  const clean = normalisePersonId(id);
  if (LEGACY_ID.test(clean)) return clean;
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

/**
 * The link that opens a league on someone else's phone. Same page, so it works
 * from a text message, a group chat or a QR code without anything hosting it,
 * and the app reads the hash on boot (see app.js).
 *
 * @param {string} code
 * @param {string} [href] The page to build it from. Defaults to this page.
 */
export function joinLink(code, href = globalThis.location?.href ?? "") {
  const url = new URL(href || "https://example.invalid/");
  url.hash = `#/join/${normaliseCode(code)}`;
  return url.toString();
}

/**
 * The hash an open board leaves in the address bar, so a reload comes back to
 * it: the league, and which of its pools was showing (a kind id, see
 * src/js/sports.js).
 */
export function leagueHash(code, kind = null) {
  const clean = normaliseCode(code);
  return kind ? `#/l/${clean}/${kind}` : `#/l/${clean}`;
}

/**
 * The code a URL is asking for, or null. Accepts both the join link and the
 * plain league link, so a shared address of either kind works. A league link
 * may name the pool to open (#/l/CODE/nfl-lose); one that does not is left to
 * the app, which opens the league's first.
 *
 * @param {string} hash location.hash
 * @returns {{action:"join"|"open", code:string, kind:string|null}|null}
 */
export function codeFromHash(hash) {
  const match = /^#\/(join|l)\/([^/?#]+)(?:\/([^/?#]+))?/.exec(String(hash ?? ""));
  if (!match) return null;
  const code = normaliseCode(match[2]);
  if (!isCode(code)) return null;
  const action = match[1] === "join" ? "join" : "open";
  return { action, code, kind: action === "open" && match[3] ? match[3].toLowerCase() : null };
}
