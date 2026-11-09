"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const mail = require("../src/email");
const legal = require("../src/legal");
const { PLANS } = require("../src/plans");

const realFetch = global.fetch;
const ENV_KEYS = ["EMAIL_PROVIDER", "RESEND_API_KEY", "POSTMARK_SERVER_TOKEN", "EMAIL_FROM", "APP_URL", "APP_NAME", "COMPANY_NAME", "COMPANY_ADDRESS", "SUPPORT_EMAIL", "COPYRIGHT_EMAIL", "LEGAL_JURISDICTION", "LEGAL_REVIEWED", "POSTMARK_STREAM"];
const withEnv = async (vars, fn) => {
  const keep = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const k of ENV_KEYS) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } global.fetch = realFetch; }
};

describe("the mail sender (no database)", () => {
  test("which provider is used: forced, else by which key is set, else none", async () => {
    await withEnv({}, () => { assert.equal(mail.provider(), "none"); assert.equal(mail.configured(), false); });
    await withEnv({ RESEND_API_KEY: "re_x" }, () => assert.equal(mail.provider(), "resend"));
    await withEnv({ POSTMARK_SERVER_TOKEN: "pm_x" }, () => assert.equal(mail.provider(), "postmark"));
    await withEnv({ RESEND_API_KEY: "re_x", EMAIL_PROVIDER: "memory" }, () => assert.equal(mail.provider(), "memory"));
    await withEnv({ EMAIL_PROVIDER: "bogus" }, () => assert.equal(mail.provider(), "none"));
  });
  test("with nothing configured, sending quietly does nothing", async () => {
    await withEnv({}, async () => assert.deepEqual(await mail.send({ to: "a@b.co", subject: "s", text: "t", html: "<p>t</p>" }), { sent: false }));
  });
  test("Resend: the request has the key, the sender, the recipient and both bodies", async () => {
    await withEnv({ RESEND_API_KEY: "re_secret", EMAIL_FROM: "App <hi@example.com>" }, async () => {
      let seen; global.fetch = async (url, init) => { seen = { url: String(url), init }; return { ok: true, status: 200, text: async () => "{}" }; };
      await mail.send({ to: "u@x.co", subject: "Hello", text: "plain", html: "<p>rich</p>" });
      assert.equal(seen.url, "https://api.resend.com/emails"); assert.equal(seen.init.headers.Authorization, "Bearer re_secret");
      assert.deepEqual(JSON.parse(seen.init.body), { from: "App <hi@example.com>", to: ["u@x.co"], subject: "Hello", text: "plain", html: "<p>rich</p>" });
    });
  });
  test("Postmark: its own header and field names", async () => {
    await withEnv({ POSTMARK_SERVER_TOKEN: "pm_secret", EMAIL_FROM: "hi@example.com" }, async () => {
      let seen; global.fetch = async (url, init) => { seen = { url: String(url), init }; return { ok: true, status: 200, text: async () => "{}" }; };
      await mail.send({ to: "u@x.co", subject: "Hello", text: "plain", html: "<p>rich</p>" });
      assert.equal(seen.url, "https://api.postmarkapp.com/email"); assert.equal(seen.init.headers["X-Postmark-Server-Token"], "pm_secret");
      assert.deepEqual(JSON.parse(seen.init.body), { From: "hi@example.com", To: "u@x.co", Subject: "Hello", TextBody: "plain", HtmlBody: "<p>rich</p>", MessageStream: "outbound" });
    });
  });
  test("a provider that refuses, or a missing sender address, is an error (not silence)", async () => {
    await withEnv({ RESEND_API_KEY: "re_x", EMAIL_FROM: "hi@example.com" }, async () => {
      global.fetch = async () => ({ ok: false, status: 422, text: async () => "domain not verified" });
      await assert.rejects(() => mail.send({ to: "u@x.co", subject: "s", text: "t", html: "t" }), /422.*domain not verified/);
    });
    await withEnv({ RESEND_API_KEY: "re_x" }, async () => { await assert.rejects(() => mail.send({ to: "u@x.co", subject: "s", text: "t", html: "t" }), /EMAIL_FROM/); });
  });
  test("the messages carry the link, and a name can't inject markup", () => {
    const link = "https://app.example.com/?reset=abc123";
    for (const make of [mail.verificationMessage, mail.resetMessage]) {
      const m = make({ name: "<script>alert(1)</script>", link });
      assert.ok(m.text.includes(link) && m.html.includes(link)); assert.ok(!m.html.includes("<script>"), "escaped"); assert.ok(m.subject.length > 5);
    }
    assert.match(mail.resetMessage({ link }).text, /1 hour/); assert.match(mail.verificationMessage({ link }).text, /3 days/);
  });
});

describe("the legal pages (no database)", () => {
  const { buildApp } = require("../src/server");
  const get = async (p) => { const server = http.createServer(buildApp({})); await new Promise((r) => server.listen(0, r)); try { const r = await realFetch(`http://127.0.0.1:${server.address().port}${p}`); return { status: r.status, text: await r.text(), type: r.headers.get("content-type") }; } finally { server.close(); } };
  test("all four pages are served, with the company's details filled in, and the draft banner until reviewed", async () => {
    await withEnv({ COMPANY_NAME: "Acme Clips LLC", COMPANY_ADDRESS: "1 Main St, Springfield", SUPPORT_EMAIL: "help@acme.test", COPYRIGHT_EMAIL: "dmca@acme.test", LEGAL_JURISDICTION: "the State of Delaware" }, async () => {
      for (const [p, phrase] of [["/terms", "Acme Clips LLC"], ["/privacy", "help@acme.test"], ["/refunds", "within 7 days"], ["/copyright", "dmca@acme.test"]]) {
        const r = await get(p);
        assert.equal(r.status, 200, p); assert.match(r.type, /html/); assert.ok(r.text.includes(phrase), `${p} has ${phrase}`);
        assert.ok(!/\{\{/.test(r.text), `${p} has no unfilled placeholder`); assert.ok(r.text.includes("draft-banner"), `${p} says it is a draft`);
      }
      assert.ok((await get("/terms")).text.includes("State of Delaware"));
    });
    await withEnv({ LEGAL_REVIEWED: "yes" }, async () => assert.ok(!(await get("/terms")).text.includes("draft-banner"), "no banner once reviewed"));
  });
  test("unset details show an obvious placeholder, are listed as missing, and values are HTML-escaped", async () => {
    await withEnv({}, async () => {
      assert.deepEqual(legal.missing().sort(), ["COMPANY_ADDRESS", "COMPANY_NAME", "COPYRIGHT_EMAIL", "LEGAL_JURISDICTION", "SUPPORT_EMAIL"]);
      assert.ok((await get("/terms")).text.includes("[Company name]"));
    });
    await withEnv({ COMPANY_NAME: "A <b>&</b> Co" }, async () => { const t = (await get("/terms")).text; assert.ok(t.includes("A &lt;b&gt;&amp;&lt;/b&gt; Co") && !t.includes("A <b>&</b> Co")); });
  });
  test("the pages say what the product really does: the watermark plans, the 7-day refund, locked accounts, the takedown steps", async () => {
    const terms = legal.render("terms"), privacy = legal.render("privacy"), refunds = legal.render("refunds"), copy = legal.render("copyright");
    const marked = Object.values(PLANS).filter((p) => p.watermark).map((p) => p.label);
    assert.deepEqual(marked, ["Free", "Starter"], "if the watermark plans change, the Terms need to change too");
    assert.ok(terms.includes("Free and Starter plans carry a watermark"));
    assert.ok(terms.includes("account is locked") && privacy.includes("account is locked"));
    assert.ok(terms.includes("do not carry over") || terms.includes("do not expire"));
    assert.ok(refunds.includes("7 days") && refunds.includes("10%"));
    for (const who of ["Google", "Anthropic", "OpenAI", "Stripe", "Cloudflare"]) assert.ok(privacy.includes(who), `the privacy policy names ${who}`);
    for (const part of ["penalty of perjury", "counter-notice", "Repeat infringers", "good-faith belief"]) assert.ok(copy.toLowerCase().includes(part.toLowerCase()), `the takedown page has ${part}`);
    assert.equal(legal.render("nope"), null);
  });
});

const DB = process.env.DATABASE_URL_TEST;
describe("email verification and password reset against a real database", { skip: !DB && "DATABASE_URL_TEST is not set" }, () => {
  const { Pool } = require("pg");
  const accounts = require("../src/accounts");
  const tokens = require("../src/tokens");
  const { migrate } = require("../src/migrate");
  const { buildApp } = require("../src/server");
  const { createRun } = require("../src/intake");
  let pool, server, base, tmp;
  const PW = "a-long-enough-password";
  const email = (l) => `${l}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const row = async (id) => (await pool.query("select * from users where id = $1", [id])).rows[0];

  const client = () => {
    let cookie = "";
    const call = async (method, p, body) => {
      const res = await realFetch(base + p, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      if (set.length) { const c = set[0].split(";")[0]; cookie = c.endsWith("=") ? "" : c; }
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json };
    };
    return { call, hasCookie: () => !!cookie };
  };
  const signUp = async (label) => {
    const c = client(), e = email(label);
    const r = await c.call("POST", "/auth/signup", { email: e, password: PW, name: "Sam", accept_terms: true });
    assert.equal(r.status, 201); return { c, e, id: r.json.user.id };
  };
  const mailTo = (e) => mail.outbox.filter((m) => m.to === e);
  const tokenIn = (m, kind) => new RegExp(`[?&]${kind}=([\\w-]+)`).exec(m.text)[1];
  const waitForMail = async (e, n = 1) => { for (let i = 0; i < 40 && mailTo(e).length < n; i++) await new Promise((r) => setTimeout(r, 25)); return mailTo(e); };

  before(async () => {
    process.env.MEME_BUILDER_STORAGE_BACKEND = "local";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mb-mail-")); process.env.MEME_BUILDER_STORAGE_ROOT = tmp;
    Object.assign(process.env, { EMAIL_PROVIDER: "memory", EMAIL_FROM: "App <hi@example.com>", APP_URL: "https://app.test/" });
    pool = new Pool({ connectionString: DB, ssl: /\/tmp\/|localhost|127\.0\.0\.1/.test(DB) ? false : { rejectUnauthorized: false } });
    await migrate(pool);
    await pool.query("truncate usage_events, model_usage, api_keys, sessions, users, auth_tokens, stripe_events, meme_builder_clips, meme_builder_jobs, meme_builder_personas cascade");
    await new Promise((r) => { server = http.createServer(buildApp(pool)).listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { server && server.close(); await pool.end(); fs.rmSync(tmp, { recursive: true, force: true }); for (const k of ENV_KEYS) delete process.env[k]; });

  describe("sign-up and confirming the address", () => {
    test("sign-up needs the terms ticked, and records when they were accepted", async () => {
      const c = client();
      const no = await c.call("POST", "/auth/signup", { email: email("t"), password: PW });
      assert.equal(no.status, 400); assert.equal(no.json.code, "terms_required"); assert.equal(c.hasCookie(), false);
      assert.equal((await c.call("POST", "/auth/signup", { email: email("t"), password: PW, accept_terms: "yes" })).status, 400, "must be exactly true");
      const { id } = await signUp("terms"); assert.ok((await row(id)).terms_accepted_at);
    });
    test("sign-up sends one confirmation email with a link; the account starts unconfirmed", async () => {
      const { c, e, id } = await signUp("verify-mail");
      const sent = await waitForMail(e); assert.equal(sent.length, 1);
      assert.match(sent[0].text, /https:\/\/app\.test\/\?verify=[\w-]{30,}/); assert.equal(sent[0].from, "App <hi@example.com>");
      assert.equal((await row(id)).email_verified_at, null);
      const me = (await c.call("GET", "/api/me")).json; assert.equal(me.user.email_verified, false); assert.equal(me.verification_required, true);
      assert.equal((await pool.query("select token_hash from auth_tokens where user_id = $1", [id])).rows[0].token_hash.includes(tokenIn(sent[0], "verify")), false, "only a hash is stored");
    });
    test("until confirmed, no run can start and no checkout; once confirmed, both can", async () => {
      const { c, e, id } = await signUp("gate");
      const start = () => createRun(pool, { ownerId: id }, { personaId: "truckers", sourceUrl: `https://8.8.8.8/${crypto.randomUUID()}.mp4` });
      await assert.rejects(start, (err) => err.status === 403 && err.code === "email_not_verified" && err.message.includes(e));
      await assert.rejects(() => require("../src/billing/service").startCheckout(pool, { id }, { protocol: "https", get: () => "x" }, { plan: "creator", period: "monthly" }), { code: "email_not_verified" });
      const r = await c.call("POST", "/auth/verify", { token: tokenIn((await waitForMail(e))[0], "verify") });
      assert.equal(r.status, 200); assert.ok((await row(id)).email_verified_at);
      assert.ok((await start()).job, "now it starts");
      assert.equal((await c.call("GET", "/api/me")).json.user.email_verified, true);
    });
    test("a confirmation link works once; garbage, expired and wrong-purpose tokens are refused", async () => {
      const { c, e, id } = await signUp("once");
      const token = tokenIn((await waitForMail(e))[0], "verify");
      assert.equal((await c.call("POST", "/auth/verify", { token })).status, 200);
      assert.equal((await c.call("POST", "/auth/verify", { token })).status, 400, "second use");
      for (const bad of ["", "short", "x".repeat(60), null, 12345, { a: 1 }]) assert.equal((await c.call("POST", "/auth/verify", { token: bad })).status, 400, JSON.stringify(bad));
      const old = await tokens.create(pool, id, "verify"); await pool.query("update auth_tokens set expires_at = now() - interval '1 minute' where user_id = $1 and used_at is null", [id]);
      assert.equal((await c.call("POST", "/auth/verify", { token: old })).json.code, "bad_token", "expired");
      const reset = await tokens.create(pool, id, "reset");
      assert.equal((await c.call("POST", "/auth/verify", { token: reset })).status, 400, "a reset token can't confirm an address");
    });
    test("asking for the email again: works, is limited to three an hour, and does nothing once confirmed", async () => {
      const { c, e } = await signUp("resend");
      assert.equal((await c.call("POST", "/auth/resend-verification")).status, 200); assert.equal((await c.call("POST", "/auth/resend-verification")).status, 200);
      assert.equal((await waitForMail(e, 3)).length, 3, "the one at sign-up and two more");
      const third = await c.call("POST", "/auth/resend-verification"); assert.equal(third.status, 200);
      const fourth = await c.call("POST", "/auth/resend-verification"); assert.equal(fourth.status, 429);
      assert.equal(client().call && (await client().call("POST", "/auth/resend-verification")).status, 401, "needs a session");
      const done = await signUp("resend-done"); await accounts.markVerified(pool, done.id); const before = mailTo(done.e).length;
      assert.equal((await done.c.call("POST", "/auth/resend-verification")).json.already, true); assert.equal(mailTo(done.e).length, before, "no email");
    });
    test("where email isn't set up, nobody is blocked (they could never confirm)", async () => {
      const { id } = await signUp("noemail"); const prev = process.env.EMAIL_PROVIDER;
      try {
        process.env.EMAIL_PROVIDER = "none";
        assert.equal(accounts.verificationRequired(), false);
        assert.ok((await createRun(pool, { ownerId: id }, { personaId: "truckers", sourceUrl: `https://8.8.8.8/${crypto.randomUUID()}.mp4` })).job);
      } finally { process.env.EMAIL_PROVIDER = prev; }
    });
    test("if the email provider fails, the account is still made, and 'send again' says so plainly", async () => {
      const prev = { p: process.env.EMAIL_PROVIDER, k: process.env.RESEND_API_KEY };
      try {
        process.env.EMAIL_PROVIDER = "resend"; process.env.RESEND_API_KEY = "re_x";
        global.fetch = async (url, init) => (String(url).includes("api.resend.com") ? { ok: false, status: 500, text: async () => "down" } : realFetch(url, init));
        const { c, id } = await signUp("provider-down");
        assert.ok(await row(id), "the account exists");
        const r = await c.call("POST", "/auth/resend-verification"); assert.equal(r.status, 502); assert.equal(r.json.code, "email_failed"); assert.ok(!/down/.test(JSON.stringify(r.json)), "provider detail isn't shown");
      } finally { global.fetch = realFetch; process.env.EMAIL_PROVIDER = prev.p; if (prev.k === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prev.k; }
    });
  });

  describe("forgotten passwords", () => {
    test("the answer is the same for an address with an account and one without; only the real one gets an email", async () => {
      const { e } = await signUp("forgot"); const c = client(), ghost = email("ghost");
      const known = await c.call("POST", "/auth/forgot", { email: e.toUpperCase() }), unknown = await c.call("POST", "/auth/forgot", { email: ghost });
      assert.equal(known.status, 200); assert.deepEqual(known.json, unknown.json);
      const sent = (await waitForMail(e, 2)).filter((m) => /reset/i.test(m.subject)); assert.equal(sent.length, 1);
      assert.match(sent[0].text, /https:\/\/app\.test\/\?reset=[\w-]{30,}/);
      await new Promise((r) => setTimeout(r, 100)); assert.equal(mailTo(ghost).length, 0, "nothing for an unknown address");
      assert.equal((await c.call("POST", "/auth/forgot", {})).status, 400);
    });
    test("choosing a new password: a too-short one doesn't use up the link; a good one works once, signs out everywhere, and confirms the address", async () => {
      const { c: old, e, id } = await signUp("reset");
      await client().call("POST", "/auth/forgot", { email: e });
      const link = (await waitForMail(e, 2)).find((m) => /reset/i.test(m.subject)); const token = tokenIn(link, "reset");
      const c = client();
      const weak = await c.call("POST", "/auth/reset", { token, password: "short" }); assert.equal(weak.status, 400); assert.equal(weak.json.code, "weak_password");
      assert.equal((await c.call("POST", "/auth/reset", { token: "x".repeat(50), password: "another-long-password" })).json.code, "bad_token");
      assert.equal((await old.call("GET", "/api/jobs")).status, 200, "still signed in on the old device");
      const NEW = "a-brand-new-password-1";
      assert.equal((await c.call("POST", "/auth/reset", { token, password: NEW })).status, 200);
      assert.equal((await c.call("POST", "/auth/reset", { token, password: "yet-another-long-one" })).status, 400, "the link is single-use");
      assert.equal((await old.call("GET", "/api/jobs")).status, 401, "signed out everywhere");
      assert.equal((await client().call("POST", "/auth/login", { email: e, password: PW })).status, 401, "old password no longer works");
      assert.equal((await client().call("POST", "/auth/login", { email: e, password: NEW })).status, 200);
      assert.ok((await row(id)).email_verified_at, "following the link proves the inbox is theirs");
    });
    test("an expired link fails, and a newer link cancels an older one", async () => {
      const { id } = await signUp("reset2");
      const first = await tokens.create(pool, id, "reset"), second = await tokens.create(pool, id, "reset");
      const c = client();
      assert.equal((await c.call("POST", "/auth/reset", { token: first, password: "a-long-enough-password-2" })).json.code, "bad_token", "superseded");
      await pool.query("update auth_tokens set expires_at = now() - interval '1 second' where user_id = $1 and used_at is null", [id]);
      assert.equal((await c.call("POST", "/auth/reset", { token: second, password: "a-long-enough-password-2" })).json.code, "bad_token", "expired");
    });
    test("asking for resets is limited per address", async () => {
      const { e } = await signUp("flood"); const c = client();
      const results = []; for (let i = 0; i < 4; i++) results.push((await c.call("POST", "/auth/forgot", { email: e })).status);
      assert.deepEqual(results, [200, 200, 200, 429]);
    });
    test("with no email provider the reset says so instead of pretending", async () => {
      const prev = process.env.EMAIL_PROVIDER;
      try { process.env.EMAIL_PROVIDER = "none"; const r = await client().call("POST", "/auth/forgot", { email: email("x") }); assert.equal(r.status, 503); assert.equal(r.json.code, "email_off"); } finally { process.env.EMAIL_PROVIDER = prev; }
    });
  });
});
