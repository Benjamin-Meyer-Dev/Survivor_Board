# Deploy

About 45 minutes end to end, most of it clicking through GitHub and Supabase.
When you are done: the board live on GitHub Pages, both phones sharing one entry
per league, odds refreshing on a schedule, and the board on both home screens.

**Know this first.** GitHub Pages on a free account needs a **public** repo, and
the site is public too. Anyone with the URL can open the board and read the plan
files, which are your picks. The passphrase in step 3 is what stops them from
editing. If the picks need to stay between the two of you, see "Keeping it
private" at the end.

The steps build on each other, so do them in order. Step 5 is optional.

**Accounts**, all on free tiers: GitHub, Supabase, The Odds API. **On your
machine**: git, and Node 20 or newer (`node --version`).

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

## 3. Shared state (Supabase)

1. supabase.com → **New project**. Name it, set a strong database password
   (save it; you will not need it again), pick the region nearest you. It takes
   about two minutes to provision.
2. **SQL Editor** → **New query** → paste the whole of `supabase/schema.sql` →
   **Run**. It creates the `entries` table, seeds the two rows (`shared` for
   college, `shared-nfl` for the NFL), turns on row-level security with policies
   limited to those two rows, and adds the table to realtime. If you ever run
   it twice, the `alter publication` line complains that the table is already a
   member; that is fine.
3. **Table Editor** → `entries`: two rows.
4. **Settings** → **API Keys**: copy the **Project URL** and the
   **publishable key** (`sb_publishable_...`). The legacy `anon` key works
   too; Supabase is retiring it at the end of 2026.
5. Fill them into `src/js/config.js`, and set a passphrase. Do not leave it
   empty: the site is public, and this is what keeps a passer-by from editing
   your entry.

```js
supabase: {
  url: "https://xxxxxxxx.supabase.co",
  anonKey: "sb_publishable_...",
  table: "entries",
  entryId: "shared",
},
writePassphrase: "pick-something",
```

Commit and push. Pages redeploys, and both phones now share one entry per
league.

The key is public by design, and safe to ship: it can only do what the RLS
policies allow, which is read and write two rows. The passphrase is a gate, not
a lock: it lives in the page's JavaScript, so someone determined can find it.
It stops the casual visitor, which is the realistic threat.

**Check:** open the board on two devices. Tap the read-only notice and enter
the passphrase, once per device. Lock a pick on one and watch it land on the
other.

## 4. Automatic odds

1. the-odds-api.com → **Get API key**. The free key arrives by email.
2. Repo → **Settings** → **Secrets and variables** → **Actions** → **New
   repository secret**: name `ODDS_API_KEY`, value the key.
3. **Settings** → **Actions** → **General** → **Workflow permissions** →
   **Read and write**. The bot commits `odds.json` back to the repo.
4. **Actions** → **Refresh odds** → **Run workflow**. The log lists every priced
   line; the bot commits `chore(odds): refresh week 1`; Pages redeploys; the
   board's lines switch from projected to market.

### The quota

The free plan is 500 credits a month, and a refresh is not one request. Each
league costs 2 credits for the odds call (two markets, one region) and 2 for
the scores call, so 4 per league per run.

| Setup                            | Credits / month | Fits in 500? |
| -------------------------------- | --------------: | ------------ |
| Two leagues, every 6 hours       |             960 | No           |
| Two leagues, every 12 hours      |             480 | Barely       |
| NFL only, every 6 hours          |             480 | Barely       |
| Two leagues, every 6 hours, paid |             960 | 20K plan     |

"Barely" leaves no room for the Refresh button, and the count resets on the
first of the month, not from your signup date. Pick one:

- **Pay for the season.** The 20K plan is $30 a month; the season is Sep to Jan.
  Nothing to change.
- **Every 12 hours, free.** In `.github/workflows/refresh-odds.yml` change the
  cron to `"0 */12 * * *"`, and in `src/js/config.js` set `everyHours: 12` so
  the countdown on the board matches. Lines move most in the 24 hours before
  kickoff, so twice a day still catches the Sunday morning number.
- **NFL only, free.** Add `LEAGUE: nfl` under `env:` of the "Fetch current
  lines" step in the same workflow. The college board keeps its projected
  spreads.

Locally, without waiting for the schedule:

```bash
ODDS_API_KEY=... npm run refresh
```

## 5. The Refresh button (optional)

Without this the button still works: it re-reads the league's `odds.json` and
picks up whatever the bot last committed. Wire it up and the button actually
triggers a run.

A static page cannot hold a GitHub token, so a small Supabase function holds it
instead. You need the Supabase CLI (`npm i -g supabase`, then
`supabase login` and `supabase link`):

```bash
supabase functions deploy refresh --no-verify-jwt
supabase secrets set GH_TOKEN=github_pat_... GH_REPO=<you>/survivor-board \
  REFRESH_KEY=any-random-string ALLOW_ORIGIN=https://<you>.github.io
```

`GH_TOKEN` is a fine-grained personal access token scoped to this one repo with
**Actions: read and write** and nothing else (github.com → Settings →
Developer settings → Fine-grained tokens).

Then in `src/js/config.js`:

```js
refresh: {
  dispatchUrl: "https://xxxxxxxx.supabase.co/functions/v1/refresh",
  key: "any-random-string",
},
```

### Why it cannot be spammed

Three guards, deliberately independent, because the first two are only as
honest as the client:

1. **A five minute cooldown in the shared entry.** Both phones see the same
   countdown, so you and the other person cannot each fire one.
2. **A one minute gap in the function**, per warm instance.
3. **A freshness check in `scripts/refresh-odds.mjs`.** If the lines were
   pulled in the last four minutes the job logs and exits. This is the guard
   that actually holds, since nothing in a browser can skip it, and it is why a
   burst of requests costs one round of API credits rather than five.

The workflow's `concurrency` group means two runs never overlap; queued
duplicates simply fall out at the freshness check.

### It does not move the schedule

`schedule` and `workflow_dispatch` are separate triggers. Firing one by hand has
no effect on when the next scheduled run happens.

## 6. Put it on both phones

The board is installable. There is no login, so this is quick.

**iPhone.** Open the URL in Safari. Tap **Share** → **Add to Home Screen** →
**Add**. Open it from the home screen, tap the read-only notice, and enter the
pool passphrase. The device remembers it.

**Android.** Open the URL in Chrome, then **⋮** → **Add to Home screen** (or
**Install app**). Open it, tap the read-only notice, enter the passphrase.

Both phones then: the switch in the masthead flips between NFL and College and
remembers which you used last.

## Keeping it private

Pages cannot put a login in front of a site, and a private repo (GitHub Pro,
$4/mo) only hides the code: the Pages URL stays open to anyone who has it.

The way to gate a Pages site is a domain you own, on Cloudflare. Add the domain
to Cloudflare, CNAME it to `<you>.github.io`, set it as the custom domain under
**Settings** → **Pages** (GitHub then redirects the github.io address to it),
and add a Cloudflare Access self-hosted application for that hostname with one
Allow policy listing two emails. Zero Trust is free for up to 50 users. An
earlier version of this file (`git log docs/DEPLOY.md`) walked through hosting
on Cloudflare Pages instead, which needs no domain of your own.

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

- **The odds quota.** See step 4. Two leagues at six-hourly on the free plan run
  out in about two weeks, and the failures are quiet: the workflow logs a quota
  error and the board keeps showing stale market lines.
- **The first Pages deploy is red.** The deploy workflow fails until Settings →
  Pages has its source set to GitHub Actions. Set it, run the workflow by hand
  once, and every push after that deploys on its own.
- **Deploy from a branch is the wrong source.** That option runs Jekyll over the
  repo. The `.nojekyll` file guards against it, but the GitHub Actions source is
  the one the repo is built for.
- **Scheduled workflows pause after 60 days of repo inactivity.** The bot's own
  commits count as activity, so a live season keeps it alive. Out of season it
  will stop; re-enable from the Actions tab.
- **Cron drift.** GitHub queues scheduled runs on shared capacity. A "6 hourly"
  job can fire 5-20 minutes late. Fine here, not fine for a deadline.
- **Team-name matching.** The Odds API spells some schools differently
  ("Miami (FL)", "Texas A&amp;M Aggies"). `scripts/lib/odds-api.mjs` normalises
  aggressively, but check the workflow log after the first run for
  `no event found` lines and add aliases if any show up.
- **No app icon yet.** `manifest.webmanifest` has an empty icon list, so the
  home-screen tile is a screenshot of the page. Cosmetic; add icons when it
  bothers you.
