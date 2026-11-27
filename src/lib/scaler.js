"use strict";
// Starts a processing machine on Fly for each waiting run, so nobody waits in line.
//
// The worker app on Fly has a fixed pool of machines (`fly scale count worker=N`), all stopped when there is nothing to do:
// a stopped machine costs only its disk. When a run is queued, this starts stopped machines until there is one per run
// (queued + running), up to WORKER_MAX_MACHINES. A started machine takes the next run within a couple of seconds, and
// exits on its own once it has had nothing to do for WORKER_IDLE_EXIT_SECONDS (see src/worker.js), which stops it.
// When every machine is busy, runs wait and paid plans go first (store.claimNextJob).
//
// Runs in the web app. Configured by:
//   FLY_API_TOKEN        a deploy token for the worker app: fly tokens create deploy -a <worker app>
//   FLY_WORKER_APP       the worker app's name (fly.toml's app)
//   WORKER_MAX_MACHINES  the most machines ever running at once, the cost cap (default 3)
// Without FLY_API_TOKEN and FLY_WORKER_APP it does nothing (one always-on worker, or the web app's own runner).

const store = require("./store");
const alerts = require("../alerts");

const API = "https://api.machines.dev/v1";
const UP = new Set(["started", "starting", "created", "replacing", "updating"]);
const DOWN = new Set(["stopped", "suspended"]);
const RECHECK_MS = 10 * 1000;   // while runs are waiting or running, look again this often; when the queue is empty, stop looking

const authHeader = (token) => (/^FlyV1 /.test(token) ? token : `Bearer ${token}`);

function configured(env = process.env) { return !!(env.FLY_API_TOKEN && env.FLY_WORKER_APP); }
function maxMachines(env = process.env) {
  const n = Math.floor(Number(env.WORKER_MAX_MACHINES));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 50) : 3;
}

/**
 * How many machines to start. Pure.
 * need: runs queued + running. up: machines already started. down: stopped machines that can be started. cap: the most allowed.
 */
function plan({ need, up, down, cap }) {
  const want = Math.min(cap, need);
  const start = Math.max(0, Math.min(down, want - up));
  return { want, start, atCap: need > up + start && up + start >= cap };
}

function createScaler(pool, { app = process.env.FLY_WORKER_APP, token = process.env.FLY_API_TOKEN, max = maxMachines(), fetchImpl = (...a) => fetch(...a), log = console, recheckMs = RECHECK_MS } = {}) {
  const call = async (method, path) => {
    const res = await fetchImpl(`${API}/apps/${encodeURIComponent(app)}${path}`, { method, headers: { Authorization: authHeader(token), "Content-Type": "application/json" }, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Fly ${method} ${path} answered ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
  let running = null, again = false, timer = null, warnedFew = false, stopped = false;

  async function once() {
    const { queued, running: busy } = await store.queueCounts(pool);
    const need = queued + busy;
    if (!need) return { need, started: 0 };
    const machines = (await call("GET", "/machines")) || [];
    const workers = machines.filter((m) => { const g = m.config && m.config.metadata && m.config.metadata.fly_process_group; return !g || g === "worker"; });
    const cap = Math.min(max, workers.length);
    if (workers.length < max && !warnedFew) { warnedFew = true; log.warn(`[scaler] WORKER_MAX_MACHINES is ${max} but the worker app has ${workers.length} machine(s). Run: fly scale count worker=${max} -a ${app}`); }
    const up = workers.filter((m) => UP.has(m.state));
    const down = workers.filter((m) => DOWN.has(m.state));
    const p = plan({ need, up: up.length, down: down.length, cap });
    const results = await Promise.allSettled(down.slice(0, p.start).map((m) => call("POST", `/machines/${m.id}/start`)));
    const started = results.filter((r) => r.status === "fulfilled").length;
    for (const r of results) if (r.status === "rejected") log.warn("[scaler] starting a machine failed:", r.reason && r.reason.message);
    if (p.atCap && queued) {
      log.log(`[scaler] all ${cap} machines are busy, ${queued} run(s) waiting (paid plans go first)`);
      alerts.alert("queue_at_cap", `All ${cap} processing machines are busy and ${queued} run(s) are waiting. Raise WORKER_MAX_MACHINES (and fly scale count) if this keeps happening.`);
    }
    return { need, queued, running: busy, up: up.length, started, cap, atCap: p.atCap };
  }

  /** Look at the queue and start machines if needed. Calls that arrive while one is in flight are folded into one more pass. */
  async function ensure() {
    if (stopped) return null;
    if (running) { again = true; return running; }
    running = (async () => {
      let out = null;
      do {
        again = false;
        try { out = await once(); } catch (err) { log.error("[scaler]", err && err.message); out = { error: err }; }
      } while (again);
      return out;
    })();
    try {
      const out = await running;
      clearTimeout(timer);
      // Keep an eye on it while there is work (a run that failed and was put back, a machine that stopped early).
      if (!stopped && out && (out.need || out.error)) { timer = setTimeout(ensure, recheckMs); if (timer.unref) timer.unref(); }
      return out;
    } finally { running = null; }
  }

  return { ensure, stop() { stopped = true; clearTimeout(timer); } };
}

/** Wire the scaler into the web app: every queued run triggers a look, and one look at start-up catches runs left waiting. */
function startScaler(pool, opts = {}) {
  if (!configured()) return null;
  const scaler = createScaler(pool, opts);
  const unsubscribe = require("./queue-signal").onJobQueued(() => scaler.ensure());
  setTimeout(() => scaler.ensure(), 1000).unref?.();
  (opts.log || console).log(`[scaler] on: up to ${maxMachines()} machine(s) in ${process.env.FLY_WORKER_APP}`);
  return { ...scaler, stop() { scaler.stop(); unsubscribe(); } };
}

module.exports = { createScaler, startScaler, plan, configured, maxMachines, authHeader };
