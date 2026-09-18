/**
 * Pool equity: the chance of winning the pool, not just of surviving it.
 *
 * Surviving alongside everyone else gains nothing. If most of the field is on
 * the same favourite, a week it holds thins nobody out, and a week it falls
 * takes you with them. A lightly held team of nearly the same strength wins
 * you ground in the week it holds. That difference is leverage, and it needs
 * a number the odds never carry: what share of the field sits on each team
 * this week.
 *
 * Two places that number can come from. `data/<league>/pool.json`, kept by
 * hand, when someone has the pool's actual picks. Otherwise the field is
 * implied from the lines: survivor fields crowd the biggest favourites in a
 * steep, well-documented way (the top favourite of an NFL week draws roughly
 * a third of the picks, the next two most of the rest), and a softmax over
 * this week's probabilities reproduces that shape closely enough to price
 * leverage off. It knows nothing about which teams the field has already
 * spent, so it is a shape, not a census; the file wins whenever it speaks.
 *
 * The model is the standard one-week one: the expected share of the field
 * still standing after this week, given that your own pick came through,
 * turned into a multiplier on your survival across futures. Where the pool
 * grants buy backs the field has them too, so in a forgiving week an entry
 * whose pick loses is not gone - it is worth `cover`, the value of playing on
 * without the cushion - and the leverage on offer shrinks to match. It is an
 * approximation of the season-long game - a proper treatment needs every
 * rival's spent teams - and is presented as a multiplier beside the survival
 * number, never in place of it.
 *
 * What the coach optimises is the season: the chance of still standing at the
 * end, without giving up too much of any one week to get there. So every mode
 * but `equity` keeps a floor on this week's chance, and the modes differ only
 * in what they rank the openings above it by:
 *
 *   safest    survival alone, the best mean across the futures (the default)
 *   balanced  the highest survival x leverage
 *   equity    the highest survival x leverage, with no floor
 *
 * And under all three, the week itself breaks the ties. The measure is a mean
 * over a sample of futures and it has a resolution; openings inside it are not
 * close, they are the same answer, and a coach that reads the last decimal of
 * them anyway is reading noise. So openings are banded by what they cost
 * against the best (TIE_MARGIN), and inside a band the best chance this week
 * leads. It matters most where a buy back covers the week: the season maths
 * then prices a loss at nothing, every legal opening comes back on the same
 * number, and the whole call falls to the band - which is to say, to the week.
 * The floor drops in that week too, since the season is not what is at risk.
 *
 * Pure and environment-free.
 */

/** What a pool that names no mode plays: survival alone. */
export const DEFAULT_MODE = "safest";

/**
 * The floor on this week's chance when the file names none. The season is the
 * goal, but not at the price of a week that is nearly a coin flip; the
 * survival-best opening is rarely under it, so it mostly bites where a buy
 * back makes a weak week look cheap.
 */
export const DEFAULT_FLOOR = 0.7;

/**
 * The floor in a week a buy back in hand covers: the loss costs the cushion,
 * not the season, so an opening the season maths likes is worth taking at a
 * weaker number - but no worse than a two-to-one favourite. Lower and the call
 * on the live board fell to a 60% team, which is a coin flip dressed up.
 */
export const COVERED_FLOOR = 2 / 3;

/**
 * How far apart two openings have to be on the mode's measure before the coach
 * will claim to know which is better, as a share of the best.
 *
 * The measure is a mean over SCENARIO_COUNT futures, so it carries the sample's
 * own error: paired against each other over the 128 futures, neighbouring
 * openings on the live NFL board separate with a standard error of about four
 * parts in a thousand of the mean. Half a percent is inside that - roughly one
 * standard error - so openings that close are one answer, not two, and what
 * decides between them is the week they actually have to win.
 *
 * The degenerate case is the one that made this necessary. Where a buy back in
 * hand covers the week and nothing the week could spend is wanted later, the
 * season maths returns the identical number for every legal opening - the
 * live board came back with 3.50028348194% against all thirty-two, from a 78%
 * favourite down to a 26% dog. Read strictly, that ordering is arbitrary.
 * Banded, it is the week's own chance, which is the only thing left that is
 * real.
 */
export const TIE_MARGIN = 0.005;

/**
 * Softmax temperature for the implied field, in units of win probability. At
 * 0.07 a typical NFL week's top favourite draws about 40% of the picks, the
 * second about 20%, and a coin flip next to nothing - the shape public pick
 * distributions show. College weeks, with a dozen teams above 90%, come out
 * spread thin, which is also what those pools look like.
 */
export const IMPLIED_TEMPERATURE = 0.07;

/** A field's hold rate when nothing is known about it: the shape of a favourite. */
const FALLBACK_HOLD = 0.75;

const MODES = ["safest", "equity", "balanced"];

/**
 * The field implied by the lines: each team's share of this week's picks.
 *
 * @param {Array<{team:string, winProb:number}>} options This week's options,
 *   both sides of every game; the dog's side comes out near zero on its own.
 * @param {number} [temperature]
 * @returns {Map<string,number>} Shares that sum to one.
 */
export function impliedPopularity(options, temperature = IMPLIED_TEMPERATURE) {
  const live = options.filter((option) => Number.isFinite(option.winProb));
  if (live.length === 0) return new Map();
  const top = Math.max(...live.map((option) => option.winProb));
  const weights = live.map((option) => Math.exp((option.winProb - top) / temperature));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return new Map(live.map((option, index) => [option.team, weights[index] / total]));
}

/**
 * The pool's numbers for this week, from the file when it has them and from
 * the lines when it does not, with every gap filled.
 *
 * @param {object|null} pool The parsed pool.json, or null.
 * @param {number} week This week.
 * @param {Array<object>|null} [options] This week's options, for the implied
 *   field. Without them a file that says nothing about the week is inactive,
 *   and no file at all is null.
 * @returns {{active:boolean, mode:string, floor:number, coveredFloor:number,
 *            tieMargin:number, source:"file"|"implied"|null,
 *            entriesAlive:number|null, popularity:Map<string,number>}|null}
 */
export function poolSettings(pool, week, options = null) {
  const file = pool && typeof pool === "object" ? pool : null;
  if (!file && !options) return null;

  const popularity = new Map();
  for (const [key, share] of Object.entries(file?.popularity ?? {})) {
    const [weekKey, team] = key.split("|");
    if (Number(weekKey) !== week || !Number.isFinite(share)) continue;
    popularity.set(team, Math.min(1, Math.max(0, share)));
  }
  const source = popularity.size > 0 ? "file" : options ? "implied" : null;
  const shares = source === "implied" ? impliedPopularity(options) : popularity;

  return {
    active: shares.size > 0,
    mode: MODES.includes(file?.mode) ? file.mode : DEFAULT_MODE,
    floor: Number.isFinite(file?.floor) ? file.floor : DEFAULT_FLOOR,
    coveredFloor: Number.isFinite(file?.coveredFloor) ? file.coveredFloor : COVERED_FLOOR,
    tieMargin: Number.isFinite(file?.tieMargin) ? file.tieMargin : TIE_MARGIN,
    source,
    entriesAlive: Number.isFinite(file?.entriesAlive) ? file.entriesAlive : null,
    popularity: shares,
  };
}

/**
 * What an entry in the field is worth after losing this week: nothing in an
 * ordinary week, and in a forgiving week the cushion it goes on without.
 *
 * The pool grants everyone the same buy backs, so a field that loses in a
 * forgiving week mostly plays on. What it has lost is the cover for the other
 * forgiving weeks, and an entry without it survives those at the field's own
 * hold rate - roughly the rate its favourites hold this week. One buy back
 * over two weeks comes out near three quarters either week; a pool that grants
 * more is covered at least that well, so this understates its cushion a
 * little rather than inventing a formula for it.
 *
 * @param {object} args
 * @param {number} args.week This week.
 * @param {Set<number>} args.forgiving The pool's buy back weeks.
 * @param {number} args.buyBacks What the pool grants everyone.
 * @param {Map<string,number>} args.popularity The field's shares this week.
 * @param {Array<{team:string, winProb:number}>} args.options This week's options.
 * @returns {number} 0 to 1.
 */
export function fieldCover({ week, forgiving, buyBacks, popularity, options }) {
  if (!(buyBacks > 0) || !forgiving.has(week)) return 0;
  const hold = expectedHold(popularity, options);
  return hold ** Math.max(0, forgiving.size - 1);
}

/** The share of the field expected to hold this week, by its shares and their chances. */
function expectedHold(popularity, options) {
  const byTeam = new Map(options.map((option) => [option.team, option]));
  let weighted = 0;
  let listed = 0;
  for (const [team, share] of popularity) {
    const winProb = byTeam.get(team)?.winProb;
    if (share <= 0 || !Number.isFinite(winProb)) continue;
    weighted += share * winProb;
    listed += share;
  }
  return listed > 0 ? weighted / listed : FALLBACK_HOLD;
}

/**
 * The share of the field expected to survive this week if the given picks
 * hold, and the leverage that implies.
 *
 * Every other entry's pick is drawn from the popularity shares. An entry on
 * one of your teams survives with you; an entry on one of their opponents
 * loses, and is worth `cover`; anyone else survives with their team's own
 * probability, and is worth `cover` when they do not. Shares that add to less
 * than one are the field on teams nobody listed, given the average of the
 * listed ones. A two-pick pool's entries need both to hold, so the field's
 * rate is raised to that power.
 *
 * @param {object} args
 * @param {string[]} args.teams Your picks this week.
 * @param {Array<{team:string, opponent:string, winProb:number}>} args.options
 *   This week's options.
 * @param {Map<string,number>} args.popularity Share of the field on each team.
 * @param {number} args.picksPerWeek
 * @param {number} [args.cover] What a losing entry is still worth (see fieldCover).
 * @returns {{fieldSurvival:number, leverage:number, popularity:number}}
 *   `popularity` is the share of the field on your own pick(s), averaged.
 */
export function fieldAfterWeek({ teams, options, popularity, picksPerWeek = 1, cover = 0 }) {
  const byTeam = new Map(options.map((option) => [option.team, option]));
  const mine = new Set(teams);
  const opponents = new Set(teams.map((team) => byTeam.get(team)?.opponent).filter(Boolean));
  const worth = (hold) => hold + (1 - hold) * cover;

  let weighted = 0;
  let listed = 0;
  for (const [team, share] of popularity) {
    if (share <= 0) continue;
    listed += share;
    if (mine.has(team)) weighted += share;
    else if (opponents.has(team)) weighted += share * cover;
    else weighted += share * worth(byTeam.get(team)?.winProb ?? 0.5);
  }
  const average = listed > 0 ? weighted / listed : worth(0.5);
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

/** What the mode ranks openings by. */
const measureOf = (mode) => (mode === "safest" ? (c) => c.scenarioMean : (c) => c.equity);

/**
 * A week's openings in the order the coach would take them: the season first,
 * as far as the futures can actually see it, and the chance this week wherever
 * they cannot.
 *
 * Each opening is banded by what it costs against the best on the mode's
 * measure, in steps of `tieMargin`, and the band is what is compared first.
 * Inside one band the best chance this week leads, and the measure itself is
 * only the tie break of last resort. Banding rather than comparing with a
 * tolerance is deliberate: a tolerance is not transitive, and a sort on an
 * inconsistent comparator is an order nobody can predict or reproduce. The
 * band is a number each opening carries on its own, so the order is total.
 *
 * @param {Array<object>} candidates Carrying `weekWinProb`, `scenarioMean`,
 *   `season` and, when the field is priced, `equity`.
 * @param {string} [mode]
 * @param {number} [tieMargin] Zero bands nothing and reads the measure
 *   strictly, which is what a caller after the untilted optimum wants.
 * @returns {Array<object>} A new array; the input is left alone.
 */
export function rankOpenings(candidates, mode = DEFAULT_MODE, tieMargin = TIE_MARGIN) {
  const measure = measureOf(mode);
  const rank = mode === "safest" ? bySurvival : byEquity;
  if (!(tieMargin > 0)) return [...candidates].sort(rank);

  const value = (candidate) => (Number.isFinite(measure(candidate)) ? measure(candidate) : 0);
  const best = Math.max(0, ...candidates.map(value));
  // Everything sits in band 0 when the best is nothing, which is the honest
  // reading of a week no opening survives: the week is all there is to go on.
  const band = (candidate) =>
    best > 0 ? Math.floor((1 - value(candidate) / best) / tieMargin) : 0;
  return candidates
    .map((candidate) => ({ candidate, band: band(candidate) }))
    .sort(
      (a, b) =>
        a.band - b.band ||
        b.candidate.weekWinProb - a.candidate.weekWinProb ||
        rank(a.candidate, b.candidate),
    )
    .map((entry) => entry.candidate);
}

/**
 * The opening the mode calls, from candidates already carrying `weekWinProb`,
 * `scenarioMean`, `season` and, when the field is priced, `equity`.
 *
 * @param {Array<object>} candidates
 * @param {{mode:string, floor:number, coveredFloor?:number, tieMargin?:number}} settings
 * @param {object} [state]
 * @param {boolean} [state.covered] This week is forgiving and a buy back is in
 *   hand, so a loss costs the cushion rather than the season. The floor drops
 *   to match; nothing else about the call changes, because a week the season
 *   maths has already priced at nothing needs no second rule about it.
 * @returns {object|null} The chosen candidate, or null with none to choose.
 */
export function chooseCall(
  candidates,
  { mode, floor, coveredFloor = COVERED_FLOOR, tieMargin = TIE_MARGIN },
  { covered = false } = {},
) {
  if (candidates.length === 0) return null;

  // The floor: nothing under it while anything is over it. Equity mode has none.
  const bar = covered ? Math.min(floor, coveredFloor) : floor;
  const eligible = candidates.filter((candidate) => candidate.weekWinProb >= bar);
  const field = mode !== "equity" && eligible.length > 0 ? eligible : candidates;
  return rankOpenings(field, mode, tieMargin)[0];
}

/** Best across the futures; on the numbers as they stand when they cannot separate two. */
export function bySurvival(a, b) {
  return b.scenarioMean - a.scenarioMean || b.season - a.season || b.weekWinProb - a.weekWinProb;
}

/** Best equity; survival across the futures when equity cannot separate two. */
export function byEquity(a, b) {
  return b.equity - a.equity || bySurvival(a, b);
}

/**
 * Lay the pool's numbers over a frontier: each candidate's popularity,
 * leverage and equity (survival across futures times leverage), and which
 * opening the mode prefers. The engine runs this on its own candidates before
 * it names the call (core/recommend.js), so on a board the preferred opening
 * IS the call; on a frontier handed in from elsewhere `chosen` is left as it
 * came and `preferred` says what the pool would do.
 *
 * @param {object} args
 * @param {object|null} args.frontier From recommendPath.
 * @param {Array<object>} args.options This week's options.
 * @param {object|null} args.pool The parsed pool.json.
 * @param {number} args.picksPerWeek
 * @param {Set<number>} [args.forgiving] The pool's buy back weeks.
 * @param {number} [args.poolBuyBacks] What the pool grants everyone.
 * @param {boolean} [args.covered] A buy back in hand covers this week.
 * @returns {object|null} The decorated frontier, or the original with
 *   `pool: null` when nothing can be said about the week.
 */
export function equityOverlay({
  frontier,
  options,
  pool,
  picksPerWeek = 1,
  forgiving = new Set(),
  poolBuyBacks = 0,
  covered = false,
}) {
  if (!frontier) return frontier;
  const settings = poolSettings(pool, frontier.week, options);
  if (!settings?.active) return { ...frontier, pool: null };

  const cover = fieldCover({
    week: frontier.week,
    forgiving,
    buyBacks: poolBuyBacks,
    popularity: settings.popularity,
    options,
  });
  const candidates = frontier.candidates.map((candidate) => {
    const field = fieldAfterWeek({
      teams: candidate.teams,
      options,
      popularity: settings.popularity,
      picksPerWeek,
      cover,
    });
    return {
      ...candidate,
      popularity: field.popularity,
      fieldSurvival: field.fieldSurvival,
      leverage: field.leverage,
      equity: candidate.scenarioMean * field.leverage,
    };
  });

  const preferred = chooseCall(candidates, settings, { covered });
  const bestEquity = Math.max(...candidates.map((candidate) => candidate.equity));

  return {
    ...frontier,
    candidates: candidates.map((candidate) => ({
      ...candidate,
      equityCost: bestEquity > 0 ? 1 - candidate.equity / bestEquity : 0,
      preferred: candidate === preferred,
    })),
    pool: {
      mode: settings.mode,
      floor: covered ? Math.min(settings.floor, settings.coveredFloor) : settings.floor,
      margin: settings.tieMargin,
      source: settings.source,
      cover,
      covered,
      entriesAlive: settings.entriesAlive,
      preferred: preferred ? { teams: preferred.teams } : null,
    },
  };
}
