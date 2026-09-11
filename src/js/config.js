/**
 * Runtime configuration.
 *
 * The Supabase key here is the PUBLIC publishable key (the legacy anon key
 * works too), which is safe to ship in a static bundle as long as row-level
 * security is enabled. See supabase/schema.sql. Leave `url` empty to run
 * without a backend - the app falls back to per-device localStorage, leagues
 * stay on the phone that made them, and the UI says so.
 */

/**
 * What the app is called, everywhere it names itself: the tab, the home
 * screen, the wordmark and the end zones. Two words, because the field has two
 * end zones and each is painted with one of them (ui/stadium.js). Sudden
 * death is what a survivor pool is - one loss and the season is over - and the
 * overtime rule the game itself has always called it.
 */
export const APP_NAME_WORDS = Object.freeze(["Sudden", "Death"]);
export const APP_NAME = APP_NAME_WORDS.join(" ");

/**
 * Every localStorage key starts with this, so nothing the app writes can
 * collide with anything else on the origin. `OLD_STORAGE_PREFIXES` is what the
 * keys began with under the app's earlier names: whatever a device still holds
 * under one of them is brought across at launch (store/directory.js), so a
 * rename never logs anyone out or loses a league list.
 */
export const STORAGE_PREFIX = "sudden-death/";
export const OLD_STORAGE_PREFIXES = Object.freeze(["survivor-board/"]);

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
    digest: "3a536e376f971c25c95e0e4b8e4f1f3f760a744f0f79d500704043206ad9de1d",
    salt: "aa6279db144f7db2489ee7093ca1d27a",
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
   *   plans     the coach's last few season plans, so a launch opens on a
   *             board that is already planned (store/plans.js)
   *
   * `plans` carries a version of its own because a plan is the output of the
   * search and its key cannot describe the search itself: BUMP IT WHENEVER
   * core/recommend.js CHANGES, the same ritual as CACHE in sw.js, or a deploy
   * is answered out of the old version's plans until the next lock moves the
   * board on. Nothing else here needs that - the rest is what people typed.
   */
  storage: Object.freeze({
    passcode: `${STORAGE_PREFIX}passcode`,
    name: `${STORAGE_PREFIX}name`,
    who: `${STORAGE_PREFIX}who`,
    leagues: `${STORAGE_PREFIX}leagues/v1`,
    entryPrefix: `${STORAGE_PREFIX}entry/v2`,
    plans: `${STORAGE_PREFIX}plans/v1`,
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
