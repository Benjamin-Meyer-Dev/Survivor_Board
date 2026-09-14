# The clock

A Cloudflare Worker whose only job is to fire `refresh-odds.yml` at 9:00am
Toronto, every day, and never at any other time.

## Why it is not a GitHub cron

Because GitHub's cron is not a clock. It queues scheduled runs on shared
capacity and releases them when there is room, which on this repo has meant:

| Day (Sep 2026) | First run, against a 13:00Z slot |
| -------------- | -------------------------------- |
| 8, 9, 10, 11   | 27-37 minutes late               |
| 5, 12          | just over 3 hours late           |
| 7              | 5 hours 16 minutes late          |
| 14             | never fired                      |

Most of the slots the old workflow asked for were dropped outright. The 14th is
the one that cost something: no morning pull, so Sunday's NFL results were not
on the board on Monday.

A `workflow_dispatch` is a different path and is honoured within seconds, so
the schedule moved to a scheduler that keeps time. Cloudflare's cron fires
within seconds of the minute and is not shed under load.

## The token, either way

github.com → Settings → Developer settings → **Fine-grained personal access
tokens** → **Generate new token**. Repository access: **Only select
repositories** → `Survivor_Board`. Permissions → Repository permissions →
**Actions: Read and write**. Nothing else. Generate, and copy it - GitHub shows
it once. A classic token with the `repo` scope works just as well.

## Setting it up in the dashboard

No install, and `wrangler.toml` is not read on this route - which is why
`src/worker.js` carries the same values as defaults. Only the token is entered
by hand.

1. **Make the Worker.** dash.cloudflare.com → **Compute (Workers)** → **Workers
   & Pages** → **Create** → **Start with Hello World** → name it
   `sudden-death-refresh` → **Deploy**. That publishes a placeholder.
2. **Paste the code.** **Edit code** on the Worker → select all in the editor →
   paste the whole of `src/worker.js` over it → **Deploy**.
3. **Add the token.** The Worker → **Settings** → **Variables and Secrets** →
   **Add** → type **Secret**, name `GITHUB_TOKEN`, value the token → **Deploy**.
4. **Add the clock.** **Settings** → **Trigger Events** (older dashboards:
   **Triggers**) → **Add** → **Cron Trigger** → `0 13 * * *`. Add a second one
   for `0 14 * * *`. Both are needed: Cloudflare cron is UTC-only, 9am Toronto
   is 13:00Z on daylight time and 14:00Z on standard, and the Worker drops
   whichever is not 9am locally today.

## Setting it up with wrangler

```bash
npx wrangler login
npx wrangler secret put GITHUB_TOKEN   # paste the token
npx wrangler deploy
```

`wrangler.toml` supplies the crons and the vars, so there is nothing to click.

## Trying it without waiting for 9am

The Worker's log lives at **Workers & Pages** → `sudden-death-refresh` →
**Logs** → **Begin log stream**.

Crons cannot be fired by hand from the dashboard, so to prove the whole path
now: **Settings** → **Variables and Secrets**, add a plain variable
`REFRESH_HOUR` set to the hour it is in Toronto right now, and add a temporary
cron of `*/5 * * * *`. Within five minutes the log says
`Dispatched refresh-odds.yml on main.` and the repo's Actions tab shows a
**Refresh odds** run that logs `Skipping the day` - because the workflow's own
window is hard-coded to 9:00-9:14 and does not care what the Worker thinks the
hour is. That is a complete end-to-end test of the token, the dispatch and the
guard, and it spends no API credits. Delete the temporary cron and set
`REFRESH_HOUR` back to `9` afterwards.

Do not run that test between 9:00 and 9:14 Toronto: there the workflow would
accept the dispatch and take a real pull. Harmless, but it costs 8 credits.

With wrangler instead:

```bash
echo 'GITHUB_TOKEN = "<the token>"' > .dev.vars   # gitignored
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+13+*+*+*"
```

To watch a full pull, use **Run workflow** in the Actions tab, which sends
`reason: manual` and bypasses the window.

## The three places the hour is written

Change one and you have to change all three, or the board counts down to a pull
that is not coming:

| Where                                 | What it sets                    |
| ------------------------------------- | ------------------------------- |
| `src/worker.js` `DEFAULTS`            | when the dispatch is sent       |
| `.github/workflows/refresh-odds.yml`  | which dispatches are accepted   |
| `src/js/config.js` → `CONFIG.refresh` | what the board tells the reader |

`wrangler.toml` repeats the first of those for the wrangler route, and a
dashboard variable of the same name beats the default. Four places if you use
both; check them all.

## When it stops

Two ways this goes quiet without an error anywhere obvious:

- **The token expires.** A fine-grained PAT has a maximum life of a year. When
  it lapses the Worker gets a 401, throws, and the day is skipped - visible only
  in the Worker's log. Put the expiry date in a calendar.
- **The Worker is not deployed, or has no cron.** Nothing else in the repo
  triggers a pull now, so a missing Worker - or one published without its two
  cron triggers, which is the easy thing to forget on the dashboard route -
  means no odds, ever. The board's own "next pull" line will keep counting down
  regardless; it reads `CONFIG.refresh`, not reality.

In both cases the fallback is the same: **Run workflow** in the Actions tab.
