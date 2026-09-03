/**
 * Manual refresh trigger.
 *
 * The board is a static page, so it cannot hold a GitHub token. This function
 * does: it takes an unauthenticated POST from the page and calls
 * workflow_dispatch on its behalf. The token never reaches the browser.
 *
 * workflow_dispatch and schedule are separate triggers, so firing this does
 * NOT move the next 6 hourly run.
 *
 * Deploy:
 *   supabase functions deploy refresh --no-verify-jwt
 *   supabase secrets set GH_TOKEN=... GH_REPO=you/survivor-board REFRESH_KEY=...
 *
 * GH_TOKEN needs a fine-grained PAT with Actions: read and write on that repo
 * and nothing else.
 */

const ALLOW_ORIGIN = Deno.env.get("ALLOW_ORIGIN") ?? "*";

const cors = {
  "access-control-allow-origin": ALLOW_ORIGIN,
  "access-control-allow-headers": "content-type, x-refresh-key",
  "access-control-allow-methods": "POST, OPTIONS",
};

/** Cheapest possible rate limit: one in-memory stamp per warm instance. */
let lastDispatch = 0;
const MIN_GAP_MS = 60_000;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: cors });
  }

  const expected = Deno.env.get("REFRESH_KEY");
  if (expected && request.headers.get("x-refresh-key") !== expected) {
    return new Response("Forbidden", { status: 403, headers: cors });
  }

  const now = Date.now();
  if (now - lastDispatch < MIN_GAP_MS) {
    // Not an error: the run they wanted is already on its way.
    return Response.json(
      { ok: true, skipped: "a dispatch went out moments ago" },
      { headers: cors },
    );
  }

  const repo = Deno.env.get("GH_REPO");
  const token = Deno.env.get("GH_TOKEN");
  if (!repo || !token) {
    return new Response("Not configured", { status: 500, headers: cors });
  }

  const response = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/refresh-odds.yml/dispatches`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ref: Deno.env.get("GH_BRANCH") ?? "main" }),
    },
  );

  if (!response.ok) {
    const detail = await response.text();
    return new Response(`GitHub said ${response.status}: ${detail}`, {
      status: 502,
      headers: cors,
    });
  }

  lastDispatch = now;
  return Response.json({ ok: true }, { headers: cors });
});
