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
export const CODE_LENGTH = 12;
const GROUP = 4;

/**
 * A new code. Uses the platform's cryptographic random source rather than
 * Math.random: this is a credential, and a predictable one would let a league
 * be walked into rather than joined.
 *
 * @returns {string} Twelve characters, no dashes.
 */
export function newCode() {
  const out = [];
  // Rejection sampling, because 256 is not a multiple of 31: taking the
  // modulo of every byte would make the first eight letters of the alphabet
  // slightly likelier than the rest, and a credential should not have a shape.
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < CODE_LENGTH) {
    const bytes = new Uint8Array(CODE_LENGTH);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= limit || out.length === CODE_LENGTH) continue;
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
 * The code a URL is asking for, or null. Accepts both the join link and the
 * plain league link, so a shared address of either kind works.
 *
 * @param {string} hash location.hash
 * @returns {{action:"join"|"open", code:string}|null}
 */
export function codeFromHash(hash) {
  const match = /^#\/(join|l)\/([^/?#]+)/.exec(String(hash ?? ""));
  if (!match) return null;
  const code = normaliseCode(match[2]);
  if (!isCode(code)) return null;
  return { action: match[1] === "join" ? "join" : "open", code };
}
