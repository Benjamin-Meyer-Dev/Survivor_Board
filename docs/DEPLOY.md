# Deploy

About 40 minutes end to end, most of it clicking through GitHub and Supabase.
When you are done: the board live on GitHub Pages, leagues you can invite people to, both phones
sharing a board with everyone you send a code to, odds refreshing every
morning, and the board on every home screen.

**Know this first.** GitHub Pages on a free account needs a **public** repo, so
the page is open to anyone who has the address. A league's picks live in the
database rather than the repo, and a league is only findable by its code - but
the publishable key that reads the database ships in the page, so "findable
only by code" is a practical obstacle rather than a wall. If the picks need to
stay properly private, see "Keeping it private" at the end.

The steps build on each other, so do them in order.

**Accounts**, all on free tiers: GitHub, Supabase, The Odds API. **On your
machine**: git, and Node 22 or newer (`node --version`).

## 1. Put the repo on GitHub

If the folder is not a git repo yet:

```bash
cd survivor-board
git init -b main
git add .
git commit -m "feat: initial survivor board"
```

Create the remote at github.com/new: name `survivor-board`, **Public**, and
leave README, .gitignore and license unticked so it is empty. Then:

```bash
git remote add origin https://github.com/<you>/survivor-board.git
git push -u origin main
```

The first push opens a browser window to sign in; Git Credential Manager keeps
the token after that. If you have the GitHub CLI, the create-and-push is one
line instead: `gh repo create survivor-board --public --source=. --push`.

**Check:** the repo's Actions tab shows a green **CI** run (lint, formatting,
plan validation). The **Deploy to Pages** run next to it is red, because Pages is
not switched on yet. Step 2 fixes that.

## 2. Turn on Pages

1. Repo → **Settings** → **Pages** → **Build and deployment** → Source:
   **GitHub Actions**. There is nothing to pick after that: the workflow is
   already in the repo at `.github/workflows/pages.yml`.
2. **Actions** → **Deploy to Pages** → **Run workflow** → branch `main`. About a
   minute. From now on every push to `main` redeploys on its own, including the
   odds bot's commits.
3. The address is `https://<you>.github.io/survivor-board/`. It is also shown at
   the top of **Settings** → **Pages** once the first deploy lands.

**Check:** the board loads, in per-device mode. It says changes stay on this
device; that is expected until step 3.

## 3. Shared state and league codes

### Set up the database

The table holds one row per league, keyed by the code the app generates. There
is nothing to seed: leagues are made from the home page, and the first one you
create writes the first row.

1. supabase.com → **New project**. Name it, set a strong database password
   (save it; you will not need it again), pick the region nearest you. It takes
   about two minutes to provision.
2. **SQL Editor** → **New query** → paste the whole of `supabase/schema.sql` →
   **Run**. It creates the `leagues` table, constrains a row to a real code
   and a season the repo has data for, grants the public key's role access,
   turns on row-level security, and adds the table to realtime. The editor
   reports "Success. No rows returned".
3. Open the board, create a league, and check **Table Editor** → `leagues`:
   one row, with the code the home page is showing you.

   Read the note at the top of `supabase/schema.sql` before you send a code to
   anyone. In short: a code is the credential, the policies let the page's
   publishable key read and write any row, and making that airtight means
   Supabase Auth and a memberships table instead.

**Coming from the three built-in pools?** The old `entries` table is not read
any more. Re-run `supabase/schema.sql`, which creates `leagues` beside it, then
create a league per pool you were running and re-enter what those pools held.
The last lines of the file are the query that shows you what was in them and
the drop that clears them out; nothing does it for you, because those rows are
the only copy of those picks.

**Already ran an earlier version of the file?** Run the current one exactly the
same way. It is written to be re-run: it creates what is missing, drops the old
policies by name and replaces them, and leaves the rows alone. The Table Editor
check above is how you confirm it took.

### Wire the board to it

4. You need two values. The quickest place for both is the **Connect** button
   at the top of the dashboard: pick any framework and the panel shows the
   **Project URL** and the **Publishable key** together.
   - **Project URL** looks like `https://xxxxxxxx.supabase.co`. It is not on
     the API Keys page. Besides Connect, it is under **Project Settings** →
     **Data API**, and it is also just your project ref, the string after
     `/project/` in the dashboard's address bar, with `https://` in front and
     `.supabase.co` after. Use only that, with no `/rest/v1` or other path.
   - **Publishable key** starts `sb_publishable_` and lives under
     **Project Settings** → **API Keys**. The legacy `anon` key on the same
     page works too; Supabase is retiring it at the end of 2026.
5. Open `src/js/config.js` in your editor. The `supabase` block is near the
   top. Paste the URL into `url` and the key into `publishableKey`:

```js
supabase: {
  url: "https://xxxxxxxx.supabase.co", // Project URL
  publishableKey: "sb_publishable_...", // Publishable key
  table: "entries",
},
```

### Make a league and invite people

Commit and push. Pages redeploys, and the board can now share leagues.

The first launch on any device asks for a name. That name goes on the picks
that device makes and is stored on the phone that typed it; there is nothing to
sign up for and no password anywhere.

Then, on the home page:

1. **Create** a league - give it a name, pick the season, and it appears with a
   twelve-character code (`BXQK-7HRT-M4WD`).
2. **Copy link** puts `https://<your board>/#/join/BXQK7HRTM4WD` on the
   clipboard. Send that, or read the code out: **Join** takes it typed, with or
   without the dashes, and the five characters that get misread - I, L, O, 0 and
   1 - are not in the alphabet, so a code cannot be copied down as a different
   one.
3. Whoever opens the link lands in the league, appears in its members, and is
   working the same board as you.

**Check:** open the board on two devices, join the same league on both, lock a
pick on one and watch it land on the other.

**What a code is, and is not.** Anyone holding a league's code can read that
board and write to it - that is the point of sending one. The publishable key
that ships in the page is what talks to the database, and the policies let it
read and write rows, so someone who takes that key out of the page could reach
leagues they were never sent. Nobody can be locked out and nothing can be lost
from outside the app, but a league is not private in the way an account would
make it. The note at the top of `supabase/schema.sql` says this again where the
policies are, and sketches the Auth-and-memberships version if you want it.

## 4. Automatic odds

1. the-odds-api.com → **Get API key**. The free key arrives by email.
2. Repo → **Settings** → **Secrets and variables** → **Actions** → **New
   repository secret**: name `ODDS_API_KEY`, value the key.
3. **Settings** → **Actions** → **General** → **Workflow permissions** →
   **Read and write**. The bot commits `odds.json` back to the repo.
4. **Actions** → **Refresh odds** → **Run workflow**. The log lists every priced
   line; the bot commits `chore(odds): refresh week 1`; Pages redeploys; the
   board's lines switch from projected to market.

### The schedule

The bot runs once a day at 9:00am Toronto time. The workflow schedules both UTC
hours that Toronto can use and skips the alternate, so the local time stays at
9:00am across daylight-saving changes. A run costs 4 credits per league (3 for
the lines - spreads, moneylines and totals are a credit each - and 1 for
scores), the free plan is 500 credits a month, and two pulls once a day is
about 250 of them. Every six hours, the original cadence, would be about 960
and run out in two weeks. Set `ODDS_MARKETS=spreads,h2h` on the workflow to
drop totals and save a credit per league; the model prices without them.

Two more sources ride along at no cost to the quota. The NFL's efficiency
numbers come from nflverse, a public file that needs no key. The college ones
come from CollegeFootballData and need a free key. Without it the run says the
layer is off and fits on lines and margins alone.

### The college efficiency key

1. Go to collegefootballdata.com and choose **API Key** in the top menu (the
   page is `/key`). Enter an email address and submit; the key arrives by
   email within a minute. The free tier is enough: the refresh job makes one
   request per week played, once a day.
2. Repo → **Settings** → **Secrets and variables** → **Actions** → **New
   repository secret**: name `CFBD_API_KEY`, value the key from the email.
   Save.
3. Nothing else changes. `.github/workflows/refresh-odds.yml` already passes
   the secret to the job, and `scripts/lib/stats.mjs` picks it up as
   `CFBD_API_KEY`. The next scheduled run, or a **Run workflow** from the
   Actions tab, writes `data/cfb/stats.json` and the log's efficiency line
   changes from "CFBD_API_KEY is not set" to how many team-games it pulled.
4. Locally, the same variable works for `npm run stats -- cfb` and
   `npm run refresh`. Do not put the key in `src/` or commit it anywhere; like
   the odds key, it lives only in the secret and your shell.

### Pool rules from the board

The gear beside the league picker holds that league's name, its code, and its
rules - win or lose, picks a week, buy backs and the weeks they cover. Saving
rules writes them into the league's shared row, so they land on every device in
it. Nothing in `data/` changes: the season's plan file stays the default and
**Back to the plan** returns to it.

Two consequences worth knowing. A league running its own rules shows a lit gear,
because a week with one slot looks the same whether the pool takes one pick or
takes two with a rule changed. And the daily job reads `plan.json` rather than
the shared entry, so its "pick flagged" issue is judged by the file's rules.

### The two files you keep by hand

`data/<league>/availability.json` and `data/<league>/pool.json` are optional
and the board runs without them. Templates with every field explained are in
`docs/examples/`; copy one into the league's folder, edit it, bump
`updatedAt`, commit, and the next deploy and the next refresh run both read
it. Availability entries move a market line only when their `reportedAt` is
newer than the morning pull, so an injury the market has already priced is
never counted twice. The pool file needs this week's pick popularity from
wherever your pool shows it; without those shares the board stays in survival
mode rather than guess.

Once a day is enough for a survivor pool. Lines move most in the 24 hours before
kickoff, and the 9am pull is the morning number on game day for both leagues.
Results land through the same run, within three days of a game.

That 9am is aimed at rather than guaranteed. GitHub queues scheduled runs on
shared capacity, and this repo has seen them released three to five hours after
their slot, so the workflow schedules the day's pull from many slots - some
before 9am, on the theory that a delayed early slot lands near 9am, most in and
after the 9am hour - and the first run that starts does the work. Two rules in
the **Check the Toronto refresh window** step make that safe: nothing pulls
before 9am local whatever fires, and nothing pulls twice on the same local
calendar day. So the extra slots cost fifteen seconds each and no API credits.

A pull at 9am on the dot is not something GitHub cron can promise. If you need
one, trigger it from a clock you own: any scheduler that can make an HTTP call
(Windows Task Scheduler, cron on a machine that is always up, a free cron
service) firing this, with a fine-grained token that has actions:write on the
repo, starts the run within seconds.

```bash
curl -X POST -H "Authorization: Bearer <token>" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/<owner>/Survivor_Board/actions/workflows/refresh-odds.yml/dispatches \
  -d '{"ref":"main"}'
```

A dispatch skips the window check by design, so it pulls whenever you send it.

If you ever want it more often, do the sum first: 8 credits per run for two
leagues against 500 a month, or pay $30 a month for the 20K plan and forget
about it. To change the hour or timezone, edit the crons and the local-time
guard in `.github/workflows/refresh-odds.yml` together with `refresh` in
`src/js/config.js`, so the countdown on the board matches.

The **Run workflow** button in the Actions tab is the only manual refresh, and it
is there for testing. Each press costs the same 8 credits.

Locally, without waiting for the schedule:

```bash
ODDS_API_KEY=... npm run refresh
```

## 5. Put it on both phones

The board is installable. The name is remembered per device, so each phone
gives one once, and the leagues it joins are remembered with it.

**iPhone.** Open the URL in Safari and give your name. Once the board loads,
tap **Share** → **Add to Home Screen** → **Add**. Open it from the home screen.
It may ask for your name once more, because iOS gives the installed app its
own storage; after that it goes straight in.

**Android.** Open the URL in Chrome and give your name, then **⋮** →
**Add to Home screen** → **Install**. Chrome lists that entry only for a site it
considers installable, which it decides after reading
`manifest.webmanifest` and registering `sw.js`, so let the board finish loading
before you open the menu. The installed app shares Chrome's storage, so there is
no second ask.

If the menu offers neither **Add to Home screen** nor **Install app**, Chrome has
judged the site not installable. In order of likelihood:

- **The URL is not the Pages one.** It has to be the `https://` address. The
  `http://<laptop-ip>:4173` dev server is an insecure origin, and Chrome hides
  install on those; `localhost` is the only exception, and that is not reachable
  from a phone.
- **It is an Incognito tab.** Install is disabled there.
- **It is already installed.** Chrome drops the entry once the app is on the home
  screen. Check the app drawer before adding it again.
- **The deploy is older than the icons.** Installability needs the manifest's
  192 and 512 px icons and a registered service worker, both added after the
  first version of this doc. Pull to refresh, then confirm with desktop Chrome on
  the same URL: **DevTools** → **Application** → **Manifest** lists the icons and
  any reason the site is not installable, and **Application** → **Service
  workers** shows `sw.js` as activated and running.

Both phones then: the switch in the masthead flips between NFL and College and
remembers which you used last.

## Keeping it private

Pages cannot put a real login in front of a site, and a private repo (GitHub
Pro, $4/mo) only hides the code: the Pages URL stays open to anyone who has it.
League codes are unguessable, but the key that reads them is in the page, so
they are a courtesy rather than a wall.

The way to gate a Pages site properly is a domain you own, on Cloudflare. Add
the domain to Cloudflare, CNAME it to `<you>.github.io`, set it as the custom
domain under **Settings** → **Pages** (GitHub then redirects the github.io
address to it), and add a Cloudflare Access self-hosted application for that
hostname with one Allow policy listing two emails. Zero Trust is free for up to
50 users. An earlier version of this file (`git log docs/DEPLOY.md`) walked
through hosting on Cloudflare Pages instead, which needs no domain of your own.

## Local development

```bash
npm install
npm run serve      # http://localhost:4173
```

ES modules need HTTP; opening `index.html` from the filesystem will fail on
CORS. Before pushing:

```bash
npm run lint && npm run format:check && npm test
```

## Things that will bite you

- **Losing a league's code.** It is not written down anywhere in the repo: the
  app generated it, the device that made the league remembers it, and the
  `leagues` table has it. Any phone still in the league can show it, from the
  home page or the gear; failing that, the Table Editor lists every row.
- **Clearing a browser's site data** takes that device's name and its list of
  leagues with it. The leagues themselves are untouched - paste a code back in
  and everything is where it was.
- **The first Pages deploy is red.** The deploy workflow fails until Settings →
  Pages has its source set to GitHub Actions. Set it, run the workflow by hand
  once, and every push after that deploys on its own.
- **Deploy from a branch is the wrong source.** That option runs Jekyll over the
  repo. The `.nojekyll` file guards against it, but the GitHub Actions source is
  the one the repo is built for.
- **"Could not sync this change: permission denied for table entries."** The
  `anon` role the publishable key uses has no privileges on the table, so every
  read and write is refused before the RLS policies are even consulted. The
  board still opens, but empty, because a failed read falls back to a blank
  entry. Re-run `supabase/schema.sql` in the SQL Editor; the `grant` statements
  in it fix this, and it is safe to run over an existing table. Then reload
  both phones. To confirm from a terminal, this should return every row rather
  than a `42501` error:

  ```bash
  curl "https://<ref>.supabase.co/rest/v1/entries?select=id" \
    -H "apikey: <publishable key>"
  ```

- **The odds quota, if you speed up the cron.** See step 4. When the quota runs
  out the failure is quiet: the workflow logs a quota error and the board keeps
  showing the last market lines as if they were fresh.
- **Scheduled workflows pause after 60 days of repo inactivity.** The bot's own
  commits count as activity, so a live season keeps it alive. Out of season it
  will stop; re-enable from the Actions tab.
- **Cron drift.** GitHub queues scheduled runs on shared capacity, and the
  delay is not minutes: through the opening weekend of 2026 every slot on this
  repo was released three to five hours late. The workflow now spreads the
  day's pull across many slots and lets the first one that starts do the work,
  which is as punctual as cron gets here. For a real deadline, dispatch it from
  a scheduler you own - see step 4.
- **Team-name matching.** The Odds API spells some schools differently
  ("Miami (FL)", "Texas A&amp;M Aggies"). `scripts/lib/odds-api.mjs` normalises
  aggressively, but check the workflow log after the first run for
  `no event found` lines and add aliases if any show up.
- **A phone that installed the board before the icons existed, or before they
  last changed, keeps the old tile.** Chrome re-reads the manifest on its own
  schedule, and an app added when the icon list was empty holds on to the
  screenshot it made. Remove it from the home screen and add it again to pick
  up the current icon.
