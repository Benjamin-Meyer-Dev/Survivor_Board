# Code standards

Short rules, enforced where possible by `npm run lint`, `npm run format:check`
and `npm test`.

## General

- **No build step.** Anything that requires compilation, transpilation or a
  bundler needs a written reason. Native ES modules only.
- **Node 20+ and modern browsers.** Use the platform: `fetch`, `structuredClone`,
  optional chaining, `??`. No polyfills.
- **Two-space indent, double quotes, semicolons, 100-column lines.** Prettier
  owns this; do not argue with it by hand.

## Module boundaries

```
src/js/core/    pure logic, no DOM, no fetch, no imports outside core/
src/js/store/   persistence only; returns plain data
src/js/ui/      rendering only; receives data and handlers, owns no state
src/js/app.js   the only module that wires the other three together
```

- A `core/` module must be importable from Node. `scripts/refresh-odds.mjs`
  imports `core/probability.js` and `core/plan.js` directly, that is the
  point, and it is why those files must never touch `window` or `document`.
- A `ui/` module never imports from `store/`. If a component needs to save
  something, it calls a handler passed in by `app.js`.
- Nothing outside `core/plan.js` reads the raw JSON shapes. A `ui/` module
  takes the board `buildBoard` returns and nothing else; if it needs something
  the board does not carry, the board learns to carry it.
- A region puts its markup on the page through `ui/patch.js` - `paint` for a
  region that changes as a whole, `frame` plus `reconcile` for a list of keyed
  children - so a render replaces only the nodes whose markup changed. A node
  that is kept keeps whatever it was doing, which is what lets a search land
  under a keyframe without cutting it. Never write `innerHTML` on a region a
  render revisits.
- A region binds one delegated listener to its own root (`ui/events.js`), not
  a listener per control. The root outlives every render; the controls do not.

## Naming

- Files: `kebab-case.js`.
- Functions and variables: `camelCase`. Exported constants: `SCREAMING_SNAKE`.
- CSS: BEM-ish, `.block`, `.block__element`, `.block--modifier`. Utilities are
  prefixed `u-`, state classes `is-`.
- One CSS block per UI module, named to match the module.

## CSS

- Every colour resolves through a token in `tokens.css`. A literal hex outside
  that file is a bug.
- Declare the full palette on bare `:root` first, then redefine tokens inside
  the theme blocks. A colour whose only definition sits inside a media query
  will not apply for viewers on the default "system" theme.
- Layout does spacing with `gap`, not per-element margins.
- Anything wide gets its own `overflow-x: auto` container. The page body must
  never scroll sideways.
- Scrollbars are hidden globally in `base.css`. This is a touch-first board;
  scrolling still works everywhere, there is just no visible bar. Both
  `scrollbar-width: none` and `::-webkit-scrollbar` are declared because
  setting the former makes Chromium ignore the latter.
- The board is a split screen (`layout.css`): the readout at the top is sized
  by its content and the drawer below takes the rest and scrolls inside
  itself, and nothing under the shell scrolls while a board is up. Anything
  new on the board goes in one or the other; never add a third scrolling
  region, and never let the readout grow past what a phone can show above the
  drawer's minimum.
- A chalk tag (`.chip`) is coloured by `--tag-fg` alone. A modifier sets that
  and nothing else, so every tag keeps the same chalk rectangle.
- Every class a stylesheet styles is a class something writes, and
  `npm test` fails on the ones that are not
  (`scripts/validate-css.mjs`). A name composed in a template -
  `chip--${tier}` - is found by its prefix, so compose names with a template
  and never by gluing strings together.
- Buttons are chalk rectangles: outlined for the quiet ones, and the flag
  (`--flag`) fills exactly one control per screen, the action that changes
  something for everyone in the pool. A second yellow button on a screen is a
  bug.
- The coach's plan is always pencilled in: dashed lines in the flag's colour
  (`field.css` draws the underlines). A lock is always painted on: solid
  chalk. Never mix the two vocabularies, and never colour a suggestion the way
  a pick is coloured.
- Inside the coach's own vocabulary, a call the week would take is filled and a
  fallback behind it is not: the numbered tag on a team list row and the rows
  under the card both say it that way. A fallback drawn like a call reads as a
  second pick the week is making, which is the one thing it is not.
- The pitch (`.pitch__field`) scrolls sideways on a phone under end zones held
  at either edge, one column of `--yard-w` per week; from 900px every week
  fits and the columns share the width. A week owns its whole column, so
  anything added to a yard line is absolutely positioned inside it and
  narrower than `--yard-w`.

## The theme

`src/css/field.css` is the thematic layer: the turf and its grain, the
floodlight on the week on the clock, the hash marks, the painted end zones,
the chalk dashes under everything the coach only suggests. It is separate on
purpose: it sets no layout and no state, so deleting the file leaves a working,
plainer app. Keep it that way. Anything structural belongs in `components.css`.

Football vocabulary is content, not decoration, and lives where the content
does: `TIER_LABEL` in `core/probability.js` (Lock / Solid / Shaky / Close call /
Upset alert), the drawer's tab labels in `ui/tabs.js`, the drive line in
`ui/pitch.js`. Never let a themed word cost clarity: "Pick a team" stayed
literal for that reason, and the end zone says "Survive" because that is what
reaching it means.

## Motion

All of it lives in `src/css/motion.css`. Two rules keep it from becoming
noise:

- **Transitions are for states that survive a render**, hover, focus, press.
  A re-render replaces the node, so a transition on re-rendered content never
  runs.
- **Feedback for an action is a one-shot keyframe applied after the render**
  that produced the new markup (`playEffect` in `app.js`, `applyPanels` in
  `ui/tabs.js`). Never put an entrance animation on something that re-renders
  on every action, the notices deliberately have none, because they would
  flash on every tap.

Everything is switched off by the `prefers-reduced-motion` block in
`base.css`, and nothing in the app depends on an animation completing.

- **A duration is written once, in the stylesheet that draws it.** Nothing in
  `src/js/` counts milliseconds to know when a move is over: `ui/motion.js`
  asks the browser (`getAnimations`, which reports transitions too) and
  resolves when the last of them has finished, with a guard so a move that
  never ends cannot strand the caller. The two used to be written twice and
  drifted, in both directions.
- A control whose position animates (the field's bracket, the tab marker, the
  league marker) must
  be built once and updated in place. These render functions run on every board
  update, and an element rebuilt from markup has no previous position to move
  from, so it teleports. `renderTabs` and `renderLeagueBar` both take this
  shape: `build*` on the first call, attribute updates after. Prefer a mark
  that moves by `transform` over a state lit on each of several elements in
  turn: one compositor-friendly move, and it says which way the thing went.
- One-shot feedback is applied AFTER the render that produced the markup.
  `innerHTML` replaces the node, so a class set beforehand is thrown away.
- Never start blocking work while an animation is running. It does not quietly
  continue: it stalls and then jumps. Yield until the animation is done, or -
  better - get the work off the main thread (see `core/search.js`).

## Safety

- Anything interpolated into `innerHTML` goes through `escapeHtml()`. The entry
  state is written by another person and is untrusted input.
- A failed write must never break the UI. Catch, keep the optimistic local
  state, let the next write retry.
- Never put a secret in `src/`. The Supabase anon key is public by design and
  is protected by row-level security, not by hiding it. The Odds API key lives
  only in GitHub secrets and is used only by `scripts/`. League codes are
  generated by the app rather than configured and are nowhere in the repo. The
  app's access code is nowhere in the repo either: `config.js` holds its
  salted PBKDF2 digest, written by `npm run passcode`, and
  `scripts/validate-passcode.mjs` fails if the block ever spells a code out.

## Data files

- Data is namespaced by league: `data/cfb/` and `data/nfl/` hold the same
  files. Never reach across, and never hardcode a league outside
  `src/js/leagues.js`.
- `plan.json`, `teams.json`, `schedule.json` and `ratings.json` are
  hand-edited (or seeded once by `npm run seed -- <league>`). `odds.json`,
  `form.json`, `stats.json` and `snapshots/` are bot-owned, edits to them will
  be overwritten and they are in `.prettierignore` for that reason.
  `calibration.json` and `history.json` are script-owned: `npm run calibrate`
  and `npm run history` write them, a human runs those and commits the result,
  and nobody edits them by hand.
- `availability.json` and `pool.json` are the two files a human keeps during
  the season. Every availability entry carries `source` and `reportedAt`, and
  `pool.json` carries `updatedAt`, because the board's cache and the refresh
  job's diff both key on them.
- Four data files are optional and the board opens without any of them:
  `form.json` (until the first run with something to fit), `calibration.json`
  (the defaults in `core/probability.js` are the college numbers),
  `availability.json` (nothing reported) and `pool.json` (the field implied
  from the lines).
  Anything loading them treats absence as normal. `ratings.json` stays the FBS
  membership test either way. `npm run rate` refits `form.json` from what is
  already on disk, with no API call, which is also how you rebuild it after a
  hand-edit to `odds.json`.
- Any change to a `plan.json` must pass `npm test`, which enforces each pool's
  own rules: the declared weeks and picks per week, no repeated team, eligible
  conferences, every pick a real game at the site claimed, every pick favoured,
  and buy backs naming weeks that exist.

## League differences

A rule that differs between the pools belongs in `src/js/leagues.js` and, for
anything the browser needs at runtime, in that league's `plan.json`. It does
not belong in a conditional. Concretely:

- A colour that differs between the pools goes in `src/css/leagues.css` under
  `:root[data-league="<id>"]`, never in a component rule. That file loads last
  and its ordering is load-bearing; the comment at the top says why.
- Nothing under `src/js/ui/` may branch on the league. If a panel needs to know
  something, put it on the board in `core/plan.js` and render from that.
- `core/` functions take rules as arguments and default to the college values,
  so an old caller keeps working rather than silently changing behaviour.
- Numbers that mean different things in different leagues (a spread, above all)
  get compared through a league-relative scale. `confidenceTier` buckets on win
  probability for exactly this reason: -14 is routine in college and enormous
  in the NFL.

## Commits

Conventional commits, present tense:

```
feat(ui): show a conflict banner when a swap repeats a team
fix(odds): fall back to the projection when no book has posted
chore(odds): refresh week 8
docs(architecture): explain why the bot does not re-plan
```

The refresh bot commits as `chore(odds): …` and is the only automated author.

## Pull requests

CI must be green: lint, format, and plan validation. For anything touching
`core/`, say in the description what the derived board looks like before and
after, that is where a silent wrong number would come from.
