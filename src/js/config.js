/**
 * Runtime configuration.
 *
 * Supabase keys here are the PUBLIC anon key, which is safe to ship in a
 * static bundle as long as row-level security is enabled. See
 * supabase/schema.sql. Leave `url` empty to run without a backend - the app
 * falls back to per-device localStorage and says so in the UI.
 */

export const CONFIG = Object.freeze({
  /** Where the data files live, relative to index.html. One folder per league. */
  dataPath: "./data",

  /** Shared-state backend. */
  supabase: {
    url: "",
    anonKey: "",
    table: "entries",
    /** Row id both people read and write. One row = one pool entry. */
    entryId: "shared",
  },

  /**
   * Writes are gated behind this passphrase when Supabase is configured.
   * Not real security - it stops a stray link-holder from editing the entry.
   * Leave empty to allow any viewer to write.
   */
  writePassphrase: "",

  /** localStorage key used by the offline store. */
  localStorageKey: "survivor-board/entry/v1",

  /**
   * Manual refresh.
   *
   * A static page cannot hold a GitHub token, so the button posts to a small
   * server-side endpoint that owns the secret and calls workflow_dispatch.
   * See supabase/functions/refresh/ and docs/DEPLOY.md.
   *
   * Leave dispatchUrl empty and the button still works: it re-reads
   * data/odds.json, which picks up a commit the bot has already made.
   */
  refresh: {
    /** Must match the cron in .github/workflows/refresh-odds.yml. */
    everyHours: 6,
    minuteUtc: 0,
    dispatchUrl: "",
    /** Sent as x-refresh-key. Not a secret that protects anything valuable -
        it only stops a passer-by from queueing workflow runs. */
    key: "",
  },
});

/**
 * Where one league's entry is stored, in each of the three backends.
 *
 * The college pool predates the NFL one and its state is already saved under
 * the unsuffixed names, so it keeps them. Anything else is namespaced, which
 * is what stops one league's locks from landing on the other's board.
 */
export function scopeFor(league) {
  const suffix = league === "cfb" ? "" : `/${league}`;
  return {
    doc: league === "cfb" ? "entry/shared" : `entry/${league}`,
    entryId: league === "cfb" ? CONFIG.supabase.entryId : `${CONFIG.supabase.entryId}-${league}`,
    storageKey: `${CONFIG.localStorageKey}${suffix}`,
  };
}
