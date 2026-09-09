# Architecture

## The shape of it

A static site with no build step, one scheduled job, and one tiny database.

```
                      ┌──────────────────────────┐
   once a day ───────▶│ .github/workflows/       │
                      │   refresh-odds.yml       │
                      └────────────┬─────────────┘
                                   │ node scripts/refresh-odds.mjs
                                   ▼
                          the-odds-api.com
                                   │
                                   ▼
                     data/<league>/odds.json ──commit─┐
                                                    │
                      ┌─────────────────────────────▼──┐
                      │ .github/workflows/pages.yml    │
                      │   redeploys the repo as-is     │
                      └─────────────────┬──────────────┘
                                        ▼
   two phones ──────────────────▶  GitHub Pages
        │                              index.html
        │                                  │
        │                                  ▼
        │                    data/<league>/{plan,teams,schedule,ratings,
        │                      odds,form,calibration,availability,pool}.json
        │                                  │
        └──── picks / locks ───────────────┴──▶ Supabase (realtime)
                one row per league
```

## Three pools, one board

`data/cfb/` and `data/nfl/` hold the same files. Which pool is loaded is a
single piece of state in `app.js`; everything else falls out of the plan the
pool ships:

| Rule                    | Read from                 | Editable from the board |
| ----------------------- | ------------------------- | ----------------------- |
| picks per week          | `plan.rules.picksPerWeek` | yes                     |
| weeks in the season     | `plan.weeks`              | no - the schedule says  |
| eligible teams          | `teams.conferences`       | no                      |
| what counts as a "Lock" | `plan.tiers`              | no - model, not rule    |
| buy backs, and where    | `plan.rules.buyBack*`     | yes                     |
| win or lose             | the pool's kind           | no - fixed at creation  |

### Rules, and changing them

What the plan ships is the default. The settings sheet behind the masthead gear
(`ui/settings.js`) writes overrides into the shared entry under `rules`, and
`core/rules.js` merges the two into the set the board runs on. Three properties
hold it together:

- **Shared, not per-device.** Rules belong to the pool, so they live in the
  same document the picks do and arrive on the other phone through the same
  realtime push. A pool with nothing saved has no `rules` key at all, which is
  what "follows the plan" looks like on disk - and what saving rules that
  match the plan's restores by deleting it.
- **Clamped, never trusted.** An override comes from a document another device
  wrote, an older version of the app may have written, or a person may have
  edited by hand in the Supabase table. `mergeRules` refuses anything unusable
  and falls back to the plan's own value - field by field, never to a constant -
  so no value in that document can produce a board that does not work. Buy
  backs cannot outnumber the weeks they cover, which is the one pair of fields
  that can contradict each other.
- **Part of the search's identity.** The recommendation is memoised on a
  signature (`signatureBase`), and the rules are in it. They have to be: a pool
  picking losers is a different search from one picking winners, and before the
  rules could change at runtime the signature did not need to say so.
- **All but the objective.** Whether a pool's picks win or lose is the kind of
  pool it is (`POOL_KINDS` in `sports.js`), chosen when the league is made and
  stored on its row. `app.js` writes it into the plan's rules before the board
  is built, so it reaches the model as the default the merge falls back to, the
  settings sheet does not offer it, and a save drops it from what it stores.

A rule the board no longer holds does not destroy what was saved under it. The
entry is keyed by week and slot, so dropping a pick a week hides the extra
slots - their picks stop spending teams and stop counting - and raising it
again brings them back exactly as they were. What the sheet does not offer is
anything the model cannot honour: reusing a team is not a toggle, because the
optimiser's whole search, the Hungarian assignment included, is built on a team
being spent once.

One thing the daily job cannot see: it reads `plan.json`, not the shared entry,
so its line-movement flag is computed from the file's objective rather than a
pool's override.

A league owns none of that. It is one or more rows in the `leagues` table, one
per pool it runs, keyed by the league's code, the season and what the picks
have to do - each row a name, a kind of pool, and that pool's whole shared
board as JSON - and the season is what points a row at a folder. A league made
for NFL winners, NFL losers and college at once is three rows under one code,
three boards, and one link to send; which pools it runs is fixed when it is
made. However many leagues exist, they read the same two daily pulls, so a pool
costs a row and nothing else. `src/js/sports.js` is what is left of the old
pool registry: the two seasons, the four kinds of pool they make, and what a
new pool of each kind starts with.

The objective is applied in exactly one place, `core/objective.js`, and it is
applied where the raw numbers enter the model rather than where they are read.
`weekOptions` prices a team's chance of winning its game and then hands
downstream `winProb` meaning "the chance this pick carries the week" - one
minus it in a losers pool - and `advanceResult` does the same to a recorded
final, so the team that lost is the pick that won. The spread is never flipped:
it is the market's statement about the game, and `+9.5` is what makes that
team the good pick there. Every module below - the tiers, the beam search, the
survival maths, the drive, the bench, the pool overlay - therefore works
unchanged and never asks which pool it is in. The one exception is
`core/scenarios.js`, which draws its own spreads and so has to be told which
side of them to price.

Colour is the one thing that does not come off the board: `app.js` stamps
`data-league` on the root element and `src/css/leagues.css` redefines the
tokens beneath it, so the whole app repaints from one attribute write. The
confidence scale is deliberately left alone, because a status colour that moves
with the league is a status colour you cannot trust.

No module under `src/js/ui/` knows which league is open, and `core/` takes the
rules as arguments rather than reading a global. Adding a pool is a folder and
an entry in `src/js/leagues.js` - or, when it plays a schedule already here,
an entry and a `plan.json` alone.

Switching is a full reload of the board, not a filter over one: the old store
subscription is torn down, the new board's data and entry are loaded, and a
late push from the store being replaced is dropped rather than landing on the
new board. Each pool keeps its own entry (its own artifact document, its own
Supabase row, its own storage key, all keyed by `scopeFor(code, kind)`), so
locks in one pool can never appear in another - not in another league's, and
not in the same league's other pools. The topline at the top of the board
(`ui/league-bar.js`) names the open league and holds a picker of its pools -
"NFL winners", "NFL losers" - and nothing else; another league is a trip back
through the home page. The hash records league and pool (`#/l/CODE/KIND`) so a
reload comes back to the same board. On the home page the whole bar, gear
included, is hidden: there is no board for it to be about. The gear's sheet can
also remove a pool from the league or delete the league outright, each behind
a second tap, since either is for everyone in it.

## Why the data is split so many ways

| File                | Owner               | Changes when                                   |
| ------------------- | ------------------- | ---------------------------------------------- |
| `plan.json`         | a human             | the season strategy is revised                 |
| `teams.json`        | a human             | once a season, when ratings are published      |
| `schedule.json`     | a human             | once a season                                  |
| `ratings.json`      | a human             | once a season                                  |
| `availability.json` | a human             | when a report is worth writing down (optional) |
| `pool.json`         | a human             | when the pool's numbers change (optional)      |
| `odds.json`         | the refresh bot     | once a day                                     |
| `form.json`         | the refresh bot     | once a day                                     |
| `stats.json`        | the refresh bot     | once a day, where the league has a source      |
| `snapshots/`        | the refresh bot     | one new file a day, never rewritten            |
| `history.json`      | `npm run history`   | once a season, after the last one closes       |
| `calibration.json`  | `npm run calibrate` | once a season, after the history is imported   |

Keeping them separate is what lets a bot rewrite the numbers every day
without ever touching the strategy or the markup. A merge conflict between the
bot and a human edit is impossible because they never write the same file.
That is why the fitted ratings are their own file rather than an edit to
`ratings.json`: the published preseason numbers stay a human's to set, and the
season's own read on a team is the bot's. The two script-owned files are the
same idea a level up: the model's parameters are fitted, not typed, and the
fit is reproducible from a file that is committed beside them.

## Suggestion vs pick

Two different things, deliberately kept apart:

- **Your pick** is the team you put in a slot, and **locking** it is what
  commits it. Picks and locks are the only things stored in the shared entry;
  results come from the daily refresh. A slot nobody has picked is empty.
- **The coach's suggestion** is what `core/recommend.js` computes from the
  current odds. It is never written to state and never becomes a pick on its
  own. It shows as a badge on the team in the list, as a ghosted stand-in where
  a slot is empty, and as pencilled rows on the drive, and you decide.

Locking is the boundary. The coach plans as if every unlocked slot were open,
so picking a team and changing your mind cost nothing; the moment a pick is
locked or unlocked, the rest of the season is re-planned around what is now
committed. While a pick is only being weighed, what you see is a preview of
that: the ghosts in the open slots and the "if locked" number come from the
season re-solved around the pick by the exact assignment alone, which takes a
millisecond and almost always lands where the full search would. So the
preview never spends the picked team again in a later week, and the number it
quotes is the one the lock then produces. `plan.json` still carries an
authored path, but only as the optimiser's seed and the season calendar. It
never fills a slot.

The coach only ever names a game still to be played, and what is left of a week
is all it has to work with. That can be less than the pool asks for: with one
fixture left and two slots open, the week takes the better side of it and
nothing else, since the two sides of one game cannot both come through it, and
a team playing a locked pick is no candidate for the slot beside it either. A
week the search reports short is short by nature rather than unfinished, so it
and the weeks after it keep their numbers.

The optimiser is a beam search over the remaining weeks (`BEAM_WIDTH` 160,
`CANDIDATE_WIDTH` 12). Exact search over the set of teams already spent is
impossible, the space is 2^50, and a plain greedy pass fails badly, because
taking the biggest favourite every week strands you in the middle of the
season, where nothing is soft.

Four details make it work:

1. **Lookahead in the beam ranking.** Beams are ordered on score _plus_ an
   optimistic estimate of what each still has available in later weeks.
   Without it the search is myopic and lands slightly worse than a careful
   hand-built plan; with it, it beat the authored plan 14.6% to 10.5%. The
   estimate walks the later weeks in order and reserves each team it counts,
   so a strong team kept in hand is worth one week, not every week it plays.
2. **The authored plan is seeded as a competing beam**, so the recommendation
   can never come back worse than the plan already in `plan.json`.
3. **The exact assignment competes too.** Drop the one rule that couples weeks
   to each other beyond "no team twice" - the two sides of a game cannot both
   be picked in one week - and the problem is an assignment of teams to slots,
   solved exactly in a millisecond by the Hungarian method
   (`core/assignment.js`). Its answer almost never breaks the dropped rule,
   and when it does not it joins the finalists. On the boards it has been
   measured on it matches the beam or beats it by a couple of percent of
   survival; `scripts/validate-recommend.mjs` holds the beam to it.
4. **Buy backs are scored twice.** A beam prunes long before it knows how a
   path ends, and "a loss here is forgiven" is a property of the whole path,
   not of one week: no per-week score can express it. So the search is run at
   several levels of forgiveness (none, what one buy back spread over its weeks
   is worth, and free), and every finalist from every pass is then re-scored on
   the exact survival maths in `core/survival.js`. The pass that discounts most
   is the one that finds paths spending a weak team in week 1 to keep a strong
   one for week 12; the exact re-score is what decides whether that was
   actually better. Without buy backs there is one pass and nothing changes.

That gives the best path on the numbers as they stand. What the coach
actually calls this week is decided a layer up, across futures; see
[Futures](#futures).

Anything locked is a hard constraint, the optimiser works around a decision you
have committed to rather than pretending you can take it back. The seed takes
the locked team in any locked slot for the same reason.

The recommendation is memoised on `(league, currentWeek, buy backs left,
odds.updatedAt, form.updatedAt, calibration.fittedAt, availability.updatedAt,
pool.updatedAt, locked picks)`. It deliberately does NOT depend on unlocked
picks, so trying teams out re-renders instantly instead of re-running the
search on every tap. A memoised rebuild is a few milliseconds.

The search itself is a few hundred milliseconds and cannot be interrupted, so
a board it has never seen before is built in two passes.
`buildBoard({allowSearch: false})` returns immediately with
`recommendationPending` set; the board paints, empty slots and open rows say
"Working out the path", and the search runs on a timer once the animation in
flight is over. Running it any earlier does not just delay the paint, it
stalls whatever animation is mid-flight and makes it jump. A first load, a
league switch, and a lock or unlock all go this way.

Two optimisations keep that search near 400 ms rather than near two seconds,
both in the expansion loop, where a two-pick week turns each of 160 beams into
about 66 candidates:

- **Candidates are proposals, not beams.** Copying the spent-team set for all
  ten thousand was the most expensive thing the search did, and nearly every
  copy was discarded unread. A proposal holds its parent, the teams taken and
  the running score; the set is copied only once a candidate survives.
- **The lookahead is paid for by a shortlist.** It walks every remaining week
  for every candidate it is given. Score alone orders them well enough to cut
  the field to `SHORTLIST` first, an order of magnitude wider than the beam
  that comes out the other side.

## The probability model

Every number on the board that reads as a chance comes through one model in
`core/probability.js`, and every parameter of that model is fitted to the
league's own past rather than typed in. The fit lives in
`data/<league>/calibration.json`, written by `npm run calibrate` from
`history.json` (see [Calibration and the backtest](#calibration-and-the-backtest));
without the file the board runs on the college numbers as defaults.

**A spread becomes a probability through a normal margin.** A team favoured by
`s` wins when its margin lands above zero, and margins scatter around the line
with a standard deviation the history fixes: about 11 points in the NFL, about
14 in college, growing a little with the size of a college spread. The board
used to carry a hand-drawn curve shared by both leagues; against sixteen NFL
seasons and twelve college seasons the fitted normal beats it on log loss in
both, and the bands table in each `calibration.json` says how often favourites
of each strength actually came through (in college, a 95-97% favourite came
through 95.6% of the time over 316 games). Totals enter as a small widening of
the scatter where the league's history shows one.

**The moneyline is handled book by book.** Each book's two prices share one
margin, so each pair is de-vigged on its own and the fair probabilities are
averaged in log-odds space. The old ingest took a median of each side across
books, which mixed one book's favourite with another's underdog and priced a
-50 favourite below a -31 one. A book at its house maximum on either side is
capped and left out; a book quoting hours behind the others is stale and left
out of everything. What survives is blended with the spread in log-odds at a
weight the history chose (0.2 in the NFL, 0.35 in college), because the spread
is the book's sharpest number and a moneyline on a big favourite is rounded
and biased.

**A projection carries its horizon.** Only this week is priced by the market;
every later week is priced off fitted ratings, and a rating fit today will not
be the closing line in six weeks. The calibration measures how far it misses,
walk-forward over the history, as a variance that grows with the weeks ahead:
`base^2 + perWeek^2 * h`, about `2.2^2 + 1.4^2 h` in the NFL and
`2.4^2 + 2.5^2 h` in college. That variance is added to the margin's when a
projected spread is priced, which is exactly what averaging the probability
over the error does. A -20 projected for December is not the near-certainty a
-20 posted this morning is, and the number says so. Most of that error belongs
to the team rather than the game (`teamShare`, 0.5 in the NFL and 0.84 in
college): a team the fit has overrated is overrated in every week it plays,
which matters for the futures below.

**Availability moves the spread first.** `data/<league>/availability.json` is a
human's list of players, one entry each: team, position, status or a
probability of missing the game, and where the report came from and when. Each
is worth probability-out times points-above-replacement, with modest defaults
by position and a steep one for the quarterback (`core/availability.js`), and a
team's entries sum under a cap. The market has already read yesterday's injury
report, so an entry moves a market line only when it is newer than the line,
and moves a projection always. No entry is no adjustment, reported as "no
report" rather than as health: the conferences publish availability on their
own schedules and most non-conference games have none.

## Futures

The best path is priced to the decimal on numbers that will be wrong by an
amount the calibration knows. Committing this week's pick to it values a
December line as if it were certain, and undervalues keeping options open.
Published work on survivor pools finds the same thing: planning part of the
way ahead and re-planning beats committing to a full-season forecast.

So this week's call is judged across futures (`core/scenarios.js`,
`judgeFrontier` in `core/recommend.js`). The candidates are the openings the
finalists actually use, plus the week's outright favourites. Each is played
through the same set of thirty-two seeded futures. In a future, next week's
lines are realised - drawn from the horizon variance, with one draw per team
shared by all its games and one per game - and the rest of the season is
re-planned around the candidate by exact assignment on those numbers, then
scored on the exact survival maths. Only next week is realised, on purpose: a
pick is made knowing this week's lines and projections for the rest, so a
future in which every later line is known and planned around would credit
foresight nobody has (it roughly quadrupled the season numbers when tried).

What comes back per candidate is its survival in every future, and from that
its mean, its downside (the 20th percentile), and how often it was within a
whisker of the best. The call is the candidate with the best mean among
those at least `floor` likely to hold this week (0.7 unless the pool's file
says otherwise): the season is the goal, but not at the price of a week that
is nearly a coin flip. In a week a buy back in hand covers, the loss is paid
for and the team spent is what is at stake, so among the openings within 5%
of the best mean the coach spends the weakest team - no worse than a
two-to-one favourite - and keeps the stronger ones for the weeks that can end
the season. The pool's file can also ask for the field's leverage to make the
call instead (see [Pool equity](#pool-equity)). The path shown is the best
complete path through that opening. Because every candidate meets the same
futures, the
comparison between them is far steadier than the futures themselves, and
because the draws are seeded, the refresh job and the browser agree.

The board itself shows only the outcome: the call as a badge on the team and
as the ghost in an empty slot. The comparison behind it - two to four
openings, each with its chance this week, the season it leads to on the
numbers as they stand, its mean across the futures, how often it holds up,
and what it costs against the call - is printed by the refresh job in its run
summary and written to `odds.json` under `recommendation.frontier`, where the
backtest reads it back. On the first week of the 2026 college season it read:
South Carolina with Mississippi State or Alabama at no cost, Texas A&M for
1.8% of the season, and Iowa - the week's single biggest favourite - for 12%,
because Iowa is worth far more in November. That is the shape of the choice,
which one number cannot give.

## Pool equity

Surviving alongside everyone else gains nothing. If most of the pool is on
the same favourite, a week it holds thins nobody out and a week it falls takes
you with them; a lightly held team of nearly the same strength wins ground in
the week it holds. That leverage needs a number the odds never carry - what
share of the field sits on each team this week. `data/<league>/pool.json`,
kept by hand, supplies it when someone has the pool's actual picks. Without
it the field is implied from the lines: survivor fields crowd the biggest
favourites in a steep and well-documented shape (the top favourite of an NFL
week draws about a third of the picks, the next two most of the rest), and a
softmax over this week's probabilities (`IMPLIED_TEMPERATURE` in
`core/equity.js`) reproduces it closely enough to price leverage off. It is a
shape, not a census - it knows nothing of which teams the field has spent -
and the file wins whenever it speaks.

`core/equity.js` lays over each candidate the share of the field expected to
survive the week if your own pick holds (an entry on your team survives with
you, one on your opponent is gone, anyone else at their own probability, a
two-pick field at the rate squared), the inverse of that as leverage, and
survival across futures times leverage as equity. Where the pool grants buy
backs the field has them too: in a forgiving week a losing entry is not gone
but worth `cover`, the value of playing on without the cushion (one buy back
over two weeks comes out near three quarters), so the leverage on offer there
shrinks to match.

The mode makes the call. `safest`, the default, is survival alone: the best
mean across the futures among the openings whose chance this week is at
least `floor` (0.7 unless the file says otherwise), with leverage priced and
reported beside it but not consulted. `balanced` ranks the same openings by
equity instead; `equity` drops the floor too. Whatever the mode, a week a buy
back in hand covers plays the covered rule described under
[Futures](#futures): among the openings within `coveredMargin` (5%) of the
best on the mode's measure, the weakest team goes, and the floor drops to
`coveredFloor` (two in three) to let it. Both knobs are the file's, so a pool
that wants its buy back spent more or less freely says so there. The path
shown is the best complete path through the opening called. Leverage is the
standard one-week approximation of a season-long game whose proper treatment
needs every rival's spent teams.

## How the ratings learn

Only the current week is ever priced by the market: books do not post week 9 in
September. Every week after it is projected from ratings, so those ratings are
what the optimiser plans nearly the whole season on - and shipping them once,
before the season, meant planning weeks 2 to 13 on numbers that knew nothing
about the season being played. Perturbing them by the error they actually carry
(2.6 points against the market in week 1) moved a fifth to a third of the
college season's picks, so this was not a rounding difference.

`scripts/lib/rate.mjs` refits them at the end of every run, from three things
the pull collects:

- **The market lines in `odds.json`**, which accumulate: the keys are
  `"<week>|<team>"` and old weeks are never dropped, so by mid-season there is a
  line for every eligible team in every week played. This is the strong signal,
  because a line already has every result so far priced into it by people whose
  job is to price it.
- **The final margins in `scores`**, worth a third to a half of a line each. A
  single game's margin is noisy, and within days the market has read the same
  game and posted a line that supersedes it. Margins earn their place by being
  early: they land on Saturday night, next week's lines are not posted until
  midweek, and those days are exactly when the plan for the rest of the season
  wants re-checking.
- **The efficiency margins in `stats.json`**, where the league has a source:
  the same game read through expected points added per play rather than the
  scoreboard, which drops the fumble that bounced the wrong way and the punt
  returned for a score. nflverse publishes them for the NFL with no key;
  CollegeFootballData does for college with a free one. The layer is separately
  weighted, separately measurable (the backtest fits with and without it), and
  absent without changing anything else - which is the shape every advanced
  statistic added later should take, rather than a heavier model bolted on
  before the probabilities under it were verified.

A line and a margin say the same kind of thing - how many points better one team
is than another, at a given site - so all three become one equation,
`rating[team] - rating[opponent] + homeField = expected margin`, and the set is
solved for the ratings that best explain them. That is what turns "the market
had Iowa by 10 at home" into a number that can price Iowa at Nebraska in week 9.
Strength of schedule falls out of it, because both sides of every game are
solved at once.

The weights are parameters, tuned walk-forward on the history by
`npm run calibrate` (fit on the weeks before, price the week after, keep what
prices best) and written to `calibration.json`. Three things keep the fit
honest whatever the weights:

1. **Recent observations count for more** (a fifth to a third less per week of
   age), because a team is not the same in November as in September.
2. **Margins are capped** at four to five touchdowns. Running up 70 does not
   make a team 70 points better, it makes the last quarter meaningless.
3. **A team the pull has never seen is absent from `form.json`** and keeps its
   `ratings.json` value. The fit is an overlay, never a replacement, and
   `ratings.json` remains the FBS membership test - a fitted rating is a better
   number for a team we already price, never a reason to price one we do not.

There is a pull toward each team's starting rating. It is not a preseason
blend: pairwise observations fix the gaps between teams but not the level they
all sit at, so something has to pin that, and a team with one observation
should not be defined by it. Two things about it are measured rather than set.
How strong it is follows from how good the prior is: the history's prior is
last season regressed toward the mean, and the study measures how far that
missed the opening week's lines; the live board's prior is a published rating,
and `npm run calibrate` measures how far that missed this season's opening
lines. A prior is worth the inverse of its error variance, so the tuned anchor
is scaled by the ratio of the two. The NFL's market power ratings missed week 1
by half a point, so the pull is heavy; college SP+ missed by nearly three, so
it is moderate. And the pull fades: a preseason rating is as good as it will
ever be in week 1 and drifts from the truth after that, so the anchor at age
`t` weeks is `anchor / (1 + t / halfLife)`, with the half-life the prior's
error variance divided by the drift the horizon study measured. The market
prior's half-life is a fraction of a week; SP+'s is about two.

One more piece of uncertainty is measured in the same walk. A team the fit has
never seen a line for - in college, every team that opened against an FCS
side - is still priced off its preseason rating alone, and a projection with
such a side misses by more. The study measures that extra variance
(`horizon.unseen`), scales it to the live prior the same way the anchor is,
and the board adds it per unseen side, so a game between two teams the market
has not spoken about yet is priced with the doubt it deserves rather than as
the rating gap says.

The run reports whether the fit is worth having, and the test is out of sample:
fit on the weeks before the latest one pulled, then see which prices that week
better, the fit or the shipped ratings. Explaining lines you were fitted to is
easy and means nothing. A fit that loses that comparison is still used - it is
still the best guess for the weeks ahead - but the run says so and the flag
opens an issue, so a model quietly going wrong is not taken on trust.

## Calibration and the backtest

Two scripts answer the same questions of different data.

`npm run calibrate` asks them of the history. `npm run history` imports it
first: every NFL regular-season game since 2010 from nflverse (closing spread,
total, both moneylines, result) and every FBS-versus-FBS college game since
2014 from cfbfastR-data's per-book lines joined to its schedules, boiled down
to one compact record per game in `history.json`. The calibration then fits
the margin model (by the margins first, then nudged to make the wins and
losses themselves most likely, because the tails decide and a normal is a
little thin there), weighs the moneyline on a grid, walks every season forward
to measure projection error by horizon and to tune the rating weights, and
prints the bands table and the horizon table before it writes anything. Run
it once a season, after importing the one just finished.

`npm run backtest` asks them of the season under way, which it can only do
because every refresh run leaves a snapshot behind (`data/<league>/snapshots/`,
one file per run, never rewritten, holding the day's lines and the fitted
ratings of the day). It scores every line the board showed against the result

- closing and opening, against the spread alone, the moneyline alone and the
  old curve - lays the projections the board planned on against the lines those
  weeks eventually closed at by weeks ahead, next to the error the calibration
  promised, holds each week out of the rating fit with and without each layer,
  and lists the coach's calls and how they went. Early in a season the tables
  are short and say so; by November they are the evidence for whether any of
  this earned its place. `scripts/validate-calibration.mjs` runs both on
  leagues whose answers are known, so a change to either has to recover a sigma
  it was given.

## Why the bot does not re-plan

The point of refitting daily is the question the run ends on: on today's
numbers, should the plan for the rest of the season change? The job builds the
board on yesterday's numbers and today's and diffs the two paths, week by week,
to the end of the season. New lines can move it and so can a refit - a team the
season has revalued changes what is worth spending in week 3 as surely as a line
moving does - and either way the run names every week whose pick changed and
opens an issue.

It still never edits `plan.json`. Advice is advice; the pick is yours.

## Results, and why survival is live

`Season survival` is the product of the win probability of every pick that has
not yet resolved. A resolved win drops out of the product (it happened); a
resolved loss makes it zero, unless a buy back covers that week. So it moves on
its own in three situations:

1. **You pick or change a team.** The board rebuilds, the new team's
   probability replaces the old one, or the coach's suggestion where a slot is
   left empty.
2. **A game finishes.** The refresh job reads the Odds API scores endpoint and
   writes `results` into `data/odds.json`, keyed `"<week>|<team>"`. The board
   applies those to locked picks automatically, so the number keeps up with
   the weekend without anyone tapping anything. There are no buttons for it.

With a buy back in play the number is not a plain product any more. Surviving
means at most one of the forgiving weeks going down, which is a Poisson
binomial tail, so `core/survival.js` builds it with a small DP over those weeks
rather than a closed form. That keeps it right whether the pool grants one buy
back or three, and it is the same function the optimiser scores its finalists
on, so the number on the drive line and the number the recommendation is chosen by
can never disagree.

A buy back is spent, not refunded: losing week 1 costs the team as well as the
cushion, and the board burns it either way.

A resolved pick shows a `Won` or `Lost` chip and its lock can no longer be
undone. An unlocked pick is not resolved, it is dropped: nothing was committed,
its kickoff has been and gone, and the slot goes back to the coach's suggestion
rather than holding a team the board will not let anyone lock. Only a lock
survives its own kickoff. A game the feed does not settle (a tie, or one it never returns) stays
unresolved; if the pool counts it, add the `"<week>|<team>"` key to `results`
in `data/<league>/odds.json` by hand and the next run keeps it. Results saved
into the shared entry by the old buttons are still honoured and still win.

Scores are read from the first kickoff until a week after the last, so the
final week's Monday night game is recorded even though the lines side of the
job has already called the season over. They are best effort: if that call
fails the run logs it and carries on, and the next day's run sees the same
games again.

### Review mode

A loss no buy back can cover ends the run, and `survival()` says which week
did it. From then on the board is in review. The coach stands down (the
optimiser returns an empty plan without searching), every pick and lock control
is disabled whatever the store allows, a banner above the views says when and
how it ended with the final record, the drive line names the week it ended,
weeks after it read as not played, and the board opens looking at the week it
ended. Nothing is deleted: the locks and results stay exactly as they
were, so the season can be read back. Only the result itself changing, by a
correction in `odds.json`, can bring the board out of review.

## What the refresh job does with it

One run refreshes every pool with games of its own - `DATA_LEAGUE_IDS`, which
is every pool that is not reading another's folder - in sequence, against
separate sport keys and
separate data folders. A failure in one is logged and the other still runs; the
job only exits non-zero when every league failed. Set `LEAGUE=nfl` to refresh
just one, which is how you avoid spending API quota on a college season that is
already over.

Each run prices the week book by book through the league's model, records the
results and margins of the games just played, pulls the efficiency numbers
where the league has a source (best effort, never fatal), refits the ratings
with the weights the calibration chose, writes the day's snapshot, and
recomputes the recommendation on the old and the new odds and diffs them. New
numbers in an early week can change the right answer in week 11, so the whole
remaining path is recomputed, not just the current week. If the advice moved,
the job says so in the run log and opens a GitHub issue; so does a pick whose
line has fallen under the danger threshold, and a line that has moved a field
goal (NFL) or four points (college) since the week was first priced, because
the market has learned something the ratings have not. The log also names any
bigger favourite still priced below a smaller one and how many capped or stale
book quotes were left out, so the ingest's own failures are visible.

It still never edits `plan.json`. Advice is advice; the pick is yours.
`scripts/validate-plan.mjs` enforces the pool rules in CI so a bad hand-edit
cannot ship.

## State ownership

Three sources, merged in `core/plan.js` and nowhere else:

- **plan**, what we intend to do
- **odds**, what the market currently says
- **entry**, what the two of us have actually done (picks and locks)

`buildBoard()` folds them into one derived object. Every module under
`src/js/ui/` renders from that object and never reads the raw JSON. That is
the rule that keeps the UI honest: if a number is wrong, there is one place to
look.

## The screen: a field held sideways

The board is one split screen, built for a phone in one hand. The top half is
the readout and does not scroll. First the pitch (`ui/pitch.js`), which draws
the season as a football field laid sideways: kickoff on the left, the end
zone on the right, a yard line per week naming its pick, the ball on the week
on the clock, a chalk bracket on the week being looked at, and a mark on each
week for what it holds. Under the field runs the drive line, saying where the
ball is, what the pool forgives, what a pick being weighed would do, and how
far the season is from the end zone. Then the call (`ui/call.js`): the week
being looked at with the one action as a mark at the end of its first row, then
its slot or slots. The bottom
half is the drawer, which takes what is left and scrolls inside itself: the
sideline (`ui/sideline.js`, every team the active slot could hold), the drive
(`ui/drive.js`, the season week by week) and the bench (`ui/bench.js`, every
team and where it sits on the path), behind three tabs on a phone and side by
side from 900px.

On a phone the field is wider than the screen and scrolls sideways under end
zones pinned to either edge, so every week has room to name its pick; a
desktop shows all of them at once. Looking at a week, by a tap on the field, a
row of the drive or a swipe across the board, redraws only the call, the
sideline and the drive's bracket, moves the field's bracket in place and
scrolls that week into view, and never rebuilds the board.

The swipe is `ui/swipe.js`, bound once to the board and told apart from a
scroll by shape rather than by speed: far enough sideways, and enough more
sideways than up. It listens on touch events rather than pointer events
because the board scrolls vertically, and Chrome cancels a pointer stream the
moment that scroller claims the gesture - even for a dead-horizontal drag. It
does not fire where a sideways drag already means something: over the field,
which pans its own yard lines, over a sheet or menu on top of the board, in a
field being typed in, or on the bench, which is not about a week at all. The
ends of the season hold rather than wrap.

Colour is the one thing that does not come off the board: `app.js` stamps
`data-league` and `data-objective` on the root element and `src/css/leagues.css`
repaints the end zones and the league's mark from them. Everything else is the
same turf and the same chalk whichever pool is open, because a field is green
whoever is on it.

## Store fallback

`store/index.js` prefers Supabase and falls back to `localStorage` when it is
not configured or cannot connect. The app works either way; it just says which
mode it is in. That means the site is useful the moment Pages is on, before
any backend exists.

The Supabase store gates what reaches the board by version, because rows do
not arrive in order: a poll can be answered with the row as it stood before a
tap, and realtime can deliver the echo of one save after the next one has gone.
It drops its own echoes (it remembers the versions it saved), applies nothing
while one of its saves is on the wire, and discards a poll whose answer lands
after the version has moved on. `scripts/validate-store-sync.mjs` replays those
orderings against a fake client.

## Deliberate omissions

- **No framework.** The app is one screen with four regions. React would
  triple the payload and add a build step to a repo whose main advantage is
  not having one.
- **No bundler.** Native ES modules. `index.html` is servable from disk.
- **No precache list in the service worker.** `sw.js` keeps only what the app
  has already fetched, so there is no manifest of files to keep in step with
  the repo. The shell (page, styles, modules, icons, fonts, the Supabase client)
  opens from the cache and refreshes behind the scenes, which is what makes a
  home-screen launch instant; a deploy is picked up on the launch after the one
  that fetched it. The data files go network-first with a time limit, so an
  odds commit still lands the moment it is published and a weak signal falls
  back to the last copy rather than hanging. Offline shows the last board this
  device loaded rather than a guaranteed-complete app.
- **No auth.** A league's code is the credential: twelve characters from a
  31-letter alphabet, generated with `crypto.getRandomValues`, and holding one
  is what lets a device read and write that league. Nothing is verified and
  nobody signs in - a name is a label this device typed, not an identity. The
  publishable key ships in the page, so the policies cannot check a code and
  the obstacle is that codes are unguessable, which keeps out passers-by rather
  than anyone determined. Supabase Auth plus a memberships table is the version
  that holds; the trade is written up at the top of `supabase/schema.sql`.
