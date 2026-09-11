/**
 * The app's access code: how it is read, and how it is checked.
 *
 * The board is a static site, so there is nobody to ask whether a code is
 * right: the check happens on the device, against a digest that ships in
 * config.js. The code itself is never in the repo - `npm run passcode` writes
 * the digest and a fresh salt and prints nothing else - and the digest is what
 * a device keeps once it has given the code (store/directory.js), so changing
 * the code asks every device again.
 *
 * The digest is PBKDF2 over SHA-256, salted, at a count that costs a phone a
 * fraction of a second and a guesser the same for every try. That is what a
 * public digest can honestly offer: it keeps a short code from being read off
 * the page in a millisecond, not a determined attacker from ever finding it,
 * and the league codes stay their own separate credential either way (see
 * supabase/schema.sql). Pick a code with some length in it.
 *
 * Pure: WebCrypto is the same call in the browser and in Node, and the script
 * that sets the code imports this so the two can never drift apart.
 */

/** Rounds of PBKDF2, the number config.js should carry. */
export const PASSCODE_ITERATIONS = 200000;

/**
 * A code as it is compared: whitespace gone and case folded, so a code typed
 * on a phone with its auto-capitals and a stray space still opens the door.
 * Compatibility-normalised first, so a full-width digit is the digit.
 */
export function normalisePasscode(typed) {
  return String(typed ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toUpperCase();
}

/** A fresh salt, sixteen random bytes as hex. */
export function newSalt() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** Whether a string is a digest this module produced: 32 bytes of hex. */
export function isDigest(value) {
  return /^[0-9a-f]{64}$/.test(String(value ?? ""));
}

/**
 * The digest of a code under a salt.
 *
 * @param {string} typed The code as typed; normalised here.
 * @param {string} salt Hex, from newSalt().
 * @param {number} [iterations]
 * @returns {Promise<string>} 64 hex characters.
 */
export async function derivePasscodeDigest(typed, salt, iterations = PASSCODE_ITERATIONS) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("This browser cannot check the code.");
  const key = await subtle.importKey(
    "raw",
    new TextEncoder().encode(normalisePasscode(typed)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromHex(salt), iterations },
    key,
    256,
  );
  return toHex(new Uint8Array(bits));
}

function toHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  const clean = String(hex ?? "");
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) {
    throw new Error("The salt in config.js is not hex.");
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
