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

## Setting it up

1. **A token GitHub will accept.** github.com → Settings → Developer settings →
   **Fine-grained personal access tokens** → **Generate new token**. Repository
   access: **Only select repositories** → `Survivor_Board`. Permissions →
   Repository permissions → **Actions: Read and write**. Nothing else. Generate,
   and copy it.

2. **Tell the Worker.** From this directory:

   ```bash
   npx wrangler login
   npx wrangler secret put GITHUB_TOKEN   # paste the token
   npx wrangler deploy
   ```

3. **Check it dispatched.** The Cloudflare dashboard → Workers →
   `sudden-death-refresh` → Logs shows one invocation a day at 13:00Z or 14:00Z,
   one of which logs `not 09:00 ... nothing to do` and the other
   `Dispatched refresh-odds.yml on main.`

## Trying it without waiting for 9am

```bash
echo 'GITHUB_TOKEN = "<the token>"' > .dev.vars   # gitignored
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+13+*+*+*"
```

This really does dispatch the workflow, but it costs nothing: outside the
9:00-9:14 window `refresh-odds.yml` logs `Skipping the day` and exits before it
spends an API credit. To watch a full pull instead, use **Run workflow** in the
Actions tab, which defaults to `reason: manual` and bypasses the window.

## The three places the hour is written

Change one and you have to change all three, or the board counts down to a pull
that is not coming:

| Where                                 | What it sets                    |
| ------------------------------------- | ------------------------------- |
| `wrangler.toml`                       | when the dispatch is sent       |
| `.github/workflows/refresh-odds.yml`  | which dispatches are accepted   |
| `src/js/config.js` → `CONFIG.refresh` | what the board tells the reader |

## When it stops

Two ways this goes quiet without an error anywhere obvious:

- **The token expires.** A fine-grained PAT has a maximum life of a year. When
  it lapses the Worker gets a 401, throws, and the day is skipped - visible only
  in the Worker's log. Put the expiry date in a calendar.
- **The Worker is not deployed.** Nothing else in the repo triggers a pull now,
  so an undeployed Worker means no odds, ever. The board's own "next pull" line
  will keep counting down regardless; it reads `CONFIG.refresh`, not reality.

In both cases the fallback is the same: **Run workflow** in the Actions tab.
