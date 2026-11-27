"use strict";
// No waiting in line: one processing machine per run up to a cap, idle machines stop, paid plans go first only at the cap,
// and clips render while others are still being checked. Unit tests need nothing; the queue order test needs DATABASE_URL_TEST.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { plan, createScaler, configured, maxMachines, authHeader } = require("../src/lib/scaler");
const { startMemeBuilderWorker } = require("../src/worker");
const { limiter } = require("../src/lib/pipeline");
const { refineMoments } = require("../src/lib/refine");

const quiet = { log() {}, error() {}, warn() {} };

describe("how many machines to start", () => {
  test("one per run, never past the cap, never more than are stopped", () => {
    assert.deepEqual(plan({ need: 1, up: 0, down: 3, cap: 3 }), { want: 1, start: 1, atCap: false });
    assert.deepEqual(plan({ need: 2, up: 1, down: 2, cap: 3 }), { want: 2, start: 1, atCap: false });
    assert.deepEqual(plan({ need: 5, up: 1, down: 2, cap: 3 }), { want: 3, start: 2, atCap: true });
    assert.deepEqual(plan({ need: 5, up: 3, down: 0, cap: 3 }), { want: 3, start: 0, atCap: true });
    assert.deepEqual(plan({ need: 1, up: 2, down: 1, cap: 3 }), { want: 1, start: 0, atCap: false }, "busy machines are never stopped by the scaler");
    assert.equal(plan({ need: 0, up: 0, down: 3, cap: 3 }).start, 0);
  });
  test("settings: off without a token and app, the cap defaults to 3 and stays sane", () => {
    assert.equal(configured({}), false);
    assert.equal(configured({ FLY_API_TOKEN: "x" }), false);
    assert.equal(configured({ FLY_API_TOKEN: "x", FLY_WORKER_APP: "w" }), true);
    assert.equal(maxMachines({}), 3);
    assert.equal(maxMachines({ WORKER_MAX_MACHINES: "6" }), 6);
    assert.equal(maxMachines({ WORKER_MAX_MACHINES: "0" }), 3);
    assert.equal(maxMachines({ WORKER_MAX_MACHINES: "500" }), 50);
    assert.equal(authHeader("abc"), "Bearer abc");
    assert.equal(authHeader("FlyV1 fm2_abc"), "FlyV1 fm2_abc");
  });
});

describe("the scaler against a fake Fly API", () => {
  const fakePool = (counts) => ({ query: async () => ({ rows: [counts()] }) });
  const fakeFly = (machines) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method, auth: init.headers.Authorization });
      const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
      if (init.method === "GET") return ok(machines);
      const id = url.match(/machines\/([^/]+)\/start$/)[1];
      const m = machines.find((x) => x.id === id); m.state = "started";
      return ok({ ok: true });
    };
    return { calls, fetchImpl };
  };
  const pool3 = () => [{ id: "a", state: "stopped" }, { id: "b", state: "stopped" }, { id: "c", state: "stopped" }];

  test("a queued run starts exactly one stopped machine, with the token", async () => {
    const machines = pool3();
    const fly = fakeFly(machines);
    const s = createScaler(fakePool(() => ({ queued: 1, running: 0 })), { app: "w", token: "tok", max: 3, fetchImpl: fly.fetchImpl, log: quiet, recheckMs: 60000 });
    const out = await s.ensure(); s.stop();
    assert.equal(out.started, 1);
    assert.equal(fly.calls.filter((c) => c.method === "POST").length, 1);
    assert.ok(fly.calls.every((c) => c.auth === "Bearer tok" && c.url.startsWith("https://api.machines.dev/v1/apps/w/machines")));
  });

  test("five runs at once fill the cap, and say so", async () => {
    const machines = pool3();
    const fly = fakeFly(machines);
    const s = createScaler(fakePool(() => ({ queued: 5, running: 0 })), { app: "w", token: "t", max: 3, fetchImpl: fly.fetchImpl, log: quiet, recheckMs: 60000 });
    const out = await s.ensure(); s.stop();
    assert.equal(out.started, 3);
    assert.equal(out.atCap, true);
    assert.equal(machines.filter((m) => m.state === "started").length, 3);
  });

  test("the cap is never passed, even with more machines in the app", async () => {
    const machines = [...pool3(), { id: "d", state: "stopped" }, { id: "e", state: "stopped" }];
    const fly = fakeFly(machines);
    const s = createScaler(fakePool(() => ({ queued: 9, running: 0 })), { app: "w", token: "t", max: 2, fetchImpl: fly.fetchImpl, log: quiet, recheckMs: 60000 });
    await s.ensure(); s.stop();
    assert.equal(machines.filter((m) => m.state === "started").length, 2);
  });

  test("an empty queue never calls Fly", async () => {
    const fly = fakeFly(pool3());
    const s = createScaler(fakePool(() => ({ queued: 0, running: 0 })), { app: "w", token: "t", max: 3, fetchImpl: fly.fetchImpl, log: quiet });
    await s.ensure(); s.stop();
    assert.equal(fly.calls.length, 0);
  });

  test("calls that arrive together fold into one more look, not one each", async () => {
    const machines = pool3();
    const fly = fakeFly(machines);
    const s = createScaler(fakePool(() => ({ queued: 1, running: 0 })), { app: "w", token: "t", max: 3, fetchImpl: fly.fetchImpl, log: quiet, recheckMs: 60000 });
    await Promise.all([s.ensure(), s.ensure(), s.ensure(), s.ensure()]); s.stop();
    assert.ok(fly.calls.filter((c) => c.method === "GET").length <= 2);
    assert.equal(machines.filter((m) => m.state === "started").length, 1, "one run, one machine");
  });

  test("a Fly error is logged, not thrown", async () => {
    const s = createScaler(fakePool(() => ({ queued: 1, running: 0 })), { app: "w", token: "t", max: 3, log: quiet, recheckMs: 60000,
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => "unauthorized" }) });
    const out = await s.ensure(); s.stop();
    assert.match(out.error.message, /401/);
  });
});

describe("a processing machine stops itself when idle", () => {
  const emptyPool = () => ({ query: async () => ({ rows: [], rowCount: 0 }) });

  test("with nothing to do it exits after the idle time, once", async () => {
    let exits = 0;
    const w = startMemeBuilderWorker(emptyPool(), { log: quiet, idlePollMs: 10, bootDelayMs: 0, exitWhenIdleMs: 40, onIdleExit: () => { exits++; } });
    await new Promise((r) => setTimeout(r, 150));
    w.stop();
    assert.equal(exits, 1);
  });

  test("the web app's own runner never exits (no idle time set)", async () => {
    let exits = 0;
    const w = startMemeBuilderWorker(emptyPool(), { log: quiet, idlePollMs: 10, bootDelayMs: 0, onIdleExit: () => { exits++; } });
    await new Promise((r) => setTimeout(r, 80));
    w.stop();
    assert.equal(exits, 0);
  });

  test("a machine started for a run looks at once and then every couple of seconds", async () => {
    let claims = 0;
    const pool = { query: async (q) => { if (/skip locked/i.test(q)) claims++; return { rows: [], rowCount: 0 }; } };
    const w = startMemeBuilderWorker(pool, { log: quiet, idlePollMs: 15, bootDelayMs: 0 });
    await new Promise((r) => setTimeout(r, 70));
    w.stop();
    assert.ok(claims >= 3, `looked ${claims} times in 70 ms`);
  });
});

describe("parallel work inside a run", () => {
  test("the limiter runs at most N at once and keeps every result", async () => {
    const run = limiter(2);
    let active = 0, peak = 0;
    const out = await Promise.all([1, 2, 3, 4, 5].map((n) => run(async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 10)); active--; return n * 2; })));
    assert.deepEqual(out, [2, 4, 6, 8, 10]);
    assert.equal(peak, 2);
  });
  test("a failure in one task doesn't stop the others", async () => {
    const run = limiter(1);
    const results = await Promise.allSettled([run(async () => { throw new Error("boom"); }), run(async () => "ok")]);
    assert.equal(results[0].status, "rejected");
    assert.equal(results[1].value, "ok");
  });
  test("each checked cut is reported the moment it's done, so its render starts while the rest are still being checked", async () => {
    const order = [];
    const picked = [0, 1, 2].map((i) => ({ moment: { startSec: i * 20, endSec: i * 20 + 10 }, best: { text: `c${i}` } }));
    const delays = [40, 5, 20];
    const out = await refineMoments(picked, {
      sourceFile: "x", workDir: "/tmp", duration: 100,
      makeExcerpt: async () => {}, upload: async (file) => file,
      chat: async ({ messages }) => { const i = Number(messages[0].content[1].url.match(/excerpt-(\d+)/)[1]) - 1; await new Promise((r) => setTimeout(r, delays[i])); return "not json"; },
      onResult: (o) => order.push(o.clip.best.text),
    });
    assert.deepEqual(order, ["c1", "c2", "c0"], "reported in the order they finish, not the order they were asked");
    assert.equal(out.clips.length, 3);
  });
});

const DB = process.env.DATABASE_URL_TEST;
describe("who goes first when every machine is busy", { skip: !DB && "DATABASE_URL_TEST is not set" }, () => {
  const { Pool } = require("pg");
  const { migrate } = require("../src/migrate");
  const store = require("../src/lib/store");
  let pool;
  before(async () => {
    pool = new Pool({ connectionString: DB, ssl: false });
    await migrate(pool);
    await pool.query("truncate usage_events, model_usage, api_keys, sessions, users, meme_builder_clips, meme_builder_jobs, meme_builder_personas cascade");
  });
  after(async () => { await pool.query("truncate meme_builder_clips, meme_builder_jobs, users cascade"); await pool.end(); });

  const user = async (plan) => (await pool.query("insert into users (email, password_hash, plan) values ($1, 'x', $2) returning id", [`${plan}-${Math.random()}@example.com`, plan])).rows[0].id;
  const job = async (owner, agoSeconds) => {
    const j = await store.createJob(pool, { personaId: "p1", sourceKind: "url", sourceLabel: "t", ownerId: owner });
    await pool.query("update meme_builder_jobs set created_at = now() - make_interval(secs => $2) where id = $1", [j.id, agoSeconds]);
    return j.id;
  };

  test("a paid run goes ahead of an older free one; a free run waiting over 2 minutes is not skipped", async () => {
    const free = await user("free"), paid = await user("creator");
    const freeNew = await job(free, 30);
    const paidJob = await job(paid, 5);
    assert.equal((await store.claimNextJob(pool)).id, paidJob, "paid first");
    assert.equal((await store.claimNextJob(pool)).id, freeNew);
    const freeOld = await job(free, 300);
    const paid2 = await job(paid, 5);
    assert.equal((await store.claimNextJob(pool)).id, freeOld, "a free run that has waited 5 minutes counts as paid, and it is older");
    assert.equal((await store.claimNextJob(pool)).id, paid2);
    assert.equal(await store.claimNextJob(pool), null);
    assert.deepEqual(await store.queueCounts(pool), { queued: 0, running: 4 });
  });
});
