# Survivor Board

A shared tracker for two survivor pools, college and NFL, switched from the
masthead.

The NFL board opens by default; the switch remembers whichever you used last,
and each league carries its own palette so a glance tells you where you are.

Two people, two devices, one entry per league. Market lines and final scores
refresh once a day, so wins and losses mark themselves; picks and locks sync
between phones in real time.

|              | College              | NFL                         |
| ------------ | -------------------- | --------------------------- |
| Weeks        | 1-13                 | 1-18                        |
| Picks a week | 2                    | 1                           |
| Eligible     | SEC, Big Ten, Big 12 | all 32                      |
| Opponent     | must be FBS          | any                         |
| Buy backs    | none                 | one, covering weeks 1 and 2 |

Both pools are straight-up wins with no team used twice. A buy back forgives
one loss; it does not give the team back, so a week 1 loss costs both the team
and the cushion. That is why the NFL path takes its biggest risk in week 2 and
plays it safe from week 3 on.

## Quick start

```bash
npm install
npm run serve     # http://localhost:4173
```

The board runs immediately with per-device state. See
[docs/DEPLOY.md](docs/DEPLOY.md) to put it on Pages and turn on shared state
and automatic odds.

## Layout

```
index.html                    the whole UI shell
manifest.webmanifest          makes it installable to a home screen
sw.js                         service worker: install support, instant launch, offline board
icons/                        home-screen icons, 192 · 512 · maskable · iOS, plus the SVG source

data/cfb/  data/nfl/          one folder per league, same five files
  plan.json                   the season path and the pool's rules
  teams.json                  eligible teams + power ratings
  schedule.json               every game, by week
  ratings.json                the rating each team is priced off
  odds.json                   market lines, written by the bot, never by hand

src/css/
  tokens.css                  every colour in the app
  leagues.css                 per-league palette overrides
  base.css                    element defaults, type utilities
  layout.css                  page shell and rhythm
  components.css              one block per UI module

src/js/
  app.js                      wiring and the render loop
  config.js                   Supabase keys, passcode digest, paths
  leagues.js                  everything that differs between the two pools
  core/                       pure logic, also imported by the Node scripts
    plan.js                   merges plan + odds + entry into the derived board
    probability.js            spread → win probability, de-vig, tiers
    survival.js               season survival, buy backs included
    recommend.js              beam search over the remaining weeks
    format.js                 display formatting and HTML escaping
    passcode.js               derives the passcode digest, shared with the set script
  store/                      persistence (Supabase, localStorage fallback)
  ui/                         rendering only, no state, no fetch

scripts/
  refresh-odds.mjs            the daily odds job, both leagues
  seed-plan.mjs               author a league's plan.json from the optimiser
  set-passcode.mjs            set the pool passcode; only its digest lands in config.js
  build-icons.mjs             redraws icons/ from the startup football through headless Chrome
  validate-plan.mjs           enforces both pools' rules in CI
  lib/                        odds API client, season calendar

supabase/schema.sql           one table, RLS policies, realtime
.github/workflows/            refresh-odds · pages · ci
docs/                         architecture, code standards, deploy
```

## Commands

| Command               | What it does                                                           |
| --------------------- | ---------------------------------------------------------------------- |
| `npm run serve`       | Local server on :4173                                                  |
| `npm test`            | Validates every `plan.json` against its rules, and the config          |
| `npm run passcode`    | Sets the pool passcode; the repo only ever holds its digest            |
| `npm run icons`       | Redraws the home-screen icons from the startup football (needs Chrome) |
| `npm run refresh`     | Pulls live odds (needs `ODDS_API_KEY`)                                 |
| `npm run seed -- nfl` | Re-authors a league's plan from the optimiser                          |
| `npm run rate`        | Refits the team ratings from the pulls on disk, no API call            |
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

Nothing under `src/js/ui/` knows which league is loaded. How many picks a week
holds, whether a loss can be bought back, and where "Lock" starts all come off
the board, which reads them from the plan. Adding a third pool is a folder
under `data/` and an entry in `src/js/leagues.js`.

Only the current week is priced by the market - books do not post week 9 in
September - so every week after it is projected from team ratings. Those
ratings are refitted at the end of every run from the market lines and final
margins the pull has collected, which is how the plan for the rest of the
season keeps up with the season actually being played. See
[How the ratings learn](docs/ARCHITECTURE.md#how-the-ratings-learn).

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
