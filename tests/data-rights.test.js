"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const realFetch = global.fetch;

const DB = process.env.DATABASE_URL_TEST;
describe("download my data and delete my account against a real database", { skip: !DB && "DATABASE_URL_TEST is not set" }, () => {
  const { Pool } = require("pg");
  const accounts = require("../src/accounts");
  const keys = require("../src/lib/keys");
  const store = require("../src/lib/store");
  const storage = require("../src/lib/storage");
  const { migrate } = require("../src/migrate");
  const { buildApp } = require("../src/server");
  const { createRun } = require("../src/intake");
  let pool, server, base, tmp;
  const PW = "a-long-enough-password";
  const email = (l) => `${l}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const exists = async (table, where, params) => (await pool.query(`select count(*)::int n from ${table} where ${where}`, params)).rows[0].n > 0;

  const login = async (label, plan = "free") => {
    const user = await accounts.signup(pool, { email: email(label), password: PW, name: "Sam" });
    await accounts.markVerified(pool, user.id); if (plan !== "free") await accounts.setPlan(pool, user.id, plan);
    let cookie = "";
    const r = await realFetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: user.email, password: PW }) });
    cookie = r.headers.getSetCookie()[0].split(";")[0];
    const call = async (method, p, body) => {
      const res = await realFetch(base + p, { method, headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json, text, headers: res.headers };
    };
    return { user, call };
  };
  // an account with a stored video, a clip with a stored file, an audience, a key, usage and a pack
  const fill = async (u, { plan = "creator" } = {}) => {
    const src = path.join(tmp, `${crypto.randomUUID()}.mp4`), clipFile = path.join(tmp, `${crypto.randomUUID()}.mp4`);
    fs.writeFileSync(src, "source"); fs.writeFileSync(clipFile, "clip");
    const job = (await createRun(pool, { ownerId: u.id }, { personaId: "truckers", sourceUrl: `https://8.8.8.8/${crypto.randomUUID()}.mp4` })).job;
    await pool.query("update meme_builder_jobs set status = 'done', source_uri = $2, source_bytes = 6 where id = $1", [job.id, `file://${src}`]);
    const clipId = await store.addClip(pool, job.id, "truckers", 1, { caption: "When the dock says fifteen minutes", score: 8, why: "", transcript: "", emotion: "", startSec: 1, endSec: 6, storageUri: `file://${clipFile}`, bytes: 4 }, null);
    await pool.query("update meme_builder_clips set rating = 1 where id = $1", [clipId]);
    await store.savePersona(pool, { id: `p-${crypto.randomUUID().slice(0, 6)}`, name: "Nurses", data: { name: "Nurses", summary: "We are nurses." }, ownerId: u.id });
    const key = plan === "free" ? null : await keys.createKey(pool, { ownerId: u.id, name: "K" });
    await pool.query("insert into usage_events (owner_id, source_seconds, clips) values ($1, 600, 5)", [u.id]);
    await pool.query("insert into model_usage (owner_id, provider, model, input_tokens, output_tokens, cost_usd) values ($1, 'google', 'flash', 10, 5, 0.01)", [u.id]);
    await require("../src/billing/packs").grant(pool, u.id, "small", `cs_${crypto.randomUUID()}`);
    return { job, clipId, src, clipFile, key };
  };

  before(async () => {
    process.env.MEME_BUILDER_STORAGE_BACKEND = "local";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mb-rights-")); process.env.MEME_BUILDER_STORAGE_ROOT = tmp;
    pool = new Pool({ connectionString: DB, ssl: /\/tmp\/|localhost|127\.0\.0\.1/.test(DB) ? false : { rejectUnauthorized: false } });
    await migrate(pool);
    await pool.query("truncate usage_events, model_usage, api_keys, sessions, users, stripe_events, meme_builder_clips, meme_builder_jobs, meme_builder_personas cascade");
    await new Promise((r) => { server = http.createServer(buildApp(pool)).listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { global.fetch = realFetch; server && server.close(); await pool.end(); fs.rmSync(tmp, { recursive: true, force: true }); });

  describe("download my data", () => {
    test("everything held about the account, nothing about anyone else, and no secrets", async () => {
      const a = await login("exp-a", "creator"), b = await login("exp-b", "creator");
      const fa = await fill(a.user), fb = await fill(b.user);
      const r = await a.call("GET", "/account/export");
      assert.equal(r.status, 200); assert.match(r.headers.get("content-disposition"), /attachment; filename="my-data\.json"/);
      const d = r.json;
      assert.equal(d.account.email, a.user.email); assert.equal(d.account.plan, "creator");
      assert.equal(d.runs.length, 1); assert.equal(d.runs[0].id, fa.job.id);
      assert.equal(d.clips.length, 1); assert.equal(d.clips[0].caption, "When the dock says fifteen minutes"); assert.equal(d.clips[0].rating, 1);
      assert.equal(d.audiences.length, 1); assert.equal(d.api_keys.length, 1); assert.equal(d.usage.length, 1); assert.equal(d.topup_packs.length, 1);
      assert.ok(!r.text.includes(fb.job.id) && !r.text.includes(b.user.email), "nothing of the other account");
      for (const secret of ["password_hash", "token_hash", "key_hash", "webhook_secret", fa.key.key]) assert.ok(!r.text.includes(secret), `no ${secret}`);
      assert.ok(!r.text.includes("file://"), "no storage paths");
    });
    test("it needs a session, and a locked account can't take the contents (it can still delete)", async () => {
      assert.equal((await realFetch(`${base}/account/export`)).status, 401);
      const c = await login("exp-locked", "creator"); await pool.query("update users set locked_at = now(), plan = 'free' where id = $1", [c.user.id]);
      const r = await c.call("GET", "/account/export"); assert.equal(r.status, 402); assert.equal(r.json.code, "account_locked");
    });
  });

  describe("delete my account", () => {
    test("needs the right password and the word DELETE, and nothing is touched until both are right", async () => {
      const a = await login("del-guard", "creator"); await fill(a.user);
      assert.equal((await a.call("POST", "/account/delete", { password: PW })).json.code, "not_confirmed");
      const bad = await a.call("POST", "/account/delete", { password: "wrong-password-here", confirm: "DELETE" }); assert.equal(bad.status, 403); assert.equal(bad.json.code, "bad_password");
      assert.equal((await realFetch(`${base}/account/delete`, { method: "POST" })).status, 401);
      assert.ok(await exists("users", "id = $1", [a.user.id]));
    });
    test("it removes the account, its runs and stored files, audiences, keys, usage and packs; another account is untouched", async () => {
      const a = await login("del-a", "creator"), b = await login("del-b", "creator");
      const fa = await fill(a.user), fb = await fill(b.user);
      const r = await a.call("POST", "/account/delete", { password: PW, confirm: "DELETE" });
      assert.equal(r.status, 200); assert.equal(r.json.runs, 1); assert.equal(r.json.files, 2); assert.equal(r.json.files_failed, 0);
      assert.match(r.headers.get("set-cookie"), /Max-Age=0/);
      for (const [t, w] of [["users", "id = $1"], ["meme_builder_jobs", "owner_id = $1"], ["meme_builder_personas", "owner_id = $1"], ["api_keys", "owner_id = $1"], ["usage_events", "owner_id = $1"], ["model_usage", "owner_id = $1"], ["credit_packs", "user_id = $1"], ["sessions", "user_id = $1"]]) assert.equal(await exists(t, w, [a.user.id]), false, `${t} emptied`);
      assert.equal(fs.existsSync(fa.src), false, "the stored video is gone"); assert.equal(fs.existsSync(fa.clipFile), false, "the clip file is gone");
      assert.equal((await a.call("GET", "/api/jobs")).status, 401, "the old session no longer works");
      assert.ok(await exists("users", "id = $1", [b.user.id]) && await exists("meme_builder_jobs", "owner_id = $1", [b.user.id]) && fs.existsSync(fb.src) && fs.existsSync(fb.clipFile), "the other account is intact");
      assert.ok(await accounts.signup(pool, { email: a.user.email, password: PW }), "the address can be used again");
    });
    test("it waits for a run in progress", async () => {
      const a = await login("del-busy", "creator");
      await createRun(pool, { ownerId: a.user.id }, { personaId: "truckers", sourceUrl: `https://8.8.8.8/${crypto.randomUUID()}.mp4` });
      const r = await a.call("POST", "/account/delete", { password: PW, confirm: "DELETE" }); assert.equal(r.status, 409); assert.equal(r.json.code, "still_running");
      assert.ok(await exists("users", "id = $1", [a.user.id]));
    });
    test("a locked account can delete itself", async () => {
      const a = await login("del-locked", "creator"); await fill(a.user); await pool.query("update users set locked_at = now(), plan = 'free' where id = $1", [a.user.id]);
      assert.equal((await a.call("POST", "/account/delete", { password: PW, confirm: "DELETE" })).status, 200); assert.equal(await exists("users", "id = $1", [a.user.id]), false);
    });
    test("a live subscription is ended with Stripe first; if that can't be done, nothing is deleted", async () => {
      const a = await login("del-sub", "creator"); await fill(a.user);
      await pool.query("update users set stripe_subscription_id = 'sub_delme', plan_status = 'active', billing_period = 'monthly' where id = $1", [a.user.id]);
      // Stripe off: refuse
      delete process.env.STRIPE_SECRET_KEY;
      let r = await a.call("POST", "/account/delete", { password: PW, confirm: "DELETE" }); assert.equal(r.status, 409); assert.equal(r.json.code, "cannot_cancel"); assert.ok(await exists("users", "id = $1", [a.user.id]));
      // Stripe refuses: nothing deleted
      process.env.STRIPE_SECRET_KEY = "sk_test_x"; const calls = [];
      global.fetch = async (url, init) => { if (!String(url).startsWith("https://api.stripe.com/")) return realFetch(url, init); calls.push(`${init.method} ${url}`); return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "nope" } }) }; };
      r = await a.call("POST", "/account/delete", { password: PW, confirm: "DELETE" }); assert.equal(r.status, 502); assert.ok(await exists("users", "id = $1", [a.user.id]), "still there");
      // Stripe agrees: cancelled immediately, then deleted
      global.fetch = async (url, init) => { if (!String(url).startsWith("https://api.stripe.com/")) return realFetch(url, init); calls.push(`${init.method} ${url}`); return { ok: true, status: 200, text: async () => "{}" }; };
      r = await a.call("POST", "/account/delete", { password: PW, confirm: "DELETE" }); assert.equal(r.status, 200);
      assert.ok(calls.includes("DELETE https://api.stripe.com/v1/subscriptions/sub_delme")); assert.equal(await exists("users", "id = $1", [a.user.id]), false);
      global.fetch = realFetch; delete process.env.STRIPE_SECRET_KEY;
    });
  });
});
