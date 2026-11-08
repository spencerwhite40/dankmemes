"use strict";
// The public API. Unit tests need nothing; the integration tests need a real Postgres (DATABASE_URL_TEST) and are skipped without one.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const express = require("express");

const keys = require("../src/lib/keys");
const accounts = require("../src/accounts");
const { signClip, verifyClip } = require("../src/signing");
const { createLimiter } = require("../src/ratelimit");
const webhooks = require("../src/webhooks");

describe("keys, signing, rate limits, webhooks (no database)", () => {
  test("keys are shaped, hashed, and a wrong shape is never looked up", () => {
    const k = keys.newKey();
    assert.ok(keys.isKeyShaped(k)); assert.ok(!keys.isKeyShaped("nope")); assert.ok(!keys.isKeyShaped(undefined));
    assert.equal(keys.hashKey(k).length, 64); assert.notEqual(keys.hashKey(k), k);
    assert.notEqual(keys.newKey(), keys.newKey());
  });

  test("playback links verify, and expire or tamper-fail", () => {
    const id = crypto.randomUUID(), now = 1_700_000_000_000;
    const { exp, sig } = signClip(id, { ttlSec: 60, now });
    assert.equal(verifyClip(id, exp, sig, now + 1000), true);
    assert.equal(verifyClip(id, exp, sig, now + 61_000), false, "expired");
    assert.equal(verifyClip(crypto.randomUUID(), exp, sig, now), false, "a link for one clip doesn't open another");
    assert.equal(verifyClip(id, exp + 1000, sig, now), false, "extending the expiry breaks the signature");
    assert.equal(verifyClip(id, exp, "0".repeat(64), now), false);
    assert.equal(verifyClip(id, "abc", sig, now), false); assert.equal(verifyClip(id, exp, undefined, now), false);
  });

  test("rate limiter allows the limit, then says when to retry, and recovers", () => {
    const l = createLimiter();
    for (let i = 0; i < 3; i++) assert.equal(l.check("k", 3, 1000 + i).ok, true);
    const blocked = l.check("k", 3, 1500);
    assert.equal(blocked.ok, false); assert.ok(blocked.retryAfterSec >= 1 && blocked.retryAfterSec <= 60);
    assert.equal(l.check("other", 3, 1500).ok, true, "another key is unaffected");
    assert.equal(l.check("k", 3, 62_000).ok, true, "a minute later it recovers");
  });

  test("webhook payload and signature", () => {
    const body = webhooks.buildPayload({ id: "r1", status: "done", error: null, finished_at: "2026-01-01T00:00:00Z" }, 7);
    assert.deepEqual(JSON.parse(body), { event: "run.finished", run: { id: "r1", status: "done", clip_count: 7, error: null, finished_at: "2026-01-01T00:00:00Z" } });
    assert.equal(JSON.parse(webhooks.buildPayload({ id: "r2", status: "error", error: "boom" }, 0)).event, "run.failed");
    const sig = webhooks.sign("secret", body);
    assert.equal(sig, `sha256=${crypto.createHmac("sha256", "secret").update(body).digest("hex")}`);
    assert.notEqual(webhooks.sign("other", body), sig);
  });
});

const DB = process.env.DATABASE_URL_TEST;
describe("the API against a real database", { skip: !DB && "DATABASE_URL_TEST is not set" }, () => {
  const { Pool } = require("pg");
  const store = require("../src/lib/store");
  const storage = require("../src/lib/storage");
  const { migrate } = require("../src/migrate");
  const { buildV1 } = require("../src/v1");
  const { afterRun } = require("../src/hooks");
  let pool, server, base, tmp, A, B;
  const U = {};   // owner label -> real user id
  const mkUser = async (label, plan = "creator") => { const u = await accounts.signup(pool, { email: `${label}-${crypto.randomUUID().slice(0, 6)}@example.com`, password: "a-long-enough-password" }); await accounts.setPlan(pool, u.id, plan); U[label] = u.id; return u; };
  const settle = () => pool.query("update meme_builder_jobs set status = 'done' where status in ('queued', 'running')");
  const call = async (method, p, { key, body, headers } = {}) => {
    const res = await fetch(base + p, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, headers: res.headers, text };
  };

  before(async () => {
    process.env.MEME_BUILDER_STORAGE_BACKEND = "local";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mb-v1-")); process.env.MEME_BUILDER_STORAGE_ROOT = tmp;
    pool = new Pool({ connectionString: DB, ssl: /\/tmp\/|localhost|127\.0\.0\.1/.test(DB) ? false : { rejectUnauthorized: false } });
    await migrate(pool);
    await pool.query("truncate usage_events, model_usage, api_keys, sessions, users, meme_builder_clips, meme_builder_jobs, meme_builder_personas cascade");
    const app = express(); app.use(express.json());
    app.use("/v1", buildV1(pool, { baseUrl: "" }));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    await new Promise((r) => { server = http.createServer(app).listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
    await mkUser("acme"); await mkUser("globex");
    A = await keys.createKey(pool, { ownerId: U.acme, name: "A" });
    B = await keys.createKey(pool, { ownerId: U.globex, name: "B" });
  });
  after(async () => { server && server.close(); await pool.end(); fs.rmSync(tmp, { recursive: true, force: true }); });

  test("no key, a bad key and a revoked key are all refused", async () => {
    assert.equal((await call("GET", "/v1/runs")).status, 401);
    assert.equal((await call("GET", "/v1/runs", { key: "mk_live_" + "x".repeat(30) })).status, 401);
    const extra = await keys.createKey(pool, { ownerId: U.acme, name: "temp" });
    assert.equal((await call("GET", "/v1/runs", { key: extra.key })).status, 200);
    assert.equal(await keys.revokeKey(pool, extra.record.id, U.globex), false, "another account cannot revoke it");
    await keys.revokeKey(pool, extra.record.id, U.acme);
    const after = await call("GET", "/v1/runs", { key: extra.key });
    assert.equal(after.status, 401); assert.equal(after.json.code, "bad_key");
  });

  test("starting a run: needs a video; a private webhook is refused; a repeated Idempotency-Key returns the same run", async () => {
    assert.equal((await call("POST", "/v1/runs", { key: A.key, body: { audience: "truckers" } })).json.code, "no_video");
    assert.equal((await call("POST", "/v1/runs", { key: A.key, body: { audience: "nope", source_url: "https://8.8.8.8/a.mp4" } })).json.code, "bad_audience");
    const priv = await call("POST", "/v1/runs", { key: A.key, body: { audience: "truckers", source_url: "https://8.8.8.8/a.mp4", webhook_url: "http://127.0.0.1:9/hook" } });
    assert.equal(priv.status, 400); assert.equal(priv.json.code, "bad_webhook");
    const first = await call("POST", "/v1/runs", { key: A.key, headers: { "Idempotency-Key": "abc-1" }, body: { audience: "truckers", source_url: "https://8.8.8.8/a.mp4" } });
    assert.equal(first.status, 202); assert.equal(first.json.run.status, "queued");
    const again = await call("POST", "/v1/runs", { key: A.key, headers: { "Idempotency-Key": "abc-1" }, body: { audience: "truckers", source_url: "https://8.8.8.8/a.mp4" } });
    assert.equal(again.status, 200); assert.equal(again.json.run.id, first.json.run.id, "no second run");
    const other = await call("POST", "/v1/runs", { key: B.key, headers: { "Idempotency-Key": "abc-1" }, body: { audience: "truckers", source_url: "https://8.8.8.8/b.mp4" } });
    assert.notEqual(other.json.run.id, first.json.run.id, "the same key text from another customer is a different run");
  });

  test("customers are isolated: runs, clips, audiences, ratings and the web page's lists", async () => {
    await settle();
    const run = (await call("POST", "/v1/runs", { key: A.key, body: { audience: "truckers", source_url: "https://8.8.8.8/iso.mp4" } })).json.run;
    const src = path.join(tmp, "c.mp4"); fs.writeFileSync(src, Buffer.alloc(5000, 7));
    const uri = await storage.putFile(src, `${run.id}/c.mp4`, "video/mp4");
    const clip = { id: await store.addClip(pool, run.id, "truckers", 1, { caption: "A's secret caption", score: 8, startSec: 1, endSec: 9, storageUri: uri }) };
    // A sees it
    const seen = await call("GET", `/v1/runs/${run.id}`, { key: A.key });
    assert.equal(seen.status, 200); assert.equal(seen.json.clips.length, 1); assert.equal(seen.json.clips[0].caption, "A's secret caption");
    // B does not: 404 on the run, the clip, every action on it, and it is absent from B's lists
    for (const [m, p, body] of [["GET", `/v1/runs/${run.id}`], ["POST", `/v1/runs/${run.id}/rerun`, {}], ["GET", `/v1/clips/${clip.id}`], ["POST", `/v1/clips/${clip.id}/rating`, { rating: 1 }], ["POST", `/v1/clips/${clip.id}/regenerate-caption`, {}], ["DELETE", `/v1/clips/${clip.id}`]]) {
      const r = await call(m, p, { key: B.key, body });
      assert.equal(r.status, 404, `${m} ${p} must be 404 for another customer (got ${r.status})`);
    }
    assert.ok(!JSON.stringify((await call("GET", "/v1/runs", { key: B.key })).json).includes(run.id), "B's list has no A runs");
    assert.ok(!JSON.stringify((await call("GET", "/v1/videos", { key: B.key })).json).includes("iso.mp4"));
    assert.equal((await call("GET", `/v1/clips/${clip.id}`, { key: A.key })).status, 200, "and A's clip is still there");
    // the web page's lists (owner "default") never include API customers
    assert.ok(!(await store.listJobs(pool, { ownerId: U.globex })).some((j) => j.id === run.id));
    assert.ok(!(await store.listLibrary(pool, { ownerId: U.globex })).some((c) => c.id === clip.id));
    // ratings from A never shape B's captions
    await call("POST", `/v1/clips/${clip.id}/rating`, { key: A.key, body: { rating: 1 } });
    assert.equal((await store.ratedClips(pool, "truckers", U["acme"])).length, 1);
    assert.equal((await store.ratedClips(pool, "truckers", U["globex"])).length, 0);
    assert.equal((await store.ratedClips(pool, "truckers", "default")).length, 0);
  });

  test("custom audiences are private, and one customer can't overwrite another's", async () => {
    await store.savePersona(pool, { id: "acme-nurses", name: "Nurses", data: { name: "Nurses", summary: "We are nurses." }, ownerId: U.acme });
    const a = (await call("GET", "/v1/audiences", { key: A.key })).json.audiences.map((x) => x.id);
    const b = (await call("GET", "/v1/audiences", { key: B.key })).json.audiences.map((x) => x.id);
    assert.ok(a.includes("acme-nurses") && a.includes("truckers"));
    assert.ok(!b.includes("acme-nurses") && b.includes("truckers"), "B sees the built-in audience but not A's");
    assert.equal((await call("POST", "/v1/runs", { key: B.key, body: { audience: "acme-nurses", source_url: "https://8.8.8.8/x.mp4" } })).json.code, "bad_audience");
    await assert.rejects(() => store.savePersona(pool, { id: "acme-nurses", name: "Hijack", data: { name: "Hijack", summary: "x" }, ownerId: U["globex"] }), /already exists/);
    assert.equal((await store.getPersona(pool, "acme-nurses", U.acme)).name, "Nurses", "unchanged");
  });

  test("playback links stream the clip with Range support; a tampered or expired link is refused", async () => {
    await settle();
    const run = (await call("POST", "/v1/runs", { key: A.key, body: { audience: "truckers", source_url: "https://8.8.8.8/play.mp4" } })).json.run;
    const src = path.join(tmp, "p.mp4"); fs.writeFileSync(src, Buffer.from("0123456789".repeat(100)));
    const uri = await storage.putFile(src, `${run.id}/p.mp4`, "video/mp4");
    await store.addClip(pool, run.id, "truckers", 1, { caption: "playable", score: 8, startSec: 1, endSec: 9, storageUri: uri });
    const link = (await call("GET", `/v1/runs/${run.id}`, { key: A.key })).json.clips[0].video_url;
    const full = await call("GET", link);
    assert.equal(full.status, 200); assert.equal(full.text.length, 1000);
    const part = await fetch(base + link, { headers: { Range: "bytes=10-19" } });
    assert.equal(part.status, 206); assert.equal(await part.text(), "0123456789"); assert.match(part.headers.get("content-range"), /^bytes 10-19\/1000$/);
    assert.equal((await call("GET", link.replace(/sig=[0-9a-f]{4}/, "sig=ffff"))).status, 403, "tampered");
    const old = signClip(link.split("/")[3], { ttlSec: -10 });
    assert.equal((await call("GET", `/v1/clips/${link.split("/")[3]}/video?exp=${old.exp}&sig=${old.sig}`)).status, 403, "expired");
    assert.equal((await call("GET", `/v1/clips/${link.split("/")[3]}/video`)).status, 403, "no signature");
  });

  test("monthly quota, usage, and the rate limit", async () => {
    await mkUser("quota-co");
    const q = await keys.createKey(pool, { ownerId: U["quota-co"], name: "Q", monthlyMinutesQuota: 1 });
    assert.equal((await call("GET", "/v1/usage", { key: q.key })).json.minutes_remaining, 1);
    await pool.query("insert into usage_events (owner_id, source_seconds, clips) values ($1, 120, 5)", [U["quota-co"]]);
    const usage = (await call("GET", "/v1/usage", { key: q.key })).json;
    assert.equal(usage.minutes_processed, 2); assert.equal(usage.minutes_remaining, 0); assert.equal(usage.clips, 5);
    const blocked = await call("POST", "/v1/runs", { key: q.key, body: { audience: "truckers", source_url: "https://8.8.8.8/q.mp4" } });
    assert.equal(blocked.status, 402); assert.equal(blocked.json.code, "quota_exceeded");
    await mkUser("slow-co");
    const slow = await keys.createKey(pool, { ownerId: U["slow-co"], name: "S", rateLimitPerMin: 3 });
    for (let i = 0; i < 3; i++) assert.equal((await call("GET", "/v1/runs", { key: slow.key })).status, 200);
    const limited = await call("GET", "/v1/runs", { key: slow.key });
    assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  });

  test("finishing a run records its usage once and sends a signed webhook", async () => {
    const hits = [];
    const hook = http.createServer((req, res) => { let b = ""; req.on("data", (d) => { b += d; }); req.on("end", () => { hits.push({ sig: req.headers["x-meme-signature"], body: b }); res.end("ok"); }); });
    await new Promise((r) => hook.listen(0, r));
    await mkUser("hooked");
    const k = await keys.createKey(pool, { ownerId: U["hooked"], name: "H" });
    // the webhook target is a loopback server, which a real request would refuse, so deliver with the SSRF check stubbed out
    const media = require("../src/lib/media"); const real = media.assertPublicUrl; media.assertPublicUrl = async () => {};
    try {
      const job = await store.createJob(pool, { ownerId: U["hooked"], apiKeyId: k.record.id, personaId: "truckers", sourceKind: "url", sourceLabel: "h.mp4", sourceUrl: "https://8.8.8.8/h.mp4", options: { webhookUrl: `http://127.0.0.1:${hook.address().port}/hook` }, videoMeta: { duration: 300 } });
      await store.claimNextJob(pool); await store.finishJob(pool, job.id);
      await afterRun(pool, job.id, { log: { error() {} } });
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(hits.length, 1);
      assert.equal(hits[0].sig, webhooks.sign(k.webhook_secret, hits[0].body), "signed with the key's webhook secret");
      assert.equal(JSON.parse(hits[0].body).run.id, job.id);
      const used = await keys.monthUsage(pool, U["hooked"]);
      assert.equal(used.minutes, 5); assert.equal(used.runs, 1);
    } finally { media.assertPublicUrl = real; hook.close(); }
  });
});
