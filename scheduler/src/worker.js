/**
 * The clock for the odds bot.
 *
 * GitHub's own cron cannot keep time - it queues scheduled runs on shared
 * capacity and this repo has seen them released anywhere from 27 minutes to
 * five hours late, with most slots dropped and some mornings missed entirely.
 * A workflow_dispatch, though, is honoured within seconds. So the schedule
 * lives here instead: Cloudflare's cron fires at 9:00am Toronto and this
 * Worker dispatches .github/workflows/refresh-odds.yml.
 *
 * Nothing else runs here. There is no fetch handler on purpose: a public URL
 * that starts the job would let anyone spend the day's API credits. To try it
 * without waiting for 9am, run `npx wrangler dev --test-scheduled` and curl
 * the local `/__scheduled` endpoint, which exists only in dev.
 */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },
};

/**
 * Cloudflare's cron is UTC-only, so wrangler.toml asks for both UTC hours that
 * 9am Toronto can fall in and this drops the one that is not 9am today. That
 * is what holds the local hour steady across daylight saving, and it is the
 * same trick the workflow's own window check uses at the other end.
 */
async function dispatch(env) {
  const timeZone = env.REFRESH_TIMEZONE;
  const hour = localHour(timeZone);
  const wanted = Number(env.REFRESH_HOUR);
  if (hour !== wanted) {
    console.log(
      `${pad(hour)}:00 in ${timeZone}, not ${pad(wanted)}:00. ` +
        `The other daylight-saving slot; nothing to do.`,
    );
    return;
  }

  const url =
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}` +
    `/actions/workflows/${env.WORKFLOW_FILE}/dispatches`;

  // A transient 5xx at 9:00:00 would otherwise cost the day: Cloudflare does
  // not retry a failed cron, and the workflow skips a dispatch that arrives
  // after 9:14. Three tries a few seconds apart stay well inside that window.
  // A 4xx is not retried - a bad token or a renamed workflow will not heal in
  // ten seconds, and the failure should be loud in the Worker's log instead.
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          // GitHub rejects an API call with no User-Agent.
          "User-Agent": `${env.GITHUB_REPO}-refresh-scheduler`,
        },
        body: JSON.stringify({
          ref: env.GITHUB_REF,
          // What tells refresh-odds.yml this is the 9am pull and not someone
          // testing from the Actions tab. Only this one is held to the window.
          inputs: { reason: "scheduled" },
        }),
      });

      // 204 No Content is the success case for a dispatch.
      if (response.ok) {
        console.log(`Dispatched ${env.WORKFLOW_FILE} on ${env.GITHUB_REF}.`);
        return;
      }

      const body = await response.text();
      if (response.status < 500) {
        throw new Error(`GitHub answered ${response.status}: ${body}`);
      }
      lastError = new Error(`GitHub answered ${response.status}: ${body}`);
    } catch (error) {
      // A network failure lands here too, and is worth another try.
      if (error.message?.startsWith("GitHub answered 4")) throw error;
      lastError = error;
    }

    if (attempt < 3) await sleep(3000);
  }

  throw lastError;
}

function localHour(timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "numeric",
  }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === "hour").value);
}

const pad = (n) => String(n).padStart(2, "0");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
