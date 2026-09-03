# Deploy

About 40 minutes end to end, most of it clicking through GitHub and Supabase.
When you are done: the board live on GitHub Pages behind a passcode, both phones
sharing one entry per league, odds refreshing every morning, and the board on
both home screens.

**Know this first.** GitHub Pages on a free account needs a **public** repo. The
passcode screen keeps a passer-by from opening the board, but it is checked in
the browser and the plan files, which are your picks, are plain files in a
public repo. Anyone determined can read them. If the picks need to stay truly
between the two of you, see "Keeping it private" at the end.

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

## 3. Shared state and the passcode

### Set up the database

1. supabase.com → **New project**. Name it, set a strong database password
   (save it; you will not need it again), pick the region nearest you. It takes
   about two minutes to provision.
2. **SQL Editor** → **New query** → paste the whole of `supabase/schema.sql` →
   **Run**. It creates the `entries` table, seeds one row per league (`cfb` and
   `nfl`), turns on row-level security with policies limited to those two rows,
   and adds the table to realtime. The editor reports "Success. No rows
   returned".
3. **Table Editor** → `entries`: two rows, `cfb` and `nfl`.

**Already ran an earlier version of the file?** Then the table exists with rows
called `shared` and `shared-nfl`. Run the current file exactly the same way.
It is written to be re-run: it keeps the table, drops the old policies by name
and recreates them for the new ids, seeds `cfb` and `nfl`, and deletes the two
old rows at the end. Nothing was ever saved to them, so nothing is lost. The
Table Editor check above is how you confirm it took.

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
   top. Paste the URL into `url`, the key into `publishableKey`, and choose a
   passcode a few lines below:

```js
supabase: {
  url: "https://xxxxxxxx.supabase.co", // Project URL
  publishableKey: "sb_publishable_...", // Publishable key
  table: "entries",
},
passcode: "pick-something",
```

Commit and push. Pages redeploys, and both phones now share one entry per
league.

From then on, the first time the board is opened on any device it shows a
passcode screen. A right answer is remembered on that device and it goes
straight in after that. The same passcode unlocks writes to the shared entry, so
there is nothing else to type. Change the passcode later and every device asks
again.

The key is public by design, and safe to ship: it can only do what the RLS
policies allow, which is read and write two rows. The passcode is a gate, not a
lock: it lives in the page's JavaScript, so someone determined can find it. It
stops the casual visitor, which is the realistic threat.

**Check:** open the board on two devices. Each asks for the passcode once. Lock
a pick on one and watch it land on the other.

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

The bot runs once a day at 14:00 UTC: 10am Eastern now, 9am after the clocks
change in November. That is the free plan talking. A run costs 4 credits per
league (2 for the lines, 2 for scores), the free plan is 500 credits a month,
and two leagues once a day is about 250 of them. Every six hours, the original
cadence, would be about 960 and run out in two weeks.

Once a day is enough for a survivor pool. Lines move most in the 24 hours before
kickoff, and the 10am pull is the morning number on game day for both leagues.
Results land through the same run, within three days of a game.

If you ever want it more often, do the sum first: 8 credits per run for two
leagues against 500 a month, or pay $30 a month for the 20K plan and forget
about it. To change the hour, edit the cron in
`.github/workflows/refresh-odds.yml` and `refresh.hourUtc` in `src/js/config.js`
together, so the countdown on the board matches.

The **Run workflow** button in the Actions tab is the only manual refresh, and it
is there for testing. Each press costs the same 8 credits.

Locally, without waiting for the schedule:

```bash
ODDS_API_KEY=... npm run refresh
```

## 5. Put it on both phones

The board is installable. The passcode is remembered per device, so each phone
types it once.

**iPhone.** Open the URL in Safari and enter the passcode. Once the board loads,
tap **Share** → **Add to Home Screen** → **Add**. Open it from the home screen.
It may ask for the passcode once more, because iOS gives the installed app its
own storage; after that it goes straight in.

**Android.** Open the URL in Chrome and enter the passcode, then **⋮** →
**Add to Home screen** (or **Install app**). The installed app shares Chrome's
storage, so there is no second ask.

Both phones then: the switch in the masthead flips between NFL and College and
remembers which you used last.

## Keeping it private

Pages cannot put a real login in front of a site, and a private repo (GitHub
Pro, $4/mo) only hides the code: the Pages URL stays open to anyone who has it.
The passcode screen is checked in the browser, so it is a courtesy, not a wall.

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

- **Forgetting the passcode.** It is in `src/js/config.js`, in plain text. If you
  change it, every device asks again on its next open.
- **The first Pages deploy is red.** The deploy workflow fails until Settings →
  Pages has its source set to GitHub Actions. Set it, run the workflow by hand
  once, and every push after that deploys on its own.
- **Deploy from a branch is the wrong source.** That option runs Jekyll over the
  repo. The `.nojekyll` file guards against it, but the GitHub Actions source is
  the one the repo is built for.
- **The odds quota, if you speed up the cron.** See step 4. When the quota runs
  out the failure is quiet: the workflow logs a quota error and the board keeps
  showing the last market lines as if they were fresh.
- **Scheduled workflows pause after 60 days of repo inactivity.** The bot's own
  commits count as activity, so a live season keeps it alive. Out of season it
  will stop; re-enable from the Actions tab.
- **Cron drift.** GitHub queues scheduled runs on shared capacity. A daily job
  can fire 5-20 minutes late. Fine here, not fine for a deadline.
- **Team-name matching.** The Odds API spells some schools differently
  ("Miami (FL)", "Texas A&amp;M Aggies"). `scripts/lib/odds-api.mjs` normalises
  aggressively, but check the workflow log after the first run for
  `no event found` lines and add aliases if any show up.
- **No app icon yet.** `manifest.webmanifest` has an empty icon list, so the
  home-screen tile is a screenshot of the page. Cosmetic; add icons when it
  bothers you.
