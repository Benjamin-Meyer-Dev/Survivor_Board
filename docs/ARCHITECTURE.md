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

## Two leagues, one board

`data/cfb/` and `data/nfl/` hold the same files. Which one is loaded is a
single piece of state in `app.js`; everything else falls out of the plan the
league ships:

| Rule                    | Read from                 |
| ----------------------- | ------------------------- |
| picks per week          | `plan.rules.picksPerWeek` |
| weeks in the season     | `plan.weeks`              |
| eligible teams          | `teams.conferences`       |
| what counts as a "Lock" | `plan.tiers`              |
| buy backs, and where    | `plan.rules.buyBack*`     |

Colour is the one thing that does not come off the board: `app.js` stamps
`data-league` on the root element and `src/css/leagues.css` redefines the
tokens beneath it, so the whole app repaints from one attribute write. The
confidence scale is deliberately left alone, because a status colour that moves
with the league is a status colour you cannot trust.

No module under `src/js/ui/` knows which league is open, and `core/` takes the
rules as arguments rather than reading a global. Adding a third pool is a
folder and an entry in `src/js/leagues.js`.

Switching is a full reload of the board, not a filter over one: the old store
subscription is torn down, the new league's data and entry are loaded, and a
late push from the store being replaced is dropped rather than landing on the
new board. Each league keeps its own entry (its own artifact document, its own
Supabase row, its own storage key), so locks in one pool can never appear in
the other. The college pool predates the NFL one and keeps the unsuffixed
names, which is why `scopeFor()` special-cases it.

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
  a slot is empty, and as faint rows on the Gameplan tab, and you decide.

Locking is the boundary. The coach plans as if every unlocked slot were open,
so picking a team and changing your mind cost nothing; the moment a pick is
locked or unlocked, the rest of the season is re-planned around what is now
committed. `plan.json` still carries an authored path, but only as the
optimiser's seed and the season calendar. It never fills a slot.

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
whisker of the best. The call is the candidate with the best mean; the beam's
best path stands in only when the futures cannot separate two, and the safer
week when nothing else can. The path shown is then the best complete path
through that opening. Because every candidate meets the same futures, the
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
the week it holds. That leverage needs numbers the odds never carry - how many
entries are alive and what share of them sits on each team this week - and
they come from `data/<league>/pool.json`, kept by hand. Without it the board
stays in survival mode rather than invent them.

With it, `core/equity.js` lays over each candidate the share of the field
expected to survive the week if your own pick holds (an entry on your team
survives with you, one on your opponent is gone, anyone else at their own
probability, a two-pick field at the rate squared), the inverse of that as
leverage, and survival across futures times leverage as equity. The file
chooses the mode: `safest` (the default), `equity`, or `balanced`, which is
equity subject to a floor on this week's chance. The coach's own call never
moves; the pool's preference is reported beside it in the refresh summary,
and the call stays what survival alone would say. It is the standard one-week
approximation of a season-long game whose proper treatment needs every rival's
spent teams.

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
on, so the number on the strip and the number the recommendation is chosen by
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
how it ended with the final record, the strip's clock cell becomes the
elimination week, weeks after it read as not played, and the deck opens on the
week it ended. Nothing is deleted: the locks and results stay exactly as they
were, so the season can be read back. Only the result itself changing, by a
correction in `odds.json`, can bring the board out of review.

## What the refresh job does with it

One run refreshes both leagues, in sequence, against separate sport keys and
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
- **No auth.** A shared passcode gates the board once per device and unlocks
  writes. Only its PBKDF2 digest ships in the page (`core/passcode.js`), so the
  passcode cannot be read out of the repo, but the check still runs in the
  browser, so it keeps out passers-by, not anyone determined. Turn on Supabase
  Auth if the pool gets serious.
