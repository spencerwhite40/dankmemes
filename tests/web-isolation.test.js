"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const DB = process.env.DATABASE_URL_TEST;
describe("the web page's run and clip routes belong to their owner (real database)", { skip: !DB && "DATABASE_URL_TEST is not set" }, () => {
  const { Pool } = require("pg");
  const accounts = require("../src/accounts");
  const store = require("../src/lib/store");
  const { PLANS } = require("../src/plans");
  const { migrate } = require("../src/migrate");
  const { buildApp } = require("../src/server");
  const { createRun } = require("../src/intake");
  const realFetch = global.fetch;
  let pool, server, base, tmp;
  const PW = "a-long-enough-password";

  const login = async (label, plan = "creator") => {
    const user = await accounts.signup(pool, { email: `${label}-${crypto.randomUUID().slice(0, 6)}@example.com`, password: PW });
    await accounts.markVerified(pool, user.id); await accounts.setPlan(pool, user.id, plan);
    const r = await realFetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: user.email, password: PW }) });
    const cookie = r.headers.getSetCookie()[0].split(";")[0];
    const call = async (method, p, body) => {
      const res = await realFetch(base + p, { method, headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json, text, headers: res.headers };
    };
    return { user, call };
  };
  const give = async (u) => {
    const file = path.join(tmp, `${crypto.randomUUID()}.mp4`); fs.writeFileSync(file, "pretend this is a clip");
    const done = (await createRun(pool, { ownerId: u.id }, { personaId: "truckers", sourceUrl: `https://8.8.8.8/${crypto.randomUUID()}.mp4` })).job;
    await pool.query("update meme_builder_jobs set status = 'done' where id = $1", [done.id]);
    const clip = await store.addClip(pool, done.id, "truckers", 1, { caption: "original caption", score: 7, why: "", transcript: "", emotion: "", startSec: 1, endSec: 5, storageUri: `file://${file}`, bytes: 22 }, null);
    const failed = (await createRun(pool, { ownerId: u.id }, { personaId: "truckers", sourceUrl: `https://8.8.8.8/${crypto.randomUUID()}.mp4` })).job;
    await pool.query("update meme_builder_jobs set status = 'error', error = 'boom' where id = $1", [failed.id]);
    return { done, clip, failed, file };
  };

  before(async () => {
    process.env.MEME_BUILDER_STORAGE_BACKEND = "local";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mb-iso-")); process.env.MEME_BUILDER_STORAGE_ROOT = tmp;
    pool = new Pool({ connectionString: DB, ssl: /\/tmp\/|localhost|127\.0\.0\.1/.test(DB) ? false : { rejectUnauthorized: false } });
    await migrate(pool);
    await pool.query("truncate usage_events, model_usage, api_keys, sessions, users, auth_tokens, meme_builder_clips, meme_builder_jobs, meme_builder_personas cascade");
    await new Promise((r) => { server = http.createServer(buildApp(pool)).listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { server && server.close(); await pool.end(); fs.rmSync(tmp, { recursive: true, force: true }); });

  test("another account gets 'not found' on every route that takes a run or clip id, and nothing of the owner's changes", async () => {
    const a = await login("iso-a"), b = await login("iso-b"); const x = await give(a.user);
    const attempts = [
      ["GET", `/api/jobs/${x.done.id}`], ["POST", `/api/jobs/${x.failed.id}/retry`], ["POST", `/api/jobs/${x.done.id}/recaption`, { personaId: "truckers" }],
      ["DELETE", `/api/jobs/${x.done.id}`], ["PATCH", `/api/clips/${x.clip}`, { caption: "hijacked" }], ["POST", `/api/clips/${x.clip}/regenerate-caption`],
      ["POST", `/api/clips/${x.clip}/rating`, { rating: -1 }], ["DELETE", `/api/clips/${x.clip}`], ["GET", `/api/clips/${x.clip}/video`], ["GET", `/api/clips/${x.clip}/video?download=1`],
    ];
    for (const [m, p, body] of attempts) { const r = await b.call(m, p, body); assert.equal(r.status, 404, `${m} ${p} -> ${r.status} ${r.text.slice(0, 80)}`); assert.ok(!r.text.includes("original caption"), `${m} ${p} leaks nothing`); }
    const clip = (await pool.query("select caption, rating from meme_builder_clips where id = $1", [x.clip])).rows[0];
    assert.equal(clip.caption, "original caption"); assert.equal(clip.rating, 0, "rating untouched (the default)");
    assert.equal((await pool.query("select status from meme_builder_jobs where id = $1", [x.failed.id])).rows[0].status, "error", "not re-queued");
    assert.ok(fs.existsSync(x.file) && (await pool.query("select 1 from meme_builder_jobs where id = $1", [x.done.id])).rowCount === 1, "nothing deleted");
  });

  test("the owner can still do all of it", async () => {
    const a = await login("iso-own"); const x = await give(a.user);
    const job = await a.call("GET", `/api/jobs/${x.done.id}`); assert.equal(job.status, 200); assert.equal(job.json.clips.length, 1);
    assert.equal((await a.call("POST", `/api/clips/${x.clip}/rating`, { rating: 1 })).status, 200);
    const video = await a.call("GET", `/api/clips/${x.clip}/video`); assert.equal(video.status, 200); assert.equal(video.text, "pretend this is a clip");
    assert.equal((await a.call("POST", `/api/jobs/${x.failed.id}/retry`)).status, 200);
    assert.equal((await a.call("DELETE", `/api/clips/${x.clip}`)).status, 200);
    assert.equal((await a.call("DELETE", `/api/jobs/${x.done.id}`)).status, 200);
  });

  test("bad ids are 400, and a missing run or clip is 404, for everyone", async () => {
    const a = await login("iso-ids");
    for (const p of ["/api/jobs/not-a-uuid", "/api/clips/12345/video"]) assert.equal((await a.call("GET", p)).status, 400, p);
    for (const p of [`/api/jobs/${crypto.randomUUID()}`, `/api/clips/${crypto.randomUUID()}/video`]) assert.equal((await a.call("GET", p)).status, 404, p);
  });

  test("a retry needs what a new run needs: minutes left, a free slot and a confirmed email", async () => {
    const a = await login("iso-retry", "free"); const x = await give(a.user);
    await pool.query("insert into usage_events (owner_id, source_seconds, clips) values ($1, $2, 3)", [a.user.id, PLANS.free.monthlyMinutes * 60]);
    const out = await a.call("POST", `/api/jobs/${x.failed.id}/retry`); assert.equal(out.status, 402); assert.equal(out.json.code, "quota_exceeded");
    assert.equal((await pool.query("select status from meme_builder_jobs where id = $1", [x.failed.id])).rows[0].status, "error", "not re-queued");
    // unconfirmed (where email is set up)
    const b = await login("iso-retry2"); const y = await give(b.user); Object.assign(process.env, { EMAIL_PROVIDER: "memory", EMAIL_FROM: "a@b.co" });
    try {
      await pool.query("update users set email_verified_at = null where id = $1", [b.user.id]);
      const r = await b.call("POST", `/api/jobs/${y.failed.id}/retry`); assert.equal(r.status, 403); assert.equal(r.json.code, "email_not_verified");
    } finally { delete process.env.EMAIL_PROVIDER; delete process.env.EMAIL_FROM; }
  });
});
