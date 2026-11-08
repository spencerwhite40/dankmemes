"use strict";
// Tell the caller when a run finishes: POST a small signed JSON body to the run's webhook_url.
// Best effort with a few retries; callers should also be able to poll GET /v1/runs/:id.
const crypto = require("node:crypto");
const media = require("./lib/media");
const keys = require("./lib/keys");

const RETRY_MS = [1000, 10000, 60000];

const sign = (secret, body) => `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;

function buildPayload(job, clipCount) {
  return JSON.stringify({
    event: job.status === "done" ? "run.finished" : "run.failed",
    run: { id: job.id, status: job.status, clip_count: clipCount, error: job.error || null, finished_at: job.finished_at },
  });
}

async function postOnce(url, secret, body, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  await media.assertPublicUrl(url);           // re-checked at send time, not just when the run was created
  const res = await fetchImpl(url, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    headers: { "Content-Type": "application/json", "X-Meme-Signature": sign(secret, body), "User-Agent": "meme-builder-webhook/1" },
    body,
  });
  if (!res.ok) throw new Error(`webhook answered ${res.status}`);
}

/** Fire and forget: schedules the attempts and returns immediately. */
function deliver(pool, job, clipCount, { fetchImpl, delays = RETRY_MS, log = console } = {}) {
  const url = job.options && job.options.webhookUrl;
  if (!url || !job.api_key_id) return Promise.resolve();
  return (async () => {
    const key = await keys.getKeyById(pool, job.api_key_id);
    if (!key) return;
    const body = buildPayload(job, clipCount);
    for (let i = 0; i <= delays.length; i++) {
      try { await postOnce(url, key.webhook_secret, body, { fetchImpl }); return; }
      catch (e) {
        if (i === delays.length) { log.error(`[webhook] giving up on run ${job.id}:`, e && e.message); return; }
        await new Promise((r) => { const t = setTimeout(r, delays[i]); if (t.unref) t.unref(); });
      }
    }
  })();
}

module.exports = { sign, buildPayload, postOnce, deliver };
