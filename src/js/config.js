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
   * localStorage keys.
   *
   *   name      what this person is called, asked for once on first run
   *   who       this device's id, saved against every lock and pick
   *   leagues   the codes this device has joined, with a cached name and sport
   *             so the home page can be drawn before the network answers
   *   entry     one per league, the offline copy of that league's board
   */
  storage: Object.freeze({
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
 * Where one league's shared state lives, in each of the backends. Keyed by the
 * league's code, so two leagues never land on each other's board.
 */
export function scopeFor(code) {
  return {
    doc: `league/${code}`,
    entryId: code,
    storageKey: `${CONFIG.storage.entryPrefix}/${code}`,
  };
}
