"use strict";
// What happens after a run ends (finished or failed): count the usage, tell the caller. Never throws.
const store = require("./lib/store");
const keys = require("./lib/keys");
const webhooks = require("./webhooks");

async function afterRun(pool, jobId, { log = console } = {}) {
  try {
    const job = await store.getJob(pool, jobId);
    if (!job) return;
    const clipCount = (await store.listJobClips(pool, jobId)).length;
    if (job.status === "done") await keys.recordUsage(pool, job, clipCount);
    webhooks.deliver(pool, job, clipCount, { log });   // not awaited: the retries must not hold up the next job
  } catch (e) {
    log.error("[after-run]", e && e.message);
  }
}

module.exports = { afterRun };
