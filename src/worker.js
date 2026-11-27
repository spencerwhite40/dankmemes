"use strict";

// Meme Builder job runner. Runs queued jobs one at a time (ffmpeg is
// CPU-heavy; serial keeps a small instance safe). Claiming uses
// FOR UPDATE SKIP LOCKED, so a second instance never double-runs a job, and
// stale 'running' jobs from a crashed/redeployed process are re-queued
// (capped at 3 attempts).
//
// Database load is kept low on purpose: an idle runner checks the queue once
// every IDLE_POLL_MS (one cheap query), is woken immediately when a route
// queues a job (queue-signal.js), and looks for stale jobs only every
// STALE_CHECK_MS. While a job is running it makes no polling queries at all.
//
// Env:
//   MEME_BUILDER_RUNNER = off   don't run jobs in this process (e.g. when a
//                               dedicated worker does it). Default: run here.
//
// Started from startBackgroundWorkers() (inherits SKIP_BACKGROUND_WORKERS and
// the preview-environment guard).

const store = require("./lib/store");
const { processJob } = require("./lib/pipeline");
const { friendlyMessage, AiError, ledger } = require("./lib/ai");
const accounts = require("./accounts");
const alerts = require("./alerts");

const STEP_LABELS = {
  fetch: "getting the video", prepare: "preparing it", upload: "uploading it", analyze: "watching it", analyzed: "writing captions",
  captions: "writing captions", selected: "checking the cuts", verify: "checking the cuts", render: "rendering clips",
};
const { onJobQueued } = require("./lib/queue-signal");
const storage = require("./lib/storage");

const IDLE_POLL_MS = 30 * 1000;
const MAX_JOB_MS = 45 * 60 * 1000;
const MAX_AUTO_ATTEMPTS = 3;          // a run that hits a transient AI-service failure is retried on its own up to this many times
const RETRY_PAUSE_MS = 45 * 1000;     // short breather so an outage has a moment to clear
const TOO_LONG = "This run took too long and was stopped. Try a shorter video, or press Retry.";

/** Reject if `promise` hasn't settled within `ms`. A hung step must never block the runner for every later job. */
function withTimeout(promise, ms, message = TOO_LONG) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
const STALE_CHECK_MS = 60 * 1000;   // looking for orphaned runs is one cheap query

function secondsEnv(name) { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n * 1000 : null; }

/**
 * The defaults suit the runner inside the web app; src/run-worker.js (the dedicated machine) sets these from its env.
 * idlePollMs:     how often an idle runner checks the queue (WORKER_IDLE_POLL_SECONDS there, default 30 s). A dedicated machine
 *                 started for a run checks every couple of seconds, because the web app's "a run was queued" signal
 *                 doesn't reach another process.
 * bootDelayMs:    first look after start-up (default 15 s; 0 on a machine that was started for a run).
 * exitWhenIdleMs: stop the process once nothing has run for this long (WORKER_IDLE_EXIT_SECONDS). On Fly the machine
 *                 then stops and costs nothing; the web app starts it again when a run is queued (src/lib/scaler.js).
 */
function startMemeBuilderWorker(pool, { log = console, run = processJob, retryPauseMs = RETRY_PAUSE_MS, afterRun = require("./hooks").afterRun,
  idlePollMs = IDLE_POLL_MS, bootDelayMs = 15 * 1000, exitWhenIdleMs = null, onIdleExit = () => process.exit(0) } = {}) {
  if ((process.env.MEME_BUILDER_RUNNER || "").toLowerCase() === "off") {
    log.log("[meme-builder] runner disabled via MEME_BUILDER_RUNNER=off");
    return { stop() {}, tick: async () => {} };
  }
  log.log(`[meme-builder] runner started, storage backend: ${storage.backendName()}${storage.backendName() === "local" ? " (TEMPORARY: files are lost on every restart; set the R2 credentials)" : ""}`);
  let busy = false;
  let lastStaleCheck = 0;
  let lastWork = Date.now();
  let exited = false;

  async function tick() {
    if (busy) return;
    busy = true;
    let ran = false;
    try {
      // Drain: keep going while there is queued work, then go back to idle polling.
      for (;;) {
        if (Date.now() - lastStaleCheck >= STALE_CHECK_MS) {
          lastStaleCheck = Date.now();
          const orphaned = await store.requeueStale(pool);
          if (orphaned) alerts.alert("orphaned_runs", `${orphaned} run(s) were found stuck (their machine went away) and were put back in the queue or failed.`);
        }
        const job = await store.claimNextJob(pool);
        if (!job) break;
        ran = true;
        log.log(`[meme-builder] job ${job.id} started (attempt ${job.attempts})`);
        if (await accounts.isLocked(pool, job.owner_id).catch(() => false)) {
          await store.failJob(pool, job.id, "This account's subscription has ended, so the run was not started.").catch(() => {});
          continue;
        }
        try {
          const plan = await accounts.planFor(pool, job.owner_id);
          await withTimeout(ledger.runWithContext({ ownerId: job.owner_id, jobId: job.id, stage: "starting", tier: plan.models }, () => run(pool, job, { log, plan })), MAX_JOB_MS);
          log.log(`[meme-builder] job ${job.id} done`);
          await afterRun(pool, job.id, { log });
        } catch (err) {
          log.error(`[meme-builder] job ${job.id} failed:`, err && err.message);
          // The AI service is flaky: a transient failure (5xx, overload, stall) puts the run back in the queue
          // on its own instead of making someone press Retry. Anything else, or too many tries, fails it plainly.
          const transient = err instanceof AiError && err.retryable;
          if (transient && job.attempts < MAX_AUTO_ATTEMPTS && await store.requeueForRetry(pool, job.id).catch(() => false)) {
            log.log(`[meme-builder] job ${job.id} will retry on its own (attempt ${job.attempts} of ${MAX_AUTO_ATTEMPTS})`);
            await new Promise((r) => setTimeout(r, retryPauseMs));
          } else {
            // Say which step it was on, so "it failed" is never a mystery.
            const cur = await store.getJob(pool, job.id).catch(() => null);
            const step = cur && STEP_LABELS[cur.stage];
            await store.failJob(pool, job.id, friendlyMessage(err) + (step ? ` (it was ${step})` : "")).catch(() => {});
            // Tell the owner of the service about failures that are the service's problem, not the customer's (a bad video isn't one).
            if (err instanceof AiError || /ffmpeg|ENOSPC|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|took too long/i.test(err && err.message || "")) {
              alerts.alert(err instanceof AiError ? "ai_failure" : "system_error", `run ${job.id} failed${step ? ` while ${step}` : ""}: ${err && err.message}`);
            }
            await afterRun(pool, job.id, { log });
          }
        }
      }
    } catch (err) {
      // A DB blip must never take the process down; the next poll retries.
      log.error("[meme-builder] tick error:", err && err.message);
    } finally {
      busy = false;
      if (ran) lastWork = Date.now();
    }
    if (exitWhenIdleMs && !exited && Date.now() - lastWork >= exitWhenIdleMs) {
      exited = true;
      log.log(`[meme-builder] nothing to do for ${Math.round(exitWhenIdleMs / 1000)} s, stopping this machine`);
      stop();
      onIdleExit();
    }
  }

  const timer = setInterval(tick, idlePollMs);
  if (timer.unref) timer.unref();
  const unsubscribe = onJobQueued(tick);
  // Pick up anything left queued across a restart without waiting a full poll.
  const boot = setTimeout(tick, bootDelayMs);
  if (boot.unref) boot.unref();
  function stop() { clearInterval(timer); clearTimeout(boot); unsubscribe(); }
  return { stop, tick };
}

module.exports = { startMemeBuilderWorker, withTimeout, secondsEnv, MAX_JOB_MS };
