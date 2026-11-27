/**
 * The NFL postseason, for a pool that plays on into it.
 *
 * A regular week is a list of games the schedule fixed in the spring. A playoff
 * round is not: who plays in it is decided by the round before, and before the
 * regular season ends nobody knows who is in it at all. A team that loses is
 * out, and a pool that forbids a team twice all season has to have someone
 * left to pick in the Super Bowl - one game, two teams - after picking its way
 * through eighteen weeks and three rounds. That is the whole difficulty, and it
 * is what makes a strong team worth keeping in December: not for the week it
 * would win, but for the round in January where nothing else is left.
 *
 * Three layers, all pure:
 *
 *   1. The field. Once the wild card games are posted the bracket is a fact
 *      (`seedsFromBracket`). Before that it is a distribution: the rest of the
 *      regular season is played out many times over, each team's record
 *      tallied, and the conference seeded the way the league does it - division
 *      winners first, then the three best of the rest (`simulateFields`). The
 *      tie-breakers are the league's in outline, not to the letter: record,
 *      head to head, division then conference record, then a coin.
 *
 *   2. The bracket, solved exactly for each field (`fieldSolver`). The pick is
 *      made with the round's matchups in front of you, so the value of a set of
 *      teams in hand is not a fixed path but a policy: in each round, given who
 *      is still alive and which of them you have spent, take the pick whose
 *      survival, carried through every way the rest of the bracket can go, is
 *      best. Four rounds of at most six games is small enough to enumerate, so
 *      this is a dynamic programme over the bracket rather than a search.
 *
 *   3. What that is worth to the regular season (`postseasonFor`). The
 *      regular-season search is additive - a log probability per pick - and the
 *      value of what is left for January is not. So each team gets a price:
 *      how much the postseason's chance falls if that team is spent before it.
 *      The search pays the price for every team it spends, and the paths it
 *      finds are then re-scored on the exact value of what they leave (the same
 *      two-pass shape the buy backs have in core/recommend.js).
 *
 * The board shows a round that is not set yet as the coach's likeliest pick
 * there and the chance that round holds given the run got that far. Those
 * chances multiply to the bracket's exact value, so the season number on the
 * drive line is the regular season and the playoffs together, priced as one.
 *
 * Everything here is seeded, so the refresh job and the browser agree and a
 * board does not flicker between renders.
 */

import { seededRandom } from "./scenarios.js";
import { projectSpread, winProbFromSpread } from "./probability.js";

/** The rounds, in the order they are played. A plan's playoff week names one. */
export const ROUND_ORDER = Object.freeze(["wildcard", "divisional", "conference", "superbowl"]);

/** What each round is called: on its own, on a tag, and in a sentence. */
export const ROUND_NAMES = Object.freeze({
  wildcard: { name: "Wild Card", short: "WC", phrase: "the Wild Card round" },
  divisional: { name: "Divisional", short: "DIV", phrase: "the Divisional round" },
  conference: { name: "Conference", short: "CONF", phrase: "the Conference round" },
  superbowl: { name: "Super Bowl", short: "SB", phrase: "the Super Bowl" },
});

const CONFERENCES = ["AFC", "NFC"];

/** Teams per conference in the bracket. */
const SEEDS = 7;

/**
 * Regular seasons played out to seed the field, before the bracket is set.
 * Identical fields are merged, so late in the season this is far fewer brackets
 * to solve than it sounds; early on it is the precision the price of a team is
 * read at, and every path is judged against the same set (common random
 * numbers), so two paths are compared far more steadily than either is valued.
 *
 * 32. Measured on the NFL board in week 11, the top nine prices at 32 fields
 * were within 0.03 of what 128 fields gave (the Bills 0.52 against 0.48, the
 * 49ers 0.37 against 0.41), the bracket's value within a tenth of a point, and
 * the order of the teams the same but for one pair. Each field is a bracket
 * solved fifteen-odd times over for the prices, which is most of what this file
 * costs, and that cost is paid in the worker.
 */
export const FIELD_COUNT = 32;

const FIELD_SEED = 20270116;

/**
 * Picks considered in a round, best chance first. A pick far down this list is
 * never the one to make - keeping a better team back is the only reason to
 * take a weaker one, and the eighth-best side of six games is not that.
 */
const SINGLE_WIDTH = 8;

/** The same for a two-pick pool, where every pair from these is weighed. */
const PAIR_WIDTH = 6;

/** The conference a division belongs to: "AFC East" is the AFC. */
export function conferenceOf(division) {
  const head = String(division ?? "").split(" ")[0];
  return CONFERENCES.includes(head) ? head : null;
}

/**
 * The seeds the posted wild card games say, or null when they do not say it.
 *
 * The games give away most of the bracket: the three home sides in a
 * conference are seeds two to four and their opponents seven, six and five, in
 * that pairing. The team with the bye is the one conference team with the best
 * record that is not in a game - no team outside the bracket can match the top
 * seed's record without seven teams matching it. What the games do not give is
 * the order of the three home sides, which is record and then the league's
 * tie-breakers; those are applied here in outline (see `compareTeams`), with
 * the season's point differential before the name as the last word. A wrong
 * guess between two division winners on the same record only moves who plays
 * the top seed in a round that has not been posted, and the round itself
 * replaces it the moment it is.
 *
 * @param {object} args
 * @param {Object<string,string>} args.teams Team to division.
 * @param {Array<{home:string, away:string, winner:string|null, margin?:number}>} args.regular
 *   Every regular-season game, with the winner where it has been played.
 * @param {Array<{home:string, away:string}>} args.wildcard The posted wild card games.
 * @returns {{AFC:string[], NFC:string[]}|null}
 */
export function seedsFromBracket({ teams, regular, wildcard }) {
  if (!Array.isArray(wildcard) || wildcard.length !== 6) return null;
  const names = Object.keys(teams).sort();
  const index = new Map(names.map((team, at) => [team, at]));
  const table = tableOf(names, teams);
  const records = emptyRecords(names.length);
  for (const game of regular) {
    if (!game.winner) continue;
    tally(records, table, index.get(game.home), index.get(game.away), game.winner === game.home);
  }
  // The season's point differential, as the last word before the name.
  const differential = new Float64Array(names.length);
  for (const game of regular) {
    if (!Number.isFinite(game.margin)) continue;
    differential[index.get(game.home)] += game.margin;
    differential[index.get(game.away)] -= game.margin;
  }
  const coin = Array.from(names, (_, at) => differential[at] / 1000 - at / 1e6);
  const compare = compareTeams(records, table, coin);

  const seeds = {};
  for (const conference of CONFERENCES) {
    const games = wildcard.filter((game) => conferenceOf(teams[game.home]) === conference);
    if (games.length !== 3) return null;
    if (games.some((game) => conferenceOf(teams[game.away]) !== conference)) return null;
    const playing = new Set(games.flatMap((game) => [game.home, game.away]));
    const bye = names
      .map((team, at) => ({ team, at }))
      .filter(({ team }) => conferenceOf(teams[team]) === conference && !playing.has(team))
      .sort((a, b) => compare(a.at, b.at))[0];
    if (!bye) return null;
    const hosts = [...games].sort((a, b) => compare(index.get(a.home), index.get(b.home)));
    seeds[conference] = [
      bye.team,
      ...hosts.map((game) => game.home),
      // Seed 2 plays 7, 3 plays 6, 4 plays 5.
      ...hosts.map((game) => game.away).reverse(),
    ];
  }
  return seeds;
}

/**
 * Whether a seeding names fourteen distinct teams the roster knows, seven to a
 * conference and each in its own. A hand-kept override is trusted only then.
 */
export function validSeeds(seeds, teams) {
  if (!seeds || typeof seeds !== "object") return false;
  const seen = new Set();
  for (const conference of CONFERENCES) {
    const list = seeds[conference];
    if (!Array.isArray(list) || list.length !== SEEDS) return false;
    for (const team of list) {
      if (seen.has(team) || conferenceOf(teams[team]) !== conference) return false;
      seen.add(team);
    }
  }
  return true;
}

/**
 * Fields the rest of the regular season might seed, played out from one seed.
 *
 * Games already played keep their winners; every other game is decided by its
 * own probability, the one the board prices the game at. The same function
 * seeds each one, so a field is the league's bracket for a regular season that
 * could happen.
 *
 * @returns {Array<{seeds:{AFC:string[], NFC:string[]}, weight:number}>} Identical
 *   fields merged, weights summing to one.
 */
export function simulateFields({ teams, regular, count = FIELD_COUNT, seed = FIELD_SEED }) {
  const names = Object.keys(teams).sort();
  const index = new Map(names.map((team, at) => [team, at]));
  const table = tableOf(names, teams);
  const base = emptyRecords(names.length);
  const open = [];
  for (const game of regular) {
    const home = index.get(game.home);
    const away = index.get(game.away);
    if (home === undefined || away === undefined) continue;
    if (game.winner) tally(base, table, home, away, game.winner === game.home);
    else open.push({ home, away, p: clamp01(game.pHome ?? 0.5) });
  }

  const merged = new Map();
  for (let run = 0; run < count; run += 1) {
    const random = seededRandom(seed + run * 7919);
    const records = copyRecords(base);
    for (const game of open) tally(records, table, game.home, game.away, random() < game.p);
    const coin = Array.from(names, () => random());
    const seeds = seedLeague(names, table, records, compareTeams(records, table, coin));
    const key = CONFERENCES.map((conference) => seeds[conference].join(",")).join("|");
    const held = merged.get(key);
    if (held) held.weight += 1 / count;
    else merged.set(key, { seeds, weight: 1 / count });
  }
  return [...merged.values()];
}

/**
 * The postseason a board's search plans around, from the plain data the board
 * hands over (core/plan.js postseasonSpec) and the state of the entry.
 *
 * Built once per spec and kept, because a board asks for several searches over
 * the same postseason - its plan, a week's advice, a lock rehearsed - and they
 * differ only in what is spent, which the solvers already key on.
 *
 * @param {object} spec See core/plan.js postseasonSpec.
 * @param {object} context
 * @param {object} context.model The probability model.
 * @param {"win"|"lose"} context.objective
 * @param {number} context.picksPerWeek
 * @param {Object<number,string[]>} context.fixed Locked teams by playoff week.
 * @param {number} context.from The first week the plan covers.
 */
export function postseasonFor(
  spec,
  { model, objective = "win", picksPerWeek = 1, fixed = {}, from, fieldCount = FIELD_COUNT },
) {
  const key = JSON.stringify([spec, model, objective, picksPerWeek, fixed, from, fieldCount]);
  const held = built.find((entry) => entry.key === key);
  if (held) return held.value;
  const value = buildPostseason(spec, { model, objective, picksPerWeek, fixed, from, fieldCount });
  built.unshift({ key, value });
  built.length = Math.min(built.length, 2);
  return value;
}

/** The postseasons built lately, newest first. */
const built = [];

function buildPostseason(spec, { model, objective, picksPerWeek, fixed, from, fieldCount }) {
  const rounds = ROUND_ORDER.map((round) => spec.rounds.find((entry) => entry.round === round));
  const runRounds = rounds.map((entry, k) => ({ entry, k })).filter(({ entry }) => entry?.inRun);
  if (runRounds.length === 0) return null;
  const lastK = runRounds.at(-1).k;
  // A round in the run that is already behind the plan is history: its picks
  // are spent and its games are results, so it is played as chance.
  const firstPick = runRounds.find(({ entry }) => entry.week >= from)?.k ?? lastK + 1;

  const fields =
    spec.seeds && validSeeds(spec.seeds, spec.teams)
      ? [{ seeds: spec.seeds, weight: 1 }]
      : simulateFields({ teams: spec.teams, regular: spec.regular ?? [], count: fieldCount });

  // Every posted playoff game, by week and by the pair, for its line and its result.
  const posted = new Map();
  for (const entry of rounds) {
    if (!entry) continue;
    const games = spec.games?.[entry.week] ?? [];
    posted.set(entry.week, new Map(games.map((game) => [pairKey(game.home, game.away), game])));
  }

  // A game nobody has posted is priced off the ratings, at the site the
  // bracket gives it and as far out as it is.
  const projected = new Map();
  const projectedHomeWin = (k, home, away) => {
    const id = `${k}|${home}|${away}`;
    if (projected.has(id)) return projected.get(id);
    const neutral = rounds[k]?.round === "superbowl";
    const weeksAhead = Math.max(0, (rounds[k]?.week ?? 0) - (spec.currentWeek ?? 0));
    const spread = projectSpread(
      spec.rating?.[home] ?? 0,
      spec.rating?.[away] ?? 0,
      !neutral,
      neutral ? 0 : (spec.homeField ?? 2),
    );
    const p = winProbFromSpread(spread, model, { weeksAhead });
    projected.set(id, p);
    return p;
  };

  const solvers = fields.map(({ seeds, weight }) => ({
    weight,
    solver: fieldSolver({
      seeds: [...seeds.AFC, ...seeds.NFC],
      rounds,
      posted,
      projectedHomeWin,
      objective,
      picksPerWeek,
      firstPick,
      lastK,
      fixed,
    }),
  }));

  const valueOf = (used) =>
    solvers.reduce((total, { weight, solver }) => total + weight * solver.value(used), 0);

  let pricesHeld = null;
  let baseHeld = null;

  return {
    fields: fields.length,
    rounds: runRounds.map(({ entry }) => entry.week),
    /** The chance of surviving the postseason with these teams spent, exactly. */
    value: (used) => valueOf(used),
    /**
     * What each team costs the postseason if it is spent before it, as a log:
     * the value with everything in `burned` spent, against the value with this
     * team spent too. Zero for a team no field has in it.
     */
    prices(burned) {
      if (pricesHeld?.burned === burnedKey(burned)) return pricesHeld.prices;
      const base = valueOf(burned);
      const losses = new Map();
      for (const { weight, solver } of solvers) {
        const own = solver.value(burned);
        const taken = solver.picked(burned);
        for (const team of solver.teams) {
          if (burned.has(team) || !taken.has(team)) continue;
          const without = solver.value(burned, team);
          losses.set(team, (losses.get(team) ?? 0) + weight * (own - without));
        }
      }
      const prices = new Map();
      for (const [team, loss] of losses) {
        const after = base - loss;
        prices.set(team, base > 0 ? Math.max(0, Math.log(base / Math.max(after, 1e-9))) : 0);
      }
      pricesHeld = { burned: burnedKey(burned), prices };
      baseHeld = { burned: burnedKey(burned), value: base };
      return prices;
    },
    /**
     * The value of a set of teams spent, read off the prices rather than
     * solved: what the burned set is worth, less the price of everything spent
     * on top of it. Cheap enough for the futures, which ask it thousands of
     * times; the finalists are scored with `value`.
     */
    approx(burned, used) {
      const prices = this.prices(burned);
      const base = baseHeld?.value ?? valueOf(burned);
      let cost = 0;
      for (const team of used) {
        if (!burned.has(team)) cost += prices.get(team) ?? 0;
      }
      return base * Math.exp(-cost);
    },
    /**
     * The postseason as the coach would play it with these teams spent, round
     * by round: how often the run reaches the round, how often it comes through
     * given that it did, and who it takes there and how often. The chances
     * multiply to `value`.
     */
    project(used) {
      const totals = new Map();
      for (const { weight, solver } of solvers) solver.walk(used, weight, totals);
      return runRounds
        .filter(({ k }) => k >= firstPick)
        .map(({ entry, k }) => {
          const round = totals.get(k) ?? { reach: 0, survive: 0, picks: new Map() };
          const picks = [...round.picks]
            .map(([team, mass]) => ({ team, share: round.reach > 0 ? mass / round.reach : 0 }))
            .sort((a, b) => b.share - a.share || a.team.localeCompare(b.team));
          return {
            week: entry.week,
            round: entry.round,
            reach: round.reach,
            winProb: round.reach > 0 ? round.survive / round.reach : 0,
            picks,
            // Played out with nothing picked: carried through, short rather
            // than lost (see setsOf).
            passed: Boolean(round.passed),
          };
        });
    },
    /**
     * The first round still to pick, as it stands: every pick it can take,
     * best first, and what each one is worth with the rest of the bracket
     * played the coach's way. Only for a bracket that is set and a round that
     * is posted; null otherwise.
     */
    rank(used) {
      if (solvers.length !== 1) return null;
      return solvers[0].solver.rank(used);
    },
  };
}

/**
 * One field's bracket, solved.
 *
 * Positions 0-6 are the AFC's seeds one to seven and 7-13 the NFC's. A state is
 * the round, who is still alive and which of the living have been spent; dead
 * teams cannot be picked, so what was spent on them stops mattering.
 */
function fieldSolver({
  seeds,
  rounds,
  posted,
  projectedHomeWin,
  objective,
  picksPerWeek,
  firstPick,
  lastK,
  fixed,
}) {
  const position = new Map(seeds.map((team, at) => [team, at]));
  const ALL = (1 << seeds.length) - 1;
  const losers = objective === "lose";
  const roundsHeld = new Map();

  // Locks in the rounds still to pick, by round, as positions. A team locked
  // into a later round is kept back from the rounds before it.
  const fixedAt = rounds.map((entry) =>
    (fixed?.[entry?.week] ?? []).map((team) => position.get(team)).filter((at) => at !== undefined),
  );
  const fixedMask = fixedAt.reduce(
    (mask, list, k) => (k >= firstPick ? list.reduce((m, at) => m | (1 << at), mask) : mask),
    0,
  );
  const laterFixedMask = rounds.map((_, k) =>
    fixedAt.reduce(
      (mask, list, at) => (at > k ? list.reduce((m, pos) => m | (1 << pos), mask) : mask),
      0,
    ),
  );

  /** The round's games for who is alive: the bracket's, or the posted ones. */
  function pairsFor(k, alive) {
    const living = (from) => {
      const out = [];
      for (let seed = 0; seed < SEEDS; seed += 1) {
        if (alive & (1 << (from + seed))) out.push(from + seed);
      }
      return out;
    };
    let pairs = [];
    if (k === 3) {
      const [afc] = living(0);
      const [nfc] = living(SEEDS);
      if (afc !== undefined && nfc !== undefined) pairs = [[afc, nfc]];
    } else {
      for (const from of [0, SEEDS]) {
        const list = living(from);
        if (k === 0) {
          // The top seed sits out; two plays seven, three six, four five.
          for (const [a, b] of [
            [1, 6],
            [2, 5],
            [3, 4],
          ]) {
            if (alive & (1 << (from + a)) && alive & (1 << (from + b))) {
              pairs.push([from + a, from + b]);
            }
          }
        } else {
          // Re-seeded: the best seed left hosts the worst, and so inwards.
          for (let i = 0, j = list.length - 1; i < j; i += 1, j -= 1)
            pairs.push([list[i], list[j]]);
        }
      }
    }
    // A round that has been posted is played as posted. Where the posted games
    // are not the bracket's - a seed guessed wrong - the posting wins.
    const games = posted.get(rounds[k]?.week);
    if (games && games.size > 0) {
      const fromPosting = [];
      for (const game of games.values()) {
        const home = position.get(game.home);
        const away = position.get(game.away);
        if (home === undefined || away === undefined) continue;
        if (!(alive & (1 << home)) || !(alive & (1 << away))) continue;
        fromPosting.push([home, away]);
      }
      // A round posted only in part keeps the bracket's games: the posted ones
      // are among them, and the rest are still to be announced.
      const bracket = new Set(pairs.map(([a, b]) => pairKey(seeds[a], seeds[b])));
      const agrees = fromPosting.every(([a, b]) => bracket.has(pairKey(seeds[a], seeds[b])));
      if (!agrees && fromPosting.length === pairs.length) pairs = fromPosting;
    }
    return pairs.map(([home, away]) => ({ home, away, p: homeWin(k, home, away) }));
  }

  /**
   * The chance the home side wins: decided, posted, or projected. Asked for
   * every time a round's games are laid out, so it is worked out once per
   * round and pairing and read from a table after that.
   */
  const homeWins = new Float64Array(4 * seeds.length * seeds.length).fill(-1);
  function homeWin(k, home, away) {
    const at = (k * seeds.length + home) * seeds.length + away;
    if (homeWins[at] < 0) homeWins[at] = priceHomeWin(k, home, away);
    return homeWins[at];
  }
  function priceHomeWin(k, home, away) {
    const game = posted.get(rounds[k]?.week)?.get(pairKey(seeds[home], seeds[away]));
    const flip = game && game.home !== seeds[home];
    if (game?.winner) return game.winner === seeds[home] ? 1 : 0;
    if (game && Number.isFinite(game.pHome)) return flip ? 1 - game.pHome : game.pHome;
    return projectedHomeWin(k, seeds[home], seeds[away]);
  }

  /**
   * A round with a given set of survivors: its games, every way they can go
   * and who is left after each, every pick it could take, and what each state
   * of it is worth once worked out.
   *
   * The states are the ways the survivors can have been spent, and only the
   * survivors matter - so a round of eight teams has 256 of them, kept in a
   * flat array indexed by which of the eight are spent (`slotOf`), rather than
   * a hash of the whole field's spending. Each outcome points at the round it
   * leads to once that has been asked for, so walking the bracket costs no
   * lookups at all.
   */
  function roundOf(k, alive) {
    const id = k * 16384 + alive;
    const held = roundsHeld.get(id);
    if (held) return held;
    const games = pairsFor(k, alive);
    const outs = [];
    for (let mask = 0; mask < 1 << games.length; mask += 1) {
      let prob = 1;
      let next = alive;
      for (let j = 0; j < games.length; j += 1) {
        const { home, away, p } = games[j];
        if (mask & (1 << j)) {
          prob *= p;
          next &= ~(1 << away);
        } else {
          prob *= 1 - p;
          next &= ~(1 << home);
        }
      }
      if (prob > 0) outs.push({ mask, prob, next, round: null });
    }
    const living = [];
    for (let at = 0; at < seeds.length; at += 1) if (alive & (1 << at)) living.push(at);
    const round = {
      k,
      alive,
      living,
      games,
      outs,
      // Fourteen survivors is the opening round alone, asked about a handful
      // of times; a map is plenty there and 16384 slots are not.
      values: living.length > 10 ? new Map() : new Float64Array(1 << living.length).fill(-1),
      ...setsOf(k, games),
    };
    roundsHeld.set(id, round);
    return round;
  }

  /**
   * The most any state of a round onwards can be worth: the best chance any
   * game the round could hold offers, times the same for every round after.
   * What lets a state stop weighing picks once the next could not beat the
   * best so far even if everything after it went its way.
   */
  const ceiling = new Float64Array(lastK + 2).fill(1);
  for (let k = lastK; k >= 0; k -= 1) {
    let best = k >= firstPick ? 0 : 1;
    if (k >= firstPick) {
      for (let a = 0; a < seeds.length; a += 1) {
        for (let b = a + 1; b < seeds.length; b += 1) {
          const sameConference = a < SEEDS === b < SEEDS;
          if ((k === 3) === sameConference) continue;
          const p = homeWin(k, a, b);
          best = Math.max(best, p, 1 - p);
        }
      }
    }
    ceiling[k] = best * ceiling[k + 1];
  }

  /** The round an outcome leads to, found once and then kept on the outcome. */
  const after = (round, out) => (out.round ??= roundOf(round.k + 1, out.next));

  /** Which of a round's survivors are spent, as a compact index into its states. */
  function slotOf(round, used) {
    let slot = 0;
    const { living } = round;
    for (let i = 0; i < living.length; i += 1) if (used & (1 << living[i])) slot |= 1 << i;
    return slot;
  }

  /**
   * Every pick a round could take, best chance first, worked out once per
   * round and set of survivors: one team, or a pair from two games. A set
   * holds in an outcome when each of its games went the way it needs - game
   * `j` with the home side winning exactly when `need` is 1. Which of them are
   * still open depends on what has been spent, and is read off as they are
   * walked (`open`), so a state costs no allocation.
   */
  function setsOf(k, games) {
    // A lock in this round is in every set it can take, however far down the
    // list that is. A lock on a team not in the round's games cannot bind.
    const locked = fixedAt[k] ?? [];
    const lockMask = locked.every((at) => games.some((g) => g.home === at || g.away === at))
      ? locked.reduce((mask, at) => mask | (1 << at), 0)
      : 0;
    // A game already played is no pick anyone can still make - only the lock
    // that was made on it before kickoff. A round played out with nothing
    // locked in it is a pick that was never made: the run is carried through
    // it the way a missed regular week is, short rather than lost, and the
    // board marks the miss (missedSlot in core/amend.js).
    const decided = (game) => game.p === 0 || game.p === 1;
    const passThrough = games.every(decided) && lockMask === 0;
    const takeable = (game, at) => !decided(game) || Boolean(lockMask & (1 << at));

    const singles = [];
    for (let j = 0; j < games.length; j += 1) {
      const { home, away, p } = games[j];
      if (takeable(games[j], home)) {
        singles.push({
          bits: 1 << home,
          j,
          need: losers ? 0 : 1,
          j2: -1,
          need2: 0,
          chance: losers ? 1 - p : p,
        });
      }
      if (takeable(games[j], away)) {
        singles.push({
          bits: 1 << away,
          j,
          need: losers ? 1 : 0,
          j2: -1,
          need2: 0,
          chance: losers ? p : 1 - p,
        });
      }
    }
    singles.sort((a, b) => b.chance - a.chance);
    const need = Math.min(picksPerWeek, games.length);
    let sets = singles;
    let width = SINGLE_WIDTH;
    if (need > 1) {
      sets = [];
      for (let a = 0; a < singles.length; a += 1) {
        for (let b = a + 1; b < singles.length; b += 1) {
          if (singles[a].j === singles[b].j) continue;
          sets.push({
            bits: singles[a].bits | singles[b].bits,
            j: singles[a].j,
            need: singles[a].need,
            j2: singles[b].j,
            need2: singles[b].need,
            chance: singles[a].chance * singles[b].chance,
          });
        }
      }
      sets.sort((a, b) => b.chance - a.chance);
      width = (PAIR_WIDTH * (PAIR_WIDTH - 1)) / 2;
    }
    return {
      sets,
      width: lockMask ? Infinity : width,
      lockMask,
      blockedLater: laterFixedMask[k],
      passThrough,
    };
  }

  /** Whether a round asks for a pick: one the plan covers, not played out unpicked. */
  const picking = (round) => round.k >= firstPick && !round.passThrough;

  /** Whether a set is open: nothing in it spent, and every lock of its round in it. */
  const open = (set, blocked, lockMask) =>
    !(set.bits & blocked) && (set.bits & lockMask) === lockMask;

  const holds = (set, mask) =>
    ((mask >> set.j) & 1) === set.need && (set.j2 < 0 || ((mask >> set.j2) & 1) === set.need2);

  /** What a set is worth in a state: its survival, carried through the rest. */
  function worth(round, set, used) {
    let total = 0;
    const spent = used | set.bits;
    const last = round.k === lastK;
    for (const out of round.outs) {
      if (holds(set, out.mask)) total += out.prob * (last ? 1 : solve(after(round, out), spent));
    }
    return total;
  }

  /** The best the coach can do from a state of a round. */
  function solve(round, used) {
    const { k } = round;
    used &= round.alive;
    const blocked = used | round.blockedLater;
    if (k === lastK && picking(round)) {
      // The last round carries nothing forward: a set is worth its chance,
      // and the first open one has the best. Cheaper to read than to keep.
      for (const set of round.sets) if (open(set, blocked, round.lockMask)) return set.chance;
      return 0;
    }
    const { values } = round;
    const slot = slotOf(round, used);
    const held = values instanceof Map ? values.get(slot) : values[slot];
    if (held !== undefined && held >= 0) return held;
    let best = 0;
    if (!picking(round)) {
      for (const out of round.outs) {
        best += out.prob * (k === lastK ? 1 : solve(after(round, out), used));
      }
    } else {
      let taken = 0;
      for (const set of round.sets) {
        if (!open(set, blocked, round.lockMask)) continue;
        // A set is worth at most its own chance times the ceiling of what
        // follows, and the sets come best chance first, so once the best so
        // far is worth more than the next could be, none after it can win.
        if (taken === round.width || set.chance * ceiling[k + 1] <= best) break;
        taken += 1;
        const total = worth(round, set, used);
        if (total > best) best = total;
      }
    }
    if (values instanceof Map) values.set(slot, best);
    else values[slot] = best;
    return best;
  }

  /** The pick the coach makes in a state, or null when there is none to make. */
  function choose(round, used) {
    const blocked = (used & round.alive) | round.blockedLater;
    let chosen = null;
    let best = -1;
    let taken = 0;
    for (const set of round.sets) {
      if (!open(set, blocked, round.lockMask)) continue;
      if (taken === round.width || set.chance * ceiling[round.k + 1] <= best) break;
      taken += 1;
      const total = worth(round, set, used & round.alive);
      if (total > best + 1e-12) {
        best = total;
        chosen = set;
      }
    }
    return chosen;
  }

  /** The open picks of a state, best chance first, as many as a round weighs. */
  function candidates(round, used) {
    const blocked = (used & round.alive) | round.blockedLater;
    const out = [];
    for (const set of round.sets) {
      if (!open(set, blocked, round.lockMask)) continue;
      if (out.length === round.width) break;
      out.push(set);
    }
    return out;
  }

  const maskOf = (spent, extra = null) => {
    let mask = 0;
    for (const team of spent) {
      const at = position.get(team);
      if (at !== undefined) mask |= 1 << at;
    }
    if (extra !== null && position.has(extra)) mask |= 1 << position.get(extra);
    // A lock still to be played is spent for every other round, but its own
    // round must still be able to take it.
    return mask & ~fixedMask;
  };

  const root = () => roundOf(0, ALL);

  return {
    teams: seeds,
    value(spent, extra = null) {
      return solve(root(), maskOf(spent, extra));
    },
    walk(spent, weight, totals) {
      const visit = (round, used, mass) => {
        const { k } = round;
        if (mass <= 0) return;
        used &= round.alive;
        if (!picking(round)) {
          // A round played out with nothing picked is carried through whole.
          if (k >= firstPick) {
            const tally = totals.get(k) ?? { reach: 0, survive: 0, picks: new Map() };
            totals.set(k, tally);
            tally.reach += mass;
            tally.survive += mass;
            tally.passed = true;
          }
          if (k === lastK) return;
          for (const out of round.outs) visit(after(round, out), used, mass * out.prob);
          return;
        }
        const tally = totals.get(k) ?? { reach: 0, survive: 0, picks: new Map() };
        totals.set(k, tally);
        tally.reach += mass;
        const set = choose(round, used);
        if (!set) return;
        for (let at = 0; at < seeds.length; at += 1) {
          if (set.bits & (1 << at))
            tally.picks.set(seeds[at], (tally.picks.get(seeds[at]) ?? 0) + mass);
        }
        for (const out of round.outs) {
          if (!holds(set, out.mask)) continue;
          tally.survive += mass * out.prob;
          if (k < lastK) visit(after(round, out), used | set.bits, mass * out.prob);
        }
      };
      visit(root(), maskOf(spent), weight);
    },
    /**
     * Every team the coach takes somewhere in the bracket, on any way it can
     * go. A team it never takes costs nothing to spend: the same play without
     * it is still there to be made, and is still the best.
     */
    picked(spent) {
      const teams = new Set();
      const seen = new Set();
      const visit = (round, used) => {
        used &= round.alive;
        const key = (round.k * 16384 + round.alive) * 16384 + used;
        if (seen.has(key)) return;
        seen.add(key);
        if (!picking(round)) {
          if (round.k === lastK) return;
          for (const out of round.outs) visit(after(round, out), used);
          return;
        }
        const set = choose(round, used);
        if (!set) return;
        for (let at = 0; at < seeds.length; at += 1) if (set.bits & (1 << at)) teams.add(seeds[at]);
        if (round.k === lastK) return;
        for (const out of round.outs) {
          if (holds(set, out.mask)) visit(after(round, out), used | set.bits);
        }
      };
      visit(root(), maskOf(spent));
      return teams;
    },
    rank(spent) {
      // Played forward to the first round still to pick, along what happened
      // (or, for a game with no result yet, the likelier way).
      if (firstPick > lastK) return null;
      let round = root();
      while (!picking(round)) {
        if (round.k === lastK) return null;
        const likeliest = round.outs.reduce((a, b) => (b.prob > a.prob ? b : a), round.outs[0]);
        if (!likeliest) return null;
        round = after(round, likeliest);
      }
      const used = maskOf(spent) & round.alive;
      return candidates(round, used)
        .map((set) => {
          let chance = 0;
          for (const out of round.outs) if (holds(set, out.mask)) chance += out.prob;
          const teams = seeds.filter((_, at) => set.bits & (1 << at));
          return { teams, value: worth(round, set, used), chance };
        })
        .sort((a, b) => b.value - a.value || b.chance - a.chance);
    },
  };
}

/** Where every team sits: its conference and division, by index. */
function tableOf(names, teams) {
  const divisions = [...new Set(names.map((team) => teams[team]))].sort();
  return {
    names,
    conference: Int8Array.from(names, (team) => CONFERENCES.indexOf(conferenceOf(teams[team]))),
    division: Int8Array.from(names, (team) => divisions.indexOf(teams[team])),
  };
}

function emptyRecords(n) {
  return {
    n,
    wins: new Int16Array(n),
    games: new Int16Array(n),
    divisionWins: new Int16Array(n),
    divisionGames: new Int16Array(n),
    conferenceWins: new Int16Array(n),
    conferenceGames: new Int16Array(n),
    // headToHead[a * n + b]: a's wins over b.
    headToHead: new Int8Array(n * n),
  };
}

function copyRecords(records) {
  return {
    n: records.n,
    wins: records.wins.slice(),
    games: records.games.slice(),
    divisionWins: records.divisionWins.slice(),
    divisionGames: records.divisionGames.slice(),
    conferenceWins: records.conferenceWins.slice(),
    conferenceGames: records.conferenceGames.slice(),
    headToHead: records.headToHead.slice(),
  };
}

function tally(records, table, home, away, homeWon) {
  if (home === undefined || away === undefined) return;
  const winner = homeWon ? home : away;
  const loser = homeWon ? away : home;
  records.wins[winner] += 1;
  records.games[home] += 1;
  records.games[away] += 1;
  records.headToHead[winner * records.n + loser] += 1;
  if (table.division[home] === table.division[away]) {
    records.divisionWins[winner] += 1;
    records.divisionGames[home] += 1;
    records.divisionGames[away] += 1;
  }
  if (table.conference[home] === table.conference[away]) {
    records.conferenceWins[winner] += 1;
    records.conferenceGames[home] += 1;
    records.conferenceGames[away] += 1;
  }
}

/**
 * Better team first: record, then the games between them, then the division
 * record for two in a division, then the conference record, then the coin.
 */
function compareTeams(records, table, coin) {
  const pct = (wins, games, at) => (games[at] > 0 ? wins[at] / games[at] : 0.5);
  return (a, b) => {
    const byRecord = pct(records.wins, records.games, b) - pct(records.wins, records.games, a);
    if (Math.abs(byRecord) > 1e-9) return byRecord;
    const n = records.n;
    const between = records.headToHead[b * n + a] - records.headToHead[a * n + b];
    if (between !== 0) return between;
    if (table.division[a] === table.division[b]) {
      const byDivision =
        pct(records.divisionWins, records.divisionGames, b) -
        pct(records.divisionWins, records.divisionGames, a);
      if (Math.abs(byDivision) > 1e-9) return byDivision;
    }
    const byConference =
      pct(records.conferenceWins, records.conferenceGames, b) -
      pct(records.conferenceWins, records.conferenceGames, a);
    if (Math.abs(byConference) > 1e-9) return byConference;
    return coin[b] - coin[a];
  };
}

/** Both conferences seeded: division winners one to four, the best three left five to seven. */
function seedLeague(names, table, records, compare) {
  const seeds = {};
  CONFERENCES.forEach((conference, c) => {
    const members = [];
    for (let at = 0; at < names.length; at += 1) if (table.conference[at] === c) members.push(at);
    const byDivision = new Map();
    for (const at of members) {
      const list = byDivision.get(table.division[at]) ?? [];
      list.push(at);
      byDivision.set(table.division[at], list);
    }
    const winners = [...byDivision.values()].map((list) => [...list].sort(compare)[0]);
    const winnerSet = new Set(winners);
    const rest = members.filter((at) => !winnerSet.has(at)).sort(compare);
    seeds[conference] = [...winners.sort(compare), ...rest.slice(0, SEEDS - winners.length)].map(
      (at) => names[at],
    );
  });
  return seeds;
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function burnedKey(burned) {
  return [...burned].sort().join("|");
}

function clamp01(p) {
  return Math.min(1, Math.max(0, Number.isFinite(p) ? p : 0.5));
}
