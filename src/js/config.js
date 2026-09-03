/**
 * Runtime configuration.
 *
 * The Supabase key here is the PUBLIC publishable key (the legacy anon key
 * works too), which is safe to ship in a static bundle as long as row-level
 * security is enabled. See supabase/schema.sql. Leave `url` empty to run
 * without a backend - the app falls back to per-device localStorage and says
 * so in the UI.
 */

export const CONFIG = Object.freeze({
  /** Where the data files live, relative to index.html. One folder per league. */
  dataPath: "./data",

  /**
   * Shared-state backend. Both values come from the Supabase dashboard under
   * Settings -> API Keys: the Project URL and the Publishable key.
   */
  supabase: {
    url: "https://jxeeyksvhutlghmhizjg.supabase.co",
    publishableKey: "sb_publishable_EbjNYo4wYu2eRK89vgvF8w_aSEHXU2a",
    table: "entries",
  },

  /**
   * The pool passcode, as a digest.
   *
   * Asked for once per device, the first time the board is opened there, and
   * remembered after that. The same answer unlocks writes to the shared entry
   * when Supabase is configured.
   *
   * The passcode itself is not in this file or anywhere else in the repo. What
   * ships is a PBKDF2-SHA256 digest of it (see core/passcode.js), which the
   * board compares a typed answer against. Set or change it with
   *
   *   npm run passcode
   *
   * which writes both values below. Both are public, so this is still a gate
   * against a passer-by rather than a lock against anyone determined; the
   * digest just means the passcode has to be guessed rather than read. Leave
   * `digest` empty for no gate.
   */
  passcode: {
    digest: "c65711f20442e90c936bd2a6f4a3f07b4c9a881c9a8aea92058bba21e3203ee9",
    salt: "d6588c0330bf2952d9d2aa96ac57d9b7",
  },

  /** localStorage key used by the offline store. */
  localStorageKey: "survivor-board/entry/v1",

  /**
   * When the odds bot runs. Must match the timezone-aware schedule in
   * .github/workflows/refresh-odds.yml; the board only uses it to show when the
   * next pull is due. Once a day keeps two leagues inside the free Odds API
   * quota: 4 credits per league per run against 500 a month.
   */
  refresh: {
    hour: 9,
    minute: 0,
    timeZone: "America/Toronto",
  },
});

/**
 * Where one league's entry is stored, in each of the three backends.
 *
 * In Supabase the row id is simply the league id, matching the folder under
 * data/ and the seed in supabase/schema.sql. The two per-device backends keep
 * their older shape: the college pool predates the NFL one and its state is
 * already saved under the unsuffixed names, so it keeps them, and anything
 * else is namespaced, which is what stops one league's selections from landing on
 * the other's board.
 */
export function scopeFor(league) {
  const suffix = league === "cfb" ? "" : `/${league}`;
  return {
    doc: league === "cfb" ? "entry/shared" : `entry/${league}`,
    entryId: league,
    storageKey: `${CONFIG.localStorageKey}${suffix}`,
  };
}
