/**
 * Maximum-weight assignment: which team fills which slot to score the most.
 *
 * Strip the coupling between weeks out of the survivor problem and what is
 * left is an assignment. Every remaining week has a slot (two, in college),
 * every team can fill at most one slot in the season, and a team in a slot is
 * worth the log of its win probability that week. Maximising the sum is the
 * path with the highest product - exactly, and in a few milliseconds, by the
 * Hungarian method. Only the rule that two picks in one week cannot be the two
 * sides of one game is left out, and a pair like that is never worth taking:
 * one of them loses.
 *
 * Two uses. It benchmarks the beam search (scripts/validate-recommend.mjs), and
 * it values what a path has left: given the teams already spent, the best
 * assignment of the remaining weeks is the honest measure of the inventory,
 * counting every team once (core/recommend.js). Buy-back weeks are not
 * separable, so recommend.js reshapes their weights before asking.
 *
 * Pure and environment-free.
 */

/** A weight this low means "not allowed"; the solver never takes it. */
export const FORBIDDEN = -1e9;

/**
 * Solve for the assignment of columns to rows that maximises the total weight.
 *
 * Rectangular: there are usually far more teams (columns) than slots (rows).
 * Rows that cannot be filled at any allowed weight are left unfilled, which
 * the caller reads as -1.
 *
 * @param {number[][]} weights weights[row][column], higher is better. Use
 *   FORBIDDEN for a pairing that is not allowed.
 * @returns {{assignment:number[], value:number}} `assignment[row]` is the
 *   column that row took, or -1; `value` is the sum of the weights taken.
 */
export function maximumAssignment(weights) {
  const rows = weights.length;
  if (rows === 0) return { assignment: [], value: 0 };
  const columns = weights[0].length;
  if (columns === 0) return { assignment: new Array(rows).fill(-1), value: 0 };

  // The Hungarian method minimises, so weights become costs, and it wants at
  // least as many columns as rows, so a short matrix is padded with dummy
  // columns that cost nothing to leave a row on.
  const n = rows;
  const m = Math.max(columns, rows);
  const NONE = -FORBIDDEN;
  const cost = (row, column) =>
    column < columns ? (weights[row][column] <= FORBIDDEN ? NONE : -weights[row][column]) : NONE;

  // Potentials and matching, from e-maxx's O(n^2 m) formulation.
  const u = new Float64Array(n + 1);
  const v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1); // p[column] = row matched to it (1-based), 0 if none
  const way = new Int32Array(m + 1);

  for (let i = 1; i <= n; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(m + 1).fill(Infinity);
    const used = new Uint8Array(m + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j += 1) {
        if (used[j]) continue;
        const current = cost(i0 - 1, j - 1) - u[i0] - v[j];
        if (current < minv[j]) {
          minv[j] = current;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j += 1) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const assignment = new Array(rows).fill(-1);
  let value = 0;
  for (let j = 1; j <= m; j += 1) {
    const row = p[j] - 1;
    if (row < 0) continue;
    const column = j - 1;
    if (column < columns && weights[row][column] > FORBIDDEN) {
      assignment[row] = column;
      value += weights[row][column];
    }
  }
  return { assignment, value };
}

/**
 * The survivor problem as an assignment, with the coupling between weeks
 * dropped.
 *
 * @param {object} args
 * @param {Array<{week:number, options:Array<{team:string, winProb:number}>,
 *   fixed?:Array<string|null>}>} args.weeks Remaining weeks, as recommendPath
 *   takes them.
 * @param {Set<string>} args.burned Teams already spent.
 * @param {number} args.picksPerWeek
 * @param {(week:number, team:string, winProb:number) => number} [args.weightOf]
 *   The value of a team in a week. Defaults to the log of its win probability.
 * @returns {{picks:Object<number,string[]>, value:number, complete:boolean}}
 *   `complete` is false when some slot could not be filled.
 */
export function assignPath({ weeks, burned, picksPerWeek = 2, weightOf = null }) {
  const value = weightOf ?? ((week, team, winProb) => Math.log(Math.max(winProb, 1e-9)));

  // Every team that appears anywhere, minus what is spent, is a column. A
  // team fixed into a slot is placed rather than chosen: its slot is dropped
  // from the problem, its weight is added back afterwards, and it is spent
  // everywhere else.
  const spent = new Set(burned);
  for (const week of weeks) {
    for (const team of week.fixed ?? []) if (team) spent.add(team);
  }
  const teams = [];
  const columnOf = new Map();
  for (const week of weeks) {
    for (const option of week.options) {
      if (spent.has(option.team) || columnOf.has(option.team)) continue;
      columnOf.set(option.team, teams.length);
      teams.push(option.team);
    }
  }

  const rowsMeta = [];
  const weights = [];
  const picks = {};
  let fixedValue = 0;
  let complete = true;

  for (const week of weeks) {
    const fixed = (week.fixed ?? []).filter(Boolean);
    picks[week.week] = [...fixed];
    for (const team of fixed) {
      const option = week.options.find((o) => o.team === team);
      fixedValue += value(week.week, team, option?.winProb ?? 0.5);
    }
    // Nothing on the board this week that a fixed pick is playing.
    const fixedOpponents = new Set(
      fixed.flatMap((team) => {
        const option = week.options.find((o) => o.team === team);
        return option ? [option.opponent] : [];
      }),
    );
    const open = picksPerWeek - fixed.length;
    for (let slot = 0; slot < open; slot += 1) {
      const row = new Array(teams.length).fill(FORBIDDEN);
      for (const option of week.options) {
        const column = columnOf.get(option.team);
        if (column === undefined) continue;
        if (fixed.includes(option.team) || fixedOpponents.has(option.team)) continue;
        row[column] = value(week.week, option.team, option.winProb);
      }
      weights.push(row);
      rowsMeta.push(week.week);
    }
  }

  const solved = maximumAssignment(weights);
  for (const [index, column] of solved.assignment.entries()) {
    if (column < 0) {
      complete = false;
      continue;
    }
    picks[rowsMeta[index]].push(teams[column]);
  }

  return { picks, value: solved.value + fixedValue, complete };
}
