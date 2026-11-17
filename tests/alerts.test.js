"use strict";
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const alerts = require("../src/alerts");
const ai = require("../src/lib/ai");
const { AiError } = require("../src/lib/ai");

const realFetch = global.fetch;
const HOOK = "https://hooks.example.test/T000/abc";
let posts;
const fakeHook = () => { posts = []; global.fetch = async (url, init) => { if (String(url) === HOOK) { posts.push(JSON.parse(init.body)); return { ok: true, status: 200 }; } return realFetch(url, init); }; };
const done = () => { global.fetch = realFetch; delete process.env.ALERT_WEBHOOK_URL; alerts.reset(); };

describe("alerts (no database)", () => {
  beforeEach(() => { alerts.reset(); });
  test("nothing is sent, and nothing is fetched, until a webhook URL is set", async () => {
    delete process.env.ALERT_WEBHOOK_URL; let called = false; global.fetch = async () => { called = true; return { ok: true }; };
    try { assert.equal(await alerts.alert("x", "y"), false); assert.equal(called, false); assert.equal(alerts.configured(), false); } finally { done(); }
  });
  test("a message is posted as JSON that both Slack and Discord accept, labelled with the app and the kind", async () => {
    process.env.ALERT_WEBHOOK_URL = HOOK; fakeHook();
    try {
      assert.equal(await alerts.alert("out_of_credit:google", "google is out of credit"), true);
      assert.equal(posts.length, 1); assert.equal(posts[0].text, posts[0].content);
      assert.match(posts[0].text, /out_of_credit:google: google is out of credit/); assert.match(posts[0].text, /^\[Meme Builder/);
    } finally { done(); }
  });
  test("the same kind is sent once per window, a different kind is not held back, and long messages are cut", async () => {
    process.env.ALERT_WEBHOOK_URL = HOOK; fakeHook();
    try {
      const t = 1_000_000;
      assert.equal(await alerts.alert("a", "1", { now: t }), true); assert.equal(await alerts.alert("a", "2", { now: t + 60_000 }), false, "a minute later: held back");
      assert.equal(await alerts.alert("b", "1", { now: t + 60_000 }), true, "another kind goes straight out");
      assert.equal(await alerts.alert("a", "3", { now: t + alerts.WINDOW_MS + 1 }), true, "after the window it can go again");
      await alerts.alert("long", "x".repeat(5000)); assert.ok(posts.at(-1).text.length < 600);
      assert.equal(posts.length, 4);
    } finally { done(); }
  });
  test("a webhook that is down or refuses never makes the caller fail", async () => {
    process.env.ALERT_WEBHOOK_URL = HOOK;
    try {
      global.fetch = async () => { throw new Error("connection refused"); }; assert.equal(await alerts.alert("down", "x"), false);
      global.fetch = async () => ({ ok: false, status: 500 }); assert.equal(await alerts.alert("refused", "x"), false);
    } finally { done(); }
  });
  test("an AI provider running out of credit raises an alert (once, even over several requests)", async () => {
    process.env.ALERT_WEBHOOK_URL = HOOK; fakeHook();
    const keep = {}; for (const k of ["GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "KIE_API_KEY", "MEME_BUILDER_TEXT_MODELS"]) { keep[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, { GOOGLE_API_KEY: "g", ANTHROPIC_API_KEY: "a", MEME_BUILDER_TEXT_MODELS: "google:gem-test,anthropic:claude-test" });
    const realErr = console.error; console.error = () => {}; ai.resetModelHealth();
    const hook = global.fetch;
    global.fetch = async (url, init) => {
      if (String(url) === HOOK) return hook(url, init);
      return String(url).includes("googleapis") ? { status: 402, ok: false, headers: new Map(), text: async () => JSON.stringify({ error: { message: "Payment required" } }) } : { status: 200, ok: true, headers: new Map(), text: async () => JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: {} }) };
    };
    try {
      for (let i = 0; i < 3; i++) await ai.chat({ messages: [{ role: "user", content: "hi" }] });
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(posts.length, 1); assert.match(posts[0].text, /out_of_credit:google/);
    } finally { console.error = realErr; ai.resetModelHealth(); done(); for (const k of Object.keys(keep)) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } }
  });
});

const DB = process.env.DATABASE_URL_TEST;
describe("alerts from the runner (real database)", { skip: !DB && "DATABASE_URL_TEST is not set" }, () => {
  const { Pool } = require("pg");
  const accounts = require("../src/accounts");
  const { migrate } = require("../src/migrate");
  const { createRun } = require("../src/intake");
  const { startMemeBuilderWorker } = require("../src/worker");
  let pool, user;
  const quiet = { log() {}, error() {}, warn() {} };
  const queued = async () => (await createRun(pool, { ownerId: user.id }, { personaId: "truckers", sourceUrl: `https://8.8.8.8/${crypto.randomUUID()}.mp4` })).job;
  const runWith = async (fn) => { const w = startMemeBuilderWorker(pool, { log: quiet, run: fn, afterRun: async () => {}, retryPauseMs: 1 }); await w.tick(); w.stop(); await new Promise((r) => setTimeout(r, 30)); };
  before(async () => {
    process.env.MEME_BUILDER_STORAGE_BACKEND = "local";
    pool = new Pool({ connectionString: DB, ssl: /\/tmp\/|localhost|127\.0\.0\.1/.test(DB) ? false : { rejectUnauthorized: false } });
    await migrate(pool);
    user = await accounts.signup(pool, { email: `al-${crypto.randomUUID().slice(0, 6)}@example.com`, password: "a-long-enough-password" });
    await accounts.setPlan(pool, user.id, "agency");
  });
  after(async () => { done(); await pool.end(); });
  beforeEach(async () => { await pool.query("update meme_builder_jobs set status = 'done' where status in ('queued','running')"); alerts.reset(); process.env.ALERT_WEBHOOK_URL = HOOK; fakeHook(); });

  test("a run that fails because the AI service is broken raises an alert naming the run", async () => {
    const job = await queued();
    await runWith(async () => { throw new AiError("google: the API key was rejected", { code: "bad_key" }); });
    assert.equal(posts.length, 1); assert.match(posts[0].text, /ai_failure/); assert.ok(posts[0].text.includes(job.id)); assert.match(posts[0].text, /API key was rejected/);
  });
  test("a system failure (ffmpeg, disk, network) raises one too", async () => {
    await queued(); await runWith(async () => { throw new Error("ffmpeg exited 1: no space left on device"); });
    assert.equal(posts.length, 1); assert.match(posts[0].text, /system_error/);
  });
  test("a failure that is the customer's (a video that is too long) does not", async () => {
    await queued(); await runWith(async () => { throw new Error("This video is 40 minutes long. The Starter plan allows up to 15."); });
    assert.equal(posts.length, 0);
  });
  test("runs found stuck after a crash raise an alert", async () => {
    const job = await queued();
    await pool.query("update meme_builder_jobs set status = 'running', attempts = 1, heartbeat_at = now() - interval '10 minutes' where id = $1", [job.id]);
    await runWith(async () => {});
    assert.ok(posts.some((p) => /orphaned_runs/.test(p.text) && /1 run/.test(p.text)), JSON.stringify(posts));
  });
});
