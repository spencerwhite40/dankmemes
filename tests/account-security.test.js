"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const mail = require("../src/email");
const realFetch = global.fetch;

describe("account-security emails (no database)", () => {
  test("an address is masked in the notice sent to the old one, and the messages carry what the person needs", () => {
    assert.equal(mail.mask("sam@example.com"), "s***@example.com");
    const ask = mail.emailChangeMessage({ name: "Sam", newEmail: "new@example.com", link: "https://app.test/?verify=abc" });
    assert.ok(ask.text.includes("new@example.com") && ask.text.includes("https://app.test/?verify=abc") && /24 hours/.test(ask.text));
    const notice = mail.emailChangeNotice({ name: "Sam", newEmail: "new@example.com" });
    assert.ok(notice.text.includes("n***@example.com") && !notice.text.includes("new@example.com"), "the full new address isn't revealed to the old inbox");
    assert.match(notice.text, /Forgot your password/); assert.match(mail.passwordChangedNotice({}).text, /signed out/);
    assert.ok(!mail.emailChangeMessage({ name: "<b>x</b>", newEmail: "<i>a@b.co</i>", link: "https://x" }).html.includes("<b>x</b>"), "escaped");
  });
});

const DB = process.env.DATABASE_URL_TEST;
describe("changing your own password and email address against a real database", { skip: !DB && "DATABASE_URL_TEST is not set" }, () => {
  const { Pool } = require("pg");
  const accounts = require("../src/accounts");
  const tokens = require("../src/tokens");
  const { migrate } = require("../src/migrate");
  const { buildApp } = require("../src/server");
  let pool, server, base, tmp;
  const PW = "a-long-enough-password";
  const email = (l) => `${l}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const row = async (id) => (await pool.query("select * from users where id = $1", [id])).rows[0];
  const to = (e) => mail.outbox.filter((m) => m.to === e);
  const tokenIn = (m) => /[?&]verify=([\w-]+)/.exec(m.text)[1];

  const device = () => {
    let cookie = "";
    const call = async (method, p, body) => {
      const res = await realFetch(base + p, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      if (set.length) { const c = set[0].split(";")[0]; cookie = c.endsWith("=") ? "" : c; }
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json };
    };
    return { call, signIn: (e, p = PW) => call("POST", "/auth/login", { email: e, password: p }) };
  };
  const account = async (label) => {
    const user = await accounts.signup(pool, { email: email(label), password: PW, name: "Sam" });
    await accounts.markVerified(pool, user.id);
    const a = device(); assert.equal((await a.signIn(user.email)).status, 200);
    return { user, a };
  };

  before(async () => {
    process.env.MEME_BUILDER_STORAGE_BACKEND = "local";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mb-sec-")); process.env.MEME_BUILDER_STORAGE_ROOT = tmp;
    Object.assign(process.env, { EMAIL_PROVIDER: "memory", EMAIL_FROM: "App <hi@example.com>", APP_URL: "https://app.test" });
    pool = new Pool({ connectionString: DB, ssl: /\/tmp\/|localhost|127\.0\.0\.1/.test(DB) ? false : { rejectUnauthorized: false } });
    await migrate(pool);
    await pool.query("truncate usage_events, model_usage, api_keys, sessions, users, auth_tokens, stripe_events, meme_builder_clips, meme_builder_jobs, meme_builder_personas cascade");
    await new Promise((r) => { server = http.createServer(buildApp(pool)).listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { global.fetch = realFetch; server && server.close(); await pool.end(); fs.rmSync(tmp, { recursive: true, force: true }); for (const k of ["EMAIL_PROVIDER", "EMAIL_FROM", "APP_URL", "STRIPE_SECRET_KEY"]) delete process.env[k]; });

  describe("password", () => {
    test("needs a session, the current password, a good new one that differs from the old", async () => {
      assert.equal((await device().call("POST", "/account/password", { current_password: PW, new_password: "another-long-password" })).status, 401);
      const { a } = await account("pw-guard");
      const wrong = await a.call("POST", "/account/password", { current_password: "wrong-password-xx", new_password: "another-long-password" }); assert.equal(wrong.status, 403); assert.equal(wrong.json.code, "bad_password");
      assert.equal((await a.call("POST", "/account/password", { current_password: PW, new_password: "short" })).json.code, "weak_password");
      assert.equal((await a.call("POST", "/account/password", { current_password: PW, new_password: "x".repeat(300) })).status, 400);
      assert.equal((await a.call("POST", "/account/password", { current_password: PW, new_password: PW })).json.code, "same_password");
    });
    test("it works: the new password signs in, the old doesn't, this device stays signed in, other devices are signed out, and a notice is emailed", async () => {
      const { user, a } = await account("pw-ok"), other = device(); await other.signIn(user.email);
      const NEW = "a-brand-new-password-9";
      const r = await a.call("POST", "/account/password", { current_password: PW, new_password: NEW }); assert.equal(r.status, 200);
      assert.equal((await a.call("GET", "/api/jobs")).status, 200, "this device is still signed in");
      assert.equal((await other.call("GET", "/api/jobs")).status, 401, "the other device is signed out");
      assert.equal((await device().signIn(user.email, PW)).status, 401, "old password"); assert.equal((await device().signIn(user.email, NEW)).status, 200);
      assert.equal(to(user.email).filter((m) => /password was changed/i.test(m.subject)).length, 1);
    });
    test("a locked account can still change its password", async () => {
      const { user, a } = await account("pw-locked"); await pool.query("update users set locked_at = now() where id = $1", [user.id]);
      assert.equal((await a.call("POST", "/account/password", { current_password: PW, new_password: "a-brand-new-password-9" })).status, 200);
    });
  });

  describe("email address", () => {
    test("needs the password, a valid new address that isn't yours or someone else's, and email to be set up", async () => {
      const { user, a } = await account("em-guard"), other = await account("em-other");
      assert.equal((await device().call("POST", "/account/email", { password: PW, new_email: email("x") })).status, 401);
      assert.equal((await a.call("POST", "/account/email", { password: "wrong-password-xx", new_email: email("x") })).json.code, "bad_password");
      assert.equal((await a.call("POST", "/account/email", { password: PW, new_email: "nope" })).json.code, "bad_email");
      assert.equal((await a.call("POST", "/account/email", { password: PW, new_email: user.email.toUpperCase() })).json.code, "same_email");
      assert.equal((await a.call("POST", "/account/email", { password: PW, new_email: other.user.email })).json.code, "email_taken");
      const prev = process.env.EMAIL_PROVIDER; process.env.EMAIL_PROVIDER = "none";
      try { assert.equal((await a.call("POST", "/account/email", { password: PW, new_email: email("x") })).json.code, "email_off"); } finally { process.env.EMAIL_PROVIDER = prev; }
    });
    test("asking changes nothing yet; the link goes to the NEW address, a warning to the OLD; opening the link makes the change", async () => {
      const { user, a } = await account("em-ok"), fresh = email("fresh");
      const r = await a.call("POST", "/account/email", { password: PW, new_email: fresh.toUpperCase() });
      assert.equal(r.status, 200); assert.equal(r.json.pending, true);
      assert.equal((await row(user.id)).email, user.email, "unchanged until confirmed");
      const ask = to(fresh)[0]; assert.ok(ask && /confirm/i.test(ask.subject)); assert.match(ask.text, /https:\/\/app\.test\/\?verify=/);
      const warn = to(user.email).find((m) => /change of email/i.test(m.subject)); assert.ok(warn, "the old address was warned"); assert.ok(!warn.text.includes(fresh), "without revealing the new address in full");
      const c = await device().call("POST", "/auth/verify", { token: tokenIn(ask) });
      assert.equal(c.status, 200); assert.equal(c.json.email_changed, true);
      const u = await row(user.id); assert.equal(u.email, fresh); assert.ok(u.email_verified_at);
      assert.equal((await device().signIn(fresh)).status, 200, "the new address signs in"); assert.equal((await device().signIn(user.email)).status, 401, "the old one doesn't");
      assert.equal((await device().call("POST", "/auth/verify", { token: tokenIn(ask) })).status, 400, "single use");
    });
    test("a newer request cancels an older link; an expired link fails; the same link can't confirm a plain sign-up", async () => {
      const { user, a } = await account("em-two"), first = email("first"), second = email("second");
      await a.call("POST", "/account/email", { password: PW, new_email: first }); await a.call("POST", "/account/email", { password: PW, new_email: second });
      assert.equal((await device().call("POST", "/auth/verify", { token: tokenIn(to(first)[0]) })).status, 400, "the first link was superseded");
      await pool.query("update auth_tokens set expires_at = now() - interval '1 second' where user_id = $1 and used_at is null", [user.id]);
      assert.equal((await device().call("POST", "/auth/verify", { token: tokenIn(to(second)[0]) })).status, 400, "expired");
      assert.equal((await row(user.id)).email, user.email, "never changed");
    });
    test("if someone takes the address before it's confirmed, the confirmation fails cleanly", async () => {
      const { user, a } = await account("em-race"), wanted = email("wanted");
      await a.call("POST", "/account/email", { password: PW, new_email: wanted });
      await accounts.signup(pool, { email: wanted, password: PW });
      const c = await device().call("POST", "/auth/verify", { token: tokenIn(to(wanted)[0]) });
      assert.equal(c.status, 409); assert.equal(c.json.code, "email_taken"); assert.equal((await row(user.id)).email, user.email);
    });
    test("the payment provider's copy of the address is updated too", async () => {
      const { user, a } = await account("em-stripe"), fresh = email("stripe-new");
      await pool.query("update users set stripe_customer_id = 'cus_changeme' where id = $1", [user.id]);
      process.env.STRIPE_SECRET_KEY = "sk_test_x"; const calls = [];
      global.fetch = async (url, init) => { if (!String(url).startsWith("https://api.stripe.com/")) return realFetch(url, init); calls.push({ url: String(url), body: String(init.body) }); return { ok: true, status: 200, text: async () => "{}" }; };
      try {
        await a.call("POST", "/account/email", { password: PW, new_email: fresh });
        assert.equal((await device().call("POST", "/auth/verify", { token: tokenIn(to(fresh)[0]) })).status, 200);
        assert.equal(calls.length, 1); assert.equal(calls[0].url, "https://api.stripe.com/v1/customers/cus_changeme"); assert.equal(decodeURIComponent(calls[0].body), `email=${fresh}`);
      } finally { global.fetch = realFetch; delete process.env.STRIPE_SECRET_KEY; }
    });
    test("tokens carry a payload and a reset link still can't change an email", async () => {
      const { user } = await account("em-tok");
      const t = await tokens.create(pool, user.id, "reset");
      assert.equal(await tokens.consumeRow(pool, t, "email_change"), null);
      const c = await tokens.create(pool, user.id, "email_change", { payload: "x@y.co" });
      assert.deepEqual(await tokens.consumeRow(pool, c, "email_change"), { userId: user.id, payload: "x@y.co" });
    });
  });
});
