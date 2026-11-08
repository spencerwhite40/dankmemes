"use strict";
// Accounts, sessions, plans and what each plan limits. Unit tests need nothing; the rest need a real Postgres (DATABASE_URL_TEST).
const { test, describe, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const accounts = require("../src/accounts");
const { PLANS, getPlan, planNames, GB } = require("../src/plans");
const ai = require("../src/lib/ai");
const { tasteFromRatings } = require("../src/lib/personas");

describe("plans and passwords (no database)", () => {
  test("every plan defines every limit, and bigger plans never allow less", () => {
    const fields = ["monthlyMinutes", "maxVideoMinutes", "maxUploadMb", "storageGb", "retentionDays", "concurrentRuns", "ratePerMin", "tasteExamples", "clipsPerRun"];
    for (const n of planNames()) for (const f of fields) assert.ok(Number.isFinite(PLANS[n][f]) && PLANS[n][f] > 0, `${n}.${f}`);
    const order = ["free", "creator", "pro", "agency"];
    for (let i = 1; i < order.length; i++) for (const f of fields) assert.ok(PLANS[order[i]][f] >= PLANS[order[i - 1]][f], `${order[i]}.${f} is not below ${order[i - 1]}`);
    assert.equal(PLANS.free.apiAccess, false); assert.equal(PLANS.creator.apiAccess, true);
    assert.equal(PLANS.free.models, "standard"); assert.equal(PLANS.pro.models, "premium");
  });
  test("prices: no paid plan sells a minute below the floor, annual is a slight discount, and bigger plans never cost more per minute", () => {
    const FLOOR = 0.15;   // dollars per minute, month-to-month
    const paid = ["creator", "pro", "agency"];
    assert.equal(PLANS.free.priceMonthly, 0); assert.equal(PLANS.free.priceAnnual, 0);
    let previous = Infinity;
    for (const n of paid) {
      const p = PLANS[n], perMinute = p.priceMonthly / p.monthlyMinutes;
      assert.ok(perMinute >= FLOOR - 1e-9, `${n} monthly is ${perMinute.toFixed(3)} a minute`);
      assert.ok(perMinute <= previous + 1e-9, `${n} is not dearer per minute than a smaller plan`);
      previous = perMinute;
      const off = 1 - p.priceAnnual / p.priceMonthly;
      assert.ok(off > 0.1 && off <= 0.2, `${n} annual discount is ${(off * 100).toFixed(1)}%`);
    }
    assert.equal(PLANS.creator.priceMonthly, 30); assert.equal(PLANS.creator.monthlyMinutes, 200);
  });
  test("an unknown plan name falls back to free, never to unlimited", () => {
    assert.equal(getPlan("nope").name, "free"); assert.equal(getPlan(undefined).maxUploadMb, PLANS.free.maxUploadMb);
  });
  test("passwords are salted scrypt hashes that verify only the right password", async () => {
    const a = await accounts.hashPassword("correct horse battery"), b = await accounts.hashPassword("correct horse battery");
    assert.match(a, /^scrypt\$16384\$8\$1\$/); assert.notEqual(a, b, "a different salt each time");
    assert.equal(await accounts.verifyPassword("correct horse battery", a), true);
    assert.equal(await accounts.verifyPassword("correct horse batterY", a), false);
    assert.equal(await accounts.verifyPassword("x", "garbage"), false); assert.equal(await accounts.verifyPassword("x", undefined), false);
  });
  test("a bigger plan lets more of the account's own ratings teach its captions", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ caption: `liked ${i}`, transcript: "t", rating: 1 }));
    const count = (txt) => (txt.match(/^- "liked/gm) || []).length;
    assert.equal(count(tasteFromRatings(rows, { limit: PLANS.free.tasteExamples })), PLANS.free.tasteExamples);
    assert.equal(count(tasteFromRatings(rows, { limit: PLANS.pro.tasteExamples })), PLANS.pro.tasteExamples);
    assert.equal(count(tasteFromRatings(rows)), 15, "the default is unchanged");
    assert.ok(tasteFromRatings(rows, { limit: 3 }).includes("liked 39") && !tasteFromRatings(rows, { limit: 3 }).includes("liked 10"), "the most recent ones are kept");
  });
  test("the standard tier gets the cheaper models, the premium tier the best first", async () => {
    const ledger = ai.ledger; const realFetch = global.fetch; const keep = {};
    for (const k of ["GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "KIE_API_KEY", "MEME_BUILDER_TEXT_MODELS"]) { keep[k] = process.env[k]; delete process.env[k]; }
    process.env.GOOGLE_API_KEY = "g"; process.env.ANTHROPIC_API_KEY = "a";
    const firstModel = async (tier) => {
      ai.resetModelHealth(); let first = null;
      global.fetch = async (url, init) => { first = first || `${String(url).includes("anthropic") ? "anthropic" : "google"}:${JSON.parse(init.body).model || String(url).split("/models/")[1].split(":")[0]}`; return { status: 200, ok: true, headers: new Map(), text: async () => JSON.stringify(String(url).includes("anthropic") ? { content: [{ type: "text", text: "ok" }], usage: {} } : { candidates: [{ content: { parts: [{ text: "ok" }] } }] }) }; };
      await ledger.runWithContext({ ownerId: "o", tier }, () => ai.chat({ messages: [{ role: "user", content: "x" }] }));
      return first;
    };
    try {
      assert.equal(await firstModel("premium"), "anthropic:claude-fable-5-1");
      const lean = await firstModel("standard");
      assert.notEqual(lean, "anthropic:claude-fable-5-1"); assert.ok(!ai.models.isPremium(lean.replace(/^[a-z]+:/, lean.split(":")[0] + ":")), "a standard account never starts on a premium model");
      assert.deepEqual(ai.models.standardOnly(["anthropic:claude-fable-5-1", "google:gemini-3.1-pro", "openai:gpt-5.2"]), ["openai:gpt-5.2"]);
      assert.deepEqual(ai.models.standardOnly(["anthropic:claude-fable-5-1"]), ["anthropic:claude-fable-5-1"], "if nothing else is available, the premium model still works");
    } finally { global.fetch = realFetch; for (const k of Object.keys(keep)) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } ai.resetModelHealth(); }
  });
});

const DB = process.env.DATABASE_URL_TEST;
describe("accounts against a real database", { skip: !DB && "DATABASE_URL_TEST is not set" }, () => {
  const { Pool } = require("pg");
  const store = require("../src/lib/store");
  const storage = require("../src/lib/storage");
  const keys = require("../src/lib/keys");
  const { migrate } = require("../src/migrate");
  const { buildApp } = require("../src/server");
  const { createRun } = require("../src/intake");
  const { sweep } = require("../src/retention");
  const { deleteRun } = require("../src/clips");
  const { processJob } = require("../src/lib/pipeline");
  let pool, server, base, tmp;
  const email = (l) => `${l}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const PW = "a-long-enough-password";
  const mk = async (label, plan = "free") => { const u = await accounts.signup(pool, { email: email(label), password: PW }); if (plan !== "free") await accounts.setPlan(pool, u.id, plan); return u; };
  const settle = (ownerId) => pool.query("update meme_builder_jobs set status = 'done' where owner_id = $1 and status in ('queued','running')", [ownerId]);

  // a tiny cookie-keeping HTTP client
  const client = () => {
    let cookie = "";
    const call = async (method, p, body) => {
      const res = await fetch(base + p, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      if (set.length) { const c = set[0].split(";")[0]; cookie = c.endsWith("=") ? "" : c; }
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json, headers: res.headers, setCookie: set[0] || "" };
    };
    return { call, hasCookie: () => !!cookie };
  };

  before(async () => {
    process.env.MEME_BUILDER_STORAGE_BACKEND = "local";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mb-acc-")); process.env.MEME_BUILDER_STORAGE_ROOT = tmp;
    pool = new Pool({ connectionString: DB, ssl: /\/tmp\/|localhost|127\.0\.0\.1/.test(DB) ? false : { rejectUnauthorized: false } });
    await migrate(pool);
    await pool.query("truncate usage_events, model_usage, api_keys, sessions, users, meme_builder_clips, meme_builder_jobs, meme_builder_personas cascade");
    await new Promise((r) => { server = http.createServer(buildApp(pool)).listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { server && server.close(); await pool.end(); fs.rmSync(tmp, { recursive: true, force: true }); });

  describe("sign-up, sign-in and sessions", () => {
    test("sign-up validates, is case-insensitive about email, and refuses a second account for the same email", async () => {
      await assert.rejects(() => accounts.signup(pool, { email: "nope", password: PW }), { code: "bad_email" });
      await assert.rejects(() => accounts.signup(pool, { email: email("x"), password: "short" }), { code: "weak_password" });
      const e = email("dup");
      const u = await accounts.signup(pool, { email: e.toUpperCase(), password: PW });
      assert.equal(u.email, e, "stored lower-case"); assert.equal(u.plan, "free"); assert.equal(u.is_admin, false);
      await assert.rejects(() => accounts.signup(pool, { email: e, password: PW }), { code: "email_taken" });
    });
    test("sign-ups can be closed, and ADMIN_EMAILS makes an admin", async () => {
      process.env.SIGNUPS = "closed";
      try { await assert.rejects(() => accounts.signup(pool, { email: email("c"), password: PW }), { code: "signups_closed" }); } finally { delete process.env.SIGNUPS; }
      const boss = email("boss"); process.env.ADMIN_EMAILS = `other@x.com, ${boss}`;
      try { assert.equal((await accounts.signup(pool, { email: boss, password: PW })).is_admin, true); } finally { delete process.env.ADMIN_EMAILS; }
    });
    test("only the right password signs in; a session works, expires, and can be ended; a password change signs out everywhere", async () => {
      const u = await mk("sess");
      assert.equal(await accounts.authenticate(pool, u.email, "wrong-password-here"), null);
      assert.equal(await accounts.authenticate(pool, "nobody@example.com", PW), null);
      const user = await accounts.authenticate(pool, u.email.toUpperCase(), PW); assert.equal(user.id, u.id);
      const token = await accounts.createSession(pool, u.id, "test");
      assert.equal((await accounts.userForSession(pool, token)).id, u.id);
      assert.equal(await accounts.userForSession(pool, token + "x"), null, "a wrong token is nobody");
      const stored = (await pool.query("select token_hash from sessions where user_id = $1", [u.id])).rows[0].token_hash;
      assert.notEqual(stored, token); assert.equal(stored.length, 64, "only a hash is stored");
      await pool.query("update sessions set expires_at = now() - interval '1 minute' where user_id = $1", [u.id]);
      assert.equal(await accounts.userForSession(pool, token), null, "expired");
      const t2 = await accounts.createSession(pool, u.id), t3 = await accounts.createSession(pool, u.id);
      await accounts.endSession(pool, t2); assert.equal(await accounts.userForSession(pool, t2), null);
      assert.ok(await accounts.userForSession(pool, t3));
      await accounts.setPassword(pool, u.id, "a-brand-new-password");
      assert.equal(await accounts.userForSession(pool, t3), null, "changing the password signs out every device");
      assert.ok(await accounts.authenticate(pool, u.email, "a-brand-new-password"));
    });
    test("over HTTP: sign-up sets an HttpOnly cookie, /api/me shows the plan and limits, logout ends the session", async () => {
      const c = client(); const e = email("web");
      assert.equal((await c.call("GET", "/api/me")).json.signedIn, false);
      assert.equal((await c.call("GET", "/api/jobs")).status, 401, "the page's routes need a session");
      const up = await c.call("POST", "/auth/signup", { email: e, password: PW, name: "Web" });
      assert.equal(up.status, 201); assert.match(up.setCookie, /mb_session=/); assert.match(up.setCookie, /HttpOnly/); assert.match(up.setCookie, /SameSite=Lax/);
      assert.equal(up.json.user.email, e); assert.ok(!JSON.stringify(up.json).includes("password"));
      const me = (await c.call("GET", "/api/me")).json;
      assert.equal(me.signedIn, true); assert.equal(me.plan.name, "free"); assert.equal(me.limits.monthly_minutes, PLANS.free.monthlyMinutes);
      assert.equal(me.usage.storage_bytes, 0); assert.equal(me.limits.api_access, false);
      assert.equal((await c.call("GET", "/api/jobs")).status, 200);
      await c.call("POST", "/auth/logout");
      assert.equal(c.hasCookie(), false); assert.equal((await c.call("GET", "/api/jobs")).status, 401);
    });
    test("password guessing is slowed: the 9th wrong attempt for one email is refused with a wait time", async () => {
      const u = await mk("guess"); const c = client(); let last;
      for (let i = 0; i < 8; i++) { last = await c.call("POST", "/auth/login", { email: u.email, password: "wrong-password-" + i }); assert.equal(last.status, 401); }
      last = await c.call("POST", "/auth/login", { email: u.email, password: PW });
      assert.equal(last.status, 429, "even the right password waits once the limit is hit"); assert.ok(Number(last.headers.get("retry-after")) >= 1);
      const other = await client().call("POST", "/auth/login", { email: (await mk("fine")).email, password: PW });
      assert.equal(other.status, 200, "another email is unaffected");
    });
  });

  describe("every account only ever sees its own things", () => {
    test("runs: A's run is not in B's list, B cannot delete it, A can; deleting frees the storage", async () => {
      const A = client(), B = client();
      await A.call("POST", "/auth/signup", { email: email("a"), password: PW }); await B.call("POST", "/auth/signup", { email: email("b"), password: PW });
      const made = await A.call("POST", "/api/jobs", { personaId: "truckers", sourceUrl: "https://8.8.8.8/mine.mp4" });
      assert.equal(made.status, 201); const id = made.json.job.id;
      assert.ok((await A.call("GET", "/api/jobs")).json.jobs.some((j) => j.id === id));
      assert.ok(!(await B.call("GET", "/api/jobs")).json.jobs.some((j) => j.id === id));
      const meId = (await A.call("GET", "/api/me")).json.user.id;
      assert.equal((await A.call("DELETE", `/api/jobs/${id}`)).status, 409, "a run in progress can't be deleted");
      await settle(meId);
      assert.equal((await B.call("DELETE", `/api/jobs/${id}`)).status, 404, "someone else's run is not found");
      // give it a stored video and a clip so there is something to free
      const src = path.join(tmp, "s.mp4"); fs.writeFileSync(src, Buffer.alloc(4000, 1));
      const srcUri = await storage.putFile(src, `${id}/s.mp4`, "video/mp4");
      await pool.query("update meme_builder_jobs set source_uri = $2, source_bytes = 4000 where id = $1", [id, srcUri]);
      const clipUri = await storage.putFile(src, `${id}/c.mp4`, "video/mp4");
      await store.addClip(pool, id, "truckers", 1, { caption: "c", score: 5, startSec: 1, endSec: 5, storageUri: clipUri, bytes: 4000 });
      assert.equal(await accounts.storageBytes(pool, meId), 8000, "source + clip are counted");
      assert.equal((await A.call("DELETE", `/api/jobs/${id}`)).status, 200);
      assert.equal(await accounts.storageBytes(pool, meId), 0, "and freed");
      assert.ok(!fs.existsSync(clipUri.replace("file://", "")) && !fs.existsSync(srcUri.replace("file://", "")), "the files are gone");
    });
    test("custom audiences and ratings are per account", async () => {
      const a = await mk("rate-a", "creator"), b = await mk("rate-b", "creator");
      await store.savePersona(pool, { id: "nurses-a", name: "Nurses", data: { name: "Nurses", summary: "s" }, ownerId: a.id });
      assert.ok((await store.listPersonas(pool, a.id)).some((p) => p.id === "nurses-a"));
      assert.ok(!(await store.listPersonas(pool, b.id)).some((p) => p.id === "nurses-a"));
      const { job } = await createRun(pool, { ownerId: a.id }, { personaId: "truckers", sourceUrl: "https://8.8.8.8/r.mp4" });
      const cid = await store.addClip(pool, job.id, "truckers", 1, { caption: "A's liked caption", score: 5, startSec: 1, endSec: 5, storageUri: "file:///x" });
      await store.setRating(pool, cid, 1);
      assert.equal((await store.ratedClips(pool, "truckers", a.id)).length, 1);
      assert.equal((await store.ratedClips(pool, "truckers", b.id)).length, 0, "B's captions are not shaped by A's taste");
    });
  });

  describe("what each plan limits", () => {
    test("monthly minutes: a plan that has used them all can't start another run, and the message says what to do", async () => {
      const u = await mk("mins");
      await pool.query("insert into usage_events (owner_id, source_seconds, clips) values ($1, $2, 3)", [u.id, PLANS.free.monthlyMinutes * 60]);
      await assert.rejects(() => accounts.assertCanStart(pool, u.id), (e) => e.status === 402 && e.code === "quota_exceeded" && /bigger plan/.test(e.message));
      const up = await mk("mins-up", "creator");
      await pool.query("insert into usage_events (owner_id, source_seconds, clips) values ($1, $2, 3)", [up.id, PLANS.free.monthlyMinutes * 60]);
      assert.ok(await accounts.assertCanStart(pool, up.id), "the same usage is nothing on a bigger plan");
    });
    test("runs at once: the free plan runs one video at a time", async () => {
      const u = await mk("conc");
      await createRun(pool, { ownerId: u.id }, { personaId: "truckers", sourceUrl: "https://8.8.8.8/one.mp4" });
      await assert.rejects(() => createRun(pool, { ownerId: u.id }, { personaId: "truckers", sourceUrl: "https://8.8.8.8/two.mp4" }), (e) => e.status === 429 && e.code === "too_many_runs");
      await settle(u.id);
      assert.ok((await createRun(pool, { ownerId: u.id }, { personaId: "truckers", sourceUrl: "https://8.8.8.8/two.mp4" })).job, "free again once the first finished");
    });
    test("upload size and storage: an oversized file or a full account is refused", async () => {
      const u = await mk("size");
      await assert.rejects(() => accounts.assertCanStart(pool, u.id, { fileBytes: (PLANS.free.maxUploadMb + 1) * 1024 * 1024 }), { code: "file_too_large", status: 413 });
      assert.ok(await accounts.assertCanStart(pool, u.id, { fileBytes: 10 * 1024 * 1024 }));
      await pool.query("insert into meme_builder_jobs (owner_id, persona_id, source_kind, source_label, status, source_bytes) values ($1, 'truckers', 'upload', 'big', 'done', $2)", [u.id, PLANS.free.storageGb * GB - 100]);
      await assert.rejects(() => accounts.assertCanStart(pool, u.id, { fileBytes: 1000 }), (e) => e.code === "storage_full" && /Delete old runs/.test(e.message));
    });
    test("minutes do not roll over: last month's usage doesn't count this month, and nothing carries forward", async () => {
      const u = await mk("rollover", "creator");
      await pool.query("insert into usage_events (owner_id, source_seconds, clips, created_at) values ($1, $2, 3, date_trunc('month', now() at time zone 'utc') at time zone 'utc' - interval '1 day')", [u.id, PLANS.creator.monthlyMinutes * 60]);
      let snap = await accounts.usageSnapshot(pool, u.id);
      assert.equal(snap.usage.minutes, 0, "a full month last month leaves nothing used this month");
      assert.equal(snap.limits.monthly_minutes, PLANS.creator.monthlyMinutes, "and nothing extra either, even if last month's minutes were never used");
      await pool.query("insert into usage_events (owner_id, source_seconds, clips) values ($1, $2, 3)", [u.id, PLANS.creator.monthlyMinutes * 60]);
      await assert.rejects(() => accounts.assertCanStart(pool, u.id), { code: "quota_exceeded", status: 402 });
    });
    test("a finished run is billed in whole minutes, rounded up", async () => {
      const u = await mk("whole-min", "creator");
      const job = (await createRun(pool, { ownerId: u.id }, { personaId: "truckers", sourceUrl: "https://8.8.8.8/w.mp4" })).job;
      await require("../src/lib/keys").recordUsage(pool, { ...job, video_meta: { duration: 61 } }, 4);
      assert.equal((await accounts.usageSnapshot(pool, u.id)).usage.minutes, 2, "61 seconds is 2 minutes");
    });
    test("clips per run are capped by the plan, whatever was asked for", async () => {
      const f = await mk("cap-f"), p = await mk("cap-p", "pro");
      const a = (await createRun(pool, { ownerId: f.id }, { personaId: "truckers", sourceUrl: "https://8.8.8.8/a.mp4", options: { maxClips: 60 } })).job;
      const b = (await createRun(pool, { ownerId: p.id }, { personaId: "truckers", sourceUrl: "https://8.8.8.8/b.mp4", options: { maxClips: 60 } })).job;
      assert.equal(a.options.maxClips, PLANS.free.clipsPerRun); assert.equal(b.options.maxClips, 60);
      assert.equal((await createRun(pool, { ownerId: (await mk("cap-d", "creator")).id }, { personaId: "truckers", sourceUrl: "https://8.8.8.8/c.mp4" })).job.options.maxClips, PLANS.creator.clipsPerRun, "unspecified means the plan's maximum");
    });
    test("video length: a video longer than the plan allows fails with a message that says so", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-len-")); const src = path.join(dir, "v.mp4");
      const media = require("../src/lib/media");
      try { await media.runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=4", "-f", "lavfi", "-i", "sine=duration=4", "-c:v", "libx264", "-shortest", src]); } catch { fs.rmSync(dir, { recursive: true, force: true }); return; }
      const u = await mk("len");
      const uri = await storage.putFile(src, `len/source.mp4`, "video/mp4");
      const job = await store.createJob(pool, { ownerId: u.id, personaId: "truckers", sourceKind: "upload", sourceLabel: "v.mp4", sourceUri: uri });
      const tiny = { ...getPlan("free"), maxVideoMinutes: 2 / 60 };   // two seconds
      await assert.rejects(() => processJob(pool, job, { log: { log() {}, warn() {}, error() {} }, plan: tiny }), /4 minutes long|0 minutes long|The Free plan allows up to/);
      fs.rmSync(dir, { recursive: true, force: true });
    });
    test("API access belongs to paid plans: a free account can't make a key, and a key whose owner is on a free plan is refused", async () => {
      const c = client(); const e = email("api");
      await c.call("POST", "/auth/signup", { email: e, password: PW });
      const denied = await c.call("POST", "/account/keys", { name: "mine" });
      assert.equal(denied.status, 403); assert.equal(denied.json.code, "api_not_in_plan");
      const me = (await c.call("GET", "/api/me")).json.user;
      await accounts.setPlan(pool, me.id, "creator");
      const made = await c.call("POST", "/account/keys", { name: "mine" });
      assert.equal(made.status, 201); assert.match(made.json.key, /^mk_live_/); assert.ok(made.json.webhook_secret);
      assert.equal((await fetch(`${base}/v1/runs`, { headers: { Authorization: `Bearer ${made.json.key}` } })).status, 200);
      const listed = (await c.call("GET", "/account/keys")).json.keys;
      assert.equal(listed.length, 1); assert.ok(!JSON.stringify(listed).includes(made.json.key), "the key itself is never listed again");
      // downgraded: the key stops working
      await accounts.setPlan(pool, me.id, "free");
      assert.equal((await fetch(`${base}/v1/runs`, { headers: { Authorization: `Bearer ${made.json.key}` } })).status, 403);
    });
    test("keys are private to their account: another account can't list or revoke them, and a revoked key stops working", async () => {
      const A = client(), B = client();
      await A.call("POST", "/auth/signup", { email: email("ka"), password: PW }); await B.call("POST", "/auth/signup", { email: email("kb"), password: PW });
      await accounts.setPlan(pool, (await A.call("GET", "/api/me")).json.user.id, "creator"); await accounts.setPlan(pool, (await B.call("GET", "/api/me")).json.user.id, "creator");
      const made = (await A.call("POST", "/account/keys", { name: "a-key" })).json;
      assert.equal((await B.call("GET", "/account/keys")).json.keys.length, 0);
      assert.equal((await B.call("DELETE", `/account/keys/${made.record.id}`)).status, 404);
      assert.equal((await fetch(`${base}/v1/runs`, { headers: { Authorization: `Bearer ${made.key}` } })).status, 200);
      assert.equal((await A.call("DELETE", `/account/keys/${made.record.id}`)).status, 200);
      assert.equal((await fetch(`${base}/v1/runs`, { headers: { Authorization: `Bearer ${made.key}` } })).status, 401);
    });
    test("retention: a run is deleted (with its files) once it is older than its plan keeps it; running ones never are", async () => {
      const f = await mk("ret-f"), c = await mk("ret-c", "creator");
      const files = [];
      const mkRun = async (owner, ageDays, status = "done") => {
        const id = crypto.randomUUID(); const src = path.join(tmp, `r-${id}.mp4`); fs.writeFileSync(src, Buffer.alloc(100, 2));
        const uri = await storage.putFile(src, `${id}/c.mp4`, "video/mp4"); files.push(uri);
        await pool.query("insert into meme_builder_jobs (id, owner_id, persona_id, source_kind, source_label, status, created_at) values ($1, $2, 'truckers', 'upload', 'old', $3, now() - ($4 || ' days')::interval)", [id, owner.id, status, String(ageDays)]);
        await store.addClip(pool, id, "truckers", 1, { caption: "old", score: 5, startSec: 1, endSec: 5, storageUri: uri, bytes: 100 });
        return { id, uri };
      };
      const freeOld = await mkRun(f, PLANS.free.retentionDays + 1), freeNew = await mkRun(f, 1), freeRunning = await mkRun(f, 400, "running");
      const creatorMid = await mkRun(c, PLANS.free.retentionDays + 1), creatorOld = await mkRun(c, PLANS.creator.retentionDays + 1);
      const removed = await sweep(pool, { log: { log() {}, error() {} } });
      assert.equal(removed, 2);
      const exists = async (r) => (await pool.query("select 1 from meme_builder_jobs where id = $1", [r.id])).rowCount === 1;
      assert.equal(await exists(freeOld), false); assert.equal(fs.existsSync(freeOld.uri.replace("file://", "")), false, "its files too");
      assert.equal(await exists(freeNew), true); assert.equal(await exists(freeRunning), true, "a run in progress is never swept");
      assert.equal(await exists(creatorMid), true, "the same age is fine on a plan that keeps runs longer");
      assert.equal(await exists(creatorOld), false);
    });
  });

  describe("the usage ledger is per account", () => {
    test("tokens are recorded against the account and run that spent them, and summarised per account", async () => {
      const a = await mk("led-a"), b = await mk("led-b");
      ai.ledger.setPool(pool);
      const realFetch = global.fetch; process.env.OPENAI_API_KEY = "o";
      global.fetch = async () => ({ status: 200, ok: true, headers: new Map(), text: async () => JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 120, completion_tokens: 30 } }) });
      try {
        await ai.ledger.runWithContext({ ownerId: a.id, stage: "captions" }, () => ai.chat({ models: ["openai:gpt-x"], messages: [{ role: "user", content: "x" }] }));
        await ai.ledger.runWithContext({ ownerId: a.id, stage: "captions" }, () => ai.chat({ models: ["openai:gpt-x"], messages: [{ role: "user", content: "x" }] }));
        await ai.ledger.runWithContext({ ownerId: b.id, stage: "verify" }, () => ai.chat({ models: ["openai:gpt-x"], messages: [{ role: "user", content: "x" }] }));
        await new Promise((r) => setTimeout(r, 100));
      } finally { global.fetch = realFetch; delete process.env.OPENAI_API_KEY; ai.ledger.setPool(null); }
      const sa = await ai.ledger.summary(pool, a.id), sb = await ai.ledger.summary(pool, b.id);
      assert.equal(sa.length, 1); assert.equal(sa[0].calls, 2); assert.equal(sa[0].input_tokens, 240); assert.equal(sa[0].output_tokens, 60);
      assert.equal(sb[0].calls, 1); assert.equal(sb[0].input_tokens, 120);
    });
  });
});
