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
        │                    data/<league>/{plan,teams,schedule,
        │                                 ratings,odds}.json
        │                                  │
        └──── picks / locks ───────────────┴──▶ Supabase (realtime)
                one row per league
```

## Two leagues, one board

`data/cfb/` and `data/nfl/` hold the same five files. Which one is loaded is a
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

## Why the data is split five ways

| File            | Owner           | Changes when                              |
| --------------- | --------------- | ----------------------------------------- |
| `plan.json`     | a human         | the season strategy is revised            |
| `teams.json`    | a human         | once a season, when ratings are published |
| `schedule.json` | a human         | once a season                             |
| `ratings.json`  | a human         | once a season                             |
| `odds.json`     | the refresh bot | once a day                                |

Keeping them separate is what lets a bot rewrite the numbers every day
without ever touching the strategy or the markup. A merge conflict between the
bot and a human edit is impossible because they never write the same file.

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

The optimiser is a beam search over the remaining weeks (`BEAM_WIDTH` 160,
`CANDIDATE_WIDTH` 12). Exact search is impossible, state is the set of teams
already spent, so the space is 2^50, and a plain greedy pass fails badly,
because taking the biggest favourite every week strands you in the middle of
the season, where nothing is soft.

Three details make it work:

1. **Lookahead in the beam ranking.** Beams are ordered on score _plus_ an
   optimistic estimate of what each still has available in later weeks.
   Without it the search is myopic and lands slightly worse than a careful
   hand-built plan; with it, it beat the authored plan 14.6% to 10.5%.
2. **The authored plan is seeded as a competing beam**, so the recommendation
   can never come back worse than the plan already in `plan.json`.
3. **Buy backs are scored twice.** A beam prunes long before it knows how a
   path ends, and "a loss here is forgiven" is a property of the whole path,
   not of one week: no per-week score can express it. So the search is run at
   several levels of forgiveness (none, what one buy back spread over its weeks
   is worth, and free), and every finalist from every pass is then re-scored on
   the exact survival maths in `core/survival.js`. The pass that discounts most
   is the one that finds paths spending a weak team in week 1 to keep a strong
   one for week 12; the exact re-score is what decides whether that was
   actually better. Without buy backs there is one pass and nothing changes.

Anything locked is a hard constraint, the optimiser works around a decision you
have committed to rather than pretending you can take it back. The seed takes
the locked team in any locked slot for the same reason.

The recommendation is memoised on `(league, currentWeek, buy backs left,
odds.updatedAt, locked picks)`. It deliberately does NOT depend on unlocked
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
undone. A game the feed does not settle (a tie, or one it never returns) stays
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

Each run recomputes the recommendation on the old and the new odds and diffs
them. New numbers in an early week can change the right answer in week 11, so
the whole remaining path is recomputed, not just the current week. If the
advice moved, the job says so in the run log and opens a GitHub issue.

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
