/**
 * Pool equity: the chance of winning the pool, not just of surviving it.
 *
 * Surviving alongside everyone else gains nothing. If most of the field is on
 * the same favourite, a week it holds thins nobody out, and a week it falls
 * takes you with them. A lightly held team of nearly the same strength wins
 * you ground in the week it holds. That difference is leverage, and it needs
 * numbers the odds never carry: how many entries are alive and what share of
 * them sits on each team this week.
 *
 * Those come from data/<league>/pool.json, kept by hand, and without it the
 * board stays in survival mode rather than invent them. The model is the
 * standard one-week one: the expected share of the field still standing after
 * this week, given that your own pick came through, turned into a multiplier
 * on your survival. It is an approximation of the season-long game - a
 * proper treatment needs every rival's spent teams - and is presented as a
 * multiplier beside the survival number, never in place of it.
 *
 * Three modes, chosen in the file:
 *
 *   safest    survival alone (the default, and what a missing file means)
 *   equity    the highest survival x leverage
 *   balanced  the highest survival x leverage among candidates whose chance
 *             this week is at least `floor`
 *
 * Pure and environment-free.
 */

/** The floor the balanced mode uses when the file names none. */
const DEFAULT_FLOOR = 0.75;

/**
 * Read the file into what the overlay needs, with every gap filled.
 *
 * @param {object|null} pool The parsed pool.json, or null.
 * @param {number} week This week.
 * @returns {{active:boolean, mode:string, floor:number, entriesAlive:number|null,
 *            popularity:Map<string,number>}|null}
 */
export function poolSettings(pool, week) {
  if (!pool || typeof pool !== "object") return null;
  const popularity = new Map();
  for (const [key, share] of Object.entries(pool.popularity ?? {})) {
    const [weekKey, team] = key.split("|");
    if (Number(weekKey) !== week || !Number.isFinite(share)) continue;
    popularity.set(team, Math.min(1, Math.max(0, share)));
  }
  const mode = ["safest", "equity", "balanced"].includes(pool.mode) ? pool.mode : "safest";
  return {
    // Leverage needs to know who is on what; without this week's shares the
    // file cannot say anything about this week.
    active: popularity.size > 0,
    mode,
    floor: Number.isFinite(pool.floor) ? pool.floor : DEFAULT_FLOOR,
    entriesAlive: Number.isFinite(pool.entriesAlive) ? pool.entriesAlive : null,
    popularity,
  };
}

/**
 * The share of the field expected to survive this week if the given picks
 * hold, and the leverage that implies.
 *
 * Every other entry's pick is drawn from the popularity shares. An entry on
 * one of your teams survives with you; an entry on one of their opponents is
 * gone; anyone else survives with their team's own probability. Shares that
 * add to less than one are the field on teams nobody listed, given the
 * average probability of the listed ones. A two-pick pool's entries need both
 * to hold, so the field's rate is raised to that power.
 *
 * @param {object} args
 * @param {string[]} args.teams Your picks this week.
 * @param {Array<{team:string, opponent:string, winProb:number}>} args.options
 *   This week's options.
 * @param {Map<string,number>} args.popularity Share of the field on each team.
 * @param {number} args.picksPerWeek
 * @returns {{fieldSurvival:number, leverage:number, popularity:number}}
 *   `popularity` is the share of the field on your own pick(s), averaged.
 */
export function fieldAfterWeek({ teams, options, popularity, picksPerWeek = 1 }) {
  const byTeam = new Map(options.map((option) => [option.team, option]));
  const mine = new Set(teams);
  const opponents = new Set(teams.map((team) => byTeam.get(team)?.opponent).filter(Boolean));

  let weighted = 0;
  let listed = 0;
  for (const [team, share] of popularity) {
    if (share <= 0) continue;
    listed += share;
    if (mine.has(team)) weighted += share;
    else if (opponents.has(team)) weighted += 0;
    else weighted += share * (byTeam.get(team)?.winProb ?? 0.5);
  }
  const average = listed > 0 ? weighted / listed : 0.5;
  const rest = Math.max(0, 1 - listed);
  const rate = Math.min(1, weighted + rest * average);
  const fieldSurvival = rate ** picksPerWeek;
  const own = teams.length
    ? teams.reduce((sum, team) => sum + (popularity.get(team) ?? 0), 0) / teams.length
    : 0;

  return {
    fieldSurvival,
    // The field shrinks to this share; your stake in what is left grows by
    // the inverse. Guarded so an empty field does not divide by zero.
    leverage: fieldSurvival > 0 ? 1 / fieldSurvival : 1,
    popularity: own,
  };
}

/**
 * Lay the pool's numbers over the frontier the recommender produced.
 *
 * Adds to each candidate its popularity, leverage and equity (survival across
 * futures times leverage), and names the pick each mode would make. The
 * candidate the recommender chose stays `chosen`; `preferred` is the mode's
 * pick, which is the same team in safest mode.
 *
 * @param {object} args
 * @param {object|null} args.frontier From recommendPath.
 * @param {Array<object>} args.options This week's options.
 * @param {object|null} args.pool The parsed pool.json.
 * @param {number} args.picksPerWeek
 * @returns {object|null} The decorated frontier, or the original when the
 *   pool cannot speak to this week.
 */
export function equityOverlay({ frontier, options, pool, picksPerWeek = 1 }) {
  if (!frontier) return frontier;
  const settings = poolSettings(pool, frontier.week);
  if (!settings?.active) return { ...frontier, pool: null };

  const candidates = frontier.candidates.map((candidate) => {
    const field = fieldAfterWeek({
      teams: candidate.teams,
      options,
      popularity: settings.popularity,
      picksPerWeek,
    });
    return {
      ...candidate,
      popularity: field.popularity,
      fieldSurvival: field.fieldSurvival,
      leverage: field.leverage,
      equity: candidate.scenarioMean * field.leverage,
    };
  });

  const byEquity = [...candidates].sort((a, b) => b.equity - a.equity);
  const eligible =
    settings.mode === "balanced"
      ? byEquity.filter((candidate) => candidate.weekWinProb >= settings.floor)
      : byEquity;
  const preferred =
    settings.mode === "safest"
      ? candidates.find((candidate) => candidate.chosen)
      : (eligible[0] ?? candidates.find((candidate) => candidate.chosen));

  return {
    ...frontier,
    candidates: candidates.map((candidate) => ({
      ...candidate,
      preferred: candidate === preferred,
    })),
    pool: {
      mode: settings.mode,
      floor: settings.floor,
      entriesAlive: settings.entriesAlive,
      preferred: preferred ? { teams: preferred.teams } : null,
    },
  };
}
