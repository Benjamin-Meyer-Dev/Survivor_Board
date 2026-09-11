/**
 * Runtime configuration.
 *
 * The Supabase key here is the PUBLIC publishable key (the legacy anon key
 * works too), which is safe to ship in a static bundle as long as row-level
 * security is enabled. See supabase/schema.sql. Leave `url` empty to run
 * without a backend - the app falls back to per-device localStorage, leagues
 * stay on the phone that made them, and the UI says so.
 */

export const CONFIG = Object.freeze({
  /** Where the data files live, relative to index.html. One folder per sport. */
  dataPath: "./data",

  /**
   * Shared-state backend. Both values come from the Supabase dashboard under
   * Settings -> API Keys: the Project URL and the Publishable key.
   *
   * One row per league, keyed by the league's code. There are no accounts: the
   * code is the credential, and anyone holding one can read and write that
   * league. What that does and does not protect is written up in
   * supabase/schema.sql, which is also where the policies live.
   */
  supabase: {
    url: "https://jxeeyksvhutlghmhizjg.supabase.co",
    publishableKey: "sb_publishable_EbjNYo4wYu2eRK89vgvF8w_aSEHXU2a",
    table: "leagues",
  },

  /**
   * The app's access code, as a device can check it without anyone to ask:
   * the salted PBKDF2 digest of the code, never the code (core/passcode.js).
   * Written by `npm run passcode`; an empty digest means there is no door and
   * the app opens for anyone with the address. This is the app's own code -
   * a league's code is a separate thing and gets a person into one league.
   */
  passcode: Object.freeze({
    digest: "74a85e5bd7e9e937205935af04e9dcc2257b0ba3e06445886d3b6c0675adad5c",
    salt: "f6049e45decafc7bb2ef257c138205df",
    iterations: 200000,
  }),

  /**
   * localStorage keys.
   *
   *   passcode  the digest of the access code this device has given, so it is
   *             asked once - and asked again when the code changes
   *   name      what this person is called, asked for once on first run
   *   who       this device's id, saved against every lock and pick
   *   leagues   the codes this device has joined, with a cached name, the kinds
   *             of pool each runs and their rules, so the home page can be
   *             drawn before the network answers
   *   entry     one per pool - a league's code and one of its kinds - the
   *             offline copy of that pool's board
   */
  storage: Object.freeze({
    passcode: "survivor-board/passcode",
    name: "survivor-board/name",
    who: "survivor-board/who",
    leagues: "survivor-board/leagues/v1",
    entryPrefix: "survivor-board/entry/v2",
  }),

  /**
   * When the odds bot runs. Must match the timezone-aware schedule in
   * .github/workflows/refresh-odds.yml; the board only uses it to show when the
   * next pull is due. Once a day keeps both pulls inside the free Odds API
   * quota: 4 credits per sport per run against 500 a month. Leagues cost
   * nothing to add - however many there are, they read the same two pulls.
   */
  refresh: {
    hour: 9,
    minute: 0,
    timeZone: "America/Toronto",
  },
});

/**
 * Where one pool's shared state lives, in each of the backends. Keyed by the
 * league's code and the kind of pool (a season, played for winners or for
 * losers - see src/js/sports.js), so two leagues never land on each other's
 * board, and nor do two pools of one league.
 *
 * `legacyStorageKey` is where a league kept its board before a league could
 * hold more than one pool. The per-device store reads it when the keyed copy
 * is not there, so nothing saved offline is lost to the change.
 */
export function scopeFor(code, kind) {
  return {
    doc: `league/${code}/${kind}`,
    entryId: code,
    kind,
    storageKey: `${CONFIG.storage.entryPrefix}/${code}/${kind}`,
    legacyStorageKey: `${CONFIG.storage.entryPrefix}/${code}`,
  };
}
