# Chalk

A tracker for as many survivor pools as you are in. Make a league, send its
code to the people you are playing with, and everyone works the same board.

First launch asks what to call you - that name goes on the picks you make.
After that the home page lists your leagues: **Create** one for the people you
play with, ticking every pool it runs - NFL winners, NFL losers, College
winners, College losers, any of them - or **Join** with a twelve-character code
someone sent you. A league has one shared board per pool, so the people in it
see the same picks and locks in real time, and market lines and final scores
refresh once a day, so wins and losses mark themselves.

A league is one or more pools. Each is a season, played for winners or for
losers - which is decided when the league is made and cannot change - with its
own rules on top:

|          | College season       | NFL season |
| -------- | -------------------- | ---------- |
| Weeks    | 1-13                 | 1-18       |
| Eligible | SEC, Big Ten, Big 12 | all 32     |
| Opponent | must be FBS          | any        |

and the rules its members set, from the gear beside its name - how many
**picks a week**, how many **buy backs** and the weeks they cover. Those are
the pool's, not the device's: saving them re-plans the season on every phone in
it. No team can be used twice either way,
and a buy back forgives a loss without giving the team back, so a week 1 loss
costs both the team and the cushion.

Nothing about a league is built into the app. The repo carries the two seasons -
the schedules, the lines, the ratings and the calibrated model - and every
pool is a row keyed by its league's code, its season and whether its picks win
or lose. However many you make, they read the same two daily pulls and cost
nothing extra.

**A code is the credential.** There are no accounts: anyone holding a league's
code can read that board and write to it, which is the point of sending one.
What that does not protect against is the publishable Supabase key that ships
in the page - see the note at the top of [supabase/schema.sql](supabase/schema.sql),
which is also where the upgrade to real accounts is written down.

## Quick start

```bash
npm install
npm run serve     # http://localhost:4173
```

The board runs immediately with per-device state. It opens behind an access
code (`npm run passcode -- "the code"` sets it; `--clear` takes the door off).
See [docs/DEPLOY.md](docs/DEPLOY.md) to put it on Pages and turn on shared
state and automatic odds.

## Layout

```
index.html                    the whole UI shell
manifest.webmanifest          makes it installable to a home screen
sw.js                         service worker: install support, instant launch, offline board
icons/                        home-screen icons, 192 · 512 · maskable · iOS, plus the SVG source

data/cfb/  data/nfl/          one folder per season, the same files
  plan.json                   the season calendar, its model settings and a seeded path
  teams.json                  eligible teams + power ratings
  schedule.json               every game, by week
  ratings.json                the rating each team is priced off
  odds.json                   market lines, written by the bot, never by hand
  form.json                   ratings refitted to the season so far, written by the bot
  stats.json                  efficiency margins per game, written by the bot (NFL; college with a key)
  snapshots/                  one file per refresh run, the day's lines, never rewritten
  calibration.json            the league's fitted probability model, from `npm run calibrate`
  history.json                past seasons' lines and results, from `npm run history`
  availability.json           player availability, kept by hand (optional)
  pool.json                   the pool's picks by team, kept by hand (optional; implied from the lines without it)

src/css/
  tokens.css                  every colour in the app
  leagues.css                 per-league palette overrides
  base.css                    element defaults, type utilities
  layout.css                  page shell and rhythm
  components.css              one block per UI module

src/js/
  app.js                      wiring and the render loop
  config.js                   Supabase keys, storage keys, paths
  sports.js                   the two seasons: what a league is made of that nobody chooses
  worker-search.js            hands the season search to a worker, where there is one
  core/                       pure logic, also imported by the Node scripts
    objective.js              win or lose: the one place two leagues on one season differ
    rules.js                  a league's rules, over its season's defaults, clamped
    code.js                   league codes: made, read loosely, and shared as a link
    plan.js                   merges plan + odds + entry into the derived board
    probability.js            the calibrated margin model: spread → win probability, de-vig, horizon
    survival.js               season survival, buy backs included
    recommend.js              beam search over the remaining weeks, plus the frontier across futures
    recommend.worker.js       the same search, on its own thread
    search.js                 where a search runs: nowhere by default, so Node searches inline
    assignment.js             exact maximum-weight assignment (Hungarian), the beam's benchmark
    scenarios.js              seeded futures: how the projections might turn out
    availability.js           player availability as a points adjustment
    equity.js                 pool leverage from pick popularity
    format.js                 display formatting and HTML escaping
  store/                      persistence (Supabase, localStorage fallback)
    directory.js              the leagues: made, joined, listed, renamed, left
    merge.js                  two devices' writes to one pool, reconciled per slot
  ui/                         rendering only, no state, no fetch
    motion.js                 waiting for a move to finish, so no duration is written twice
    events.js                 one delegated listener per region, however often it is rebuilt
    home.js                   your leagues, and where they are made and shared
    name.js                   the start screen: what to call you
    settings.js               a league's own sheet - its name, its code, its rules

scripts/
  refresh-odds.mjs            the daily odds job, every pool with games of its own
  rate-form.mjs               refit the ratings from the pulls on disk
  pull-stats.mjs              pull the efficiency statistics (nflverse; CFBD with a key)
  import-history.mjs          import past seasons from nflverse and cfbfastR-data
  calibrate.mjs               fit the probability model and tune the rating fit on history
  backtest.mjs                score this season's board against what has happened
  seed-plan.mjs               author a league's plan.json from the optimiser
  build-icons.mjs             redraws icons/ from the board's football through headless Chrome
  validate-*.mjs              the checks `npm test` runs
  lib/                        odds API client, season calendar, rating fit, calibration, backtest, JSON I/O

supabase/schema.sql           one table, RLS policies, realtime
.github/workflows/            refresh-odds · pages · ci
docs/                         architecture, code standards, deploy
```

## Commands

| Command               | What it does                                                           |
| --------------------- | ---------------------------------------------------------------------- |
| `npm run serve`       | Local server on :4173                                                  |
| `npm test`            | Validates every `plan.json` against its rules, the config and the CSS  |
| `npm run icons`       | Redraws the home-screen icons from the board's football (needs Chrome) |
| `npm run refresh`     | Pulls live odds (needs `ODDS_API_KEY`)                                 |
| `npm run seed -- nfl` | Re-authors a league's plan from the optimiser                          |
| `npm run rate`        | Refits the team ratings from the pulls on disk, no API call            |
| `npm run stats`       | Pulls this season's efficiency numbers (college needs `CFBD_API_KEY`)  |
| `npm run history`     | Imports past seasons' lines and results from the public archives       |
| `npm run calibrate`   | Fits the probability model to the history; `--write` keeps it          |
| `npm run backtest`    | Scores this season's probabilities, projections, fit and calls         |
| `npm run lint`        | ESLint                                                                 |
| `npm run format`      | Prettier, write                                                        |

## How it fits together

`data/<league>/plan.json` is the pool's rules and calendar plus an authored
path that seeds the coach, `odds.json` is what the market says, and Supabase
holds what you two have actually done. `core/plan.js` folds the three into one
derived board and every UI module renders from that, so if a number looks
wrong, there is exactly one place to look.

Every slot is picked by hand and locked by hand. The coach only suggests: a
badge on the team it would take, a ghosted stand-in where a slot is empty, and
a faint path for the weeks ahead. Locking or unlocking a pick is what makes it
re-plan the rest of the season.

It names twice what a week needs, ranked - a first and a second choice for the
NFL pool's one pick a week, four for the college pool's two - and a fallback is
the whole rest of the season re-planned without the calls above it, not the
next biggest favourite of the week. See
[Suggestion vs pick](docs/ARCHITECTURE.md#suggestion-vs-pick).

Nothing under `src/js/ui/` knows which league is loaded. How many picks a week
holds, whether a loss can be bought back, and where "Lock" starts all come off
the board, which reads them from the plan. Adding a third pool is a folder
under `data/` and an entry in `src/js/leagues.js`.

Only the current week is priced by the market - books do not post week 9 in
September - so every week after it is projected from team ratings. Those
ratings are refitted at the end of every run from the market lines, final
margins and efficiency numbers the pull has collected, which is how the plan
for the rest of the season keeps up with the season actually being played. See
[How the ratings learn](docs/ARCHITECTURE.md#how-the-ratings-learn).

Every probability on the board comes through a model fitted to the league's
own history: how margins scatter around a spread, how much a moneyline is
worth against it, and how far a projection made today misses the line the
market will post in six weeks. The coach then judges this week's choice across
futures rather than on one path; the refresh job prints the two to four
openings it weighed and what each costs. See
[The probability model](docs/ARCHITECTURE.md#the-probability-model) and
[Futures](docs/ARCHITECTURE.md#futures).

The refresh bot rewrites each league's `odds.json` and `form.json` and nothing
else, which is why it can run every day without ever conflicting with a human
edit. It flags a pick whose line has collapsed, says which remaining weeks the
new numbers moved, and opens an issue - but it deliberately does not re-plan
the season for you, see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#why-the-bot-does-not-re-plan).

## Docs

- [Architecture](docs/ARCHITECTURE.md), data flow and the reasoning behind it
- [Code standards](docs/CODE_STANDARDS.md), module boundaries, naming, safety
- [Deploy](docs/DEPLOY.md), the full setup: repo, Pages, Supabase, odds, phones
