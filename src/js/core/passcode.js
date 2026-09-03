/**
 * Passcode digests.
 *
 * The repo, and so the shipped page, holds a digest of the pool passcode and
 * never the passcode itself: PBKDF2-SHA256 over the passcode with a salt that
 * `npm run passcode` draws fresh each time it is set. Checking an answer means
 * deriving it the same way and comparing.
 *
 * The iteration count is what makes guessing against the public digest slow,
 * and it is a constant here rather than a config value on purpose: changing it
 * changes every digest, so it must go together with running `npm run passcode`
 * again, or every device is locked out with no wrong-answer message to say why.
 *
 * Pure: runs in the browser and in Node off `globalThis.crypto.subtle`, so the
 * script that sets the passcode and the gate that checks it share one function.
 */

export const PASSCODE_ITERATIONS = 600_000;

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Derive the digest of a passcode. Surrounding whitespace is ignored, so a
 * phone keyboard's trailing space does not lock anyone out.
 *
 * @param {string} passcode
 * @param {string} salt Any string; the same salt must be used to check.
 * @returns {Promise<string>} 64 hex characters.
 */
export async function derivePasscodeDigest(passcode, salt) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("This browser cannot check the passcode here. Open the board over https.");
  }

  const encoder = new TextEncoder();
  const key = await subtle.importKey("raw", encoder.encode(passcode.trim()), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(salt),
      iterations: PASSCODE_ITERATIONS,
    },
    key,
    256,
  );

  return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether a string has the shape `derivePasscodeDigest` produces. */
export function isPasscodeDigest(value) {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}
