"use strict";
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const stripe = require("../src/billing/stripe");
const catalog = require("../src/billing/catalog");
const { PLANS, PACKS, paidPlanNames } = require("../src/plans");

const SECRET = "whsec_test_secret";
const PRICE_ENV = {};
for (const v of catalog.requiredPriceVars()) PRICE_ENV[v] = `price_${v.toLowerCase()}`;

describe("billing building blocks (no database)", () => {
  test("form encoding nests objects and arrays the way Stripe expects", () => {
    const out = stripe.encode({ mode: "subscription", line_items: [{ price: "p_1", quantity: 1 }], metadata: { user_id: "u", plan: "creator" }, skip: undefined, nope: null, flag: true });
    assert.deepEqual(out.map(decodeURIComponent).sort(), ["flag=true", "line_items[0][price]=p_1", "line_items[0][quantity]=1", "metadata[plan]=creator", "metadata[user_id]=u", "mode=subscription"]);
  });
  test("webhook signatures: the right one passes; a wrong secret, a changed body, a stale time and a missing header are refused", () => {
    const body = JSON.stringify({ id: "evt_1", type: "x" });
    const now = Date.now(), t = Math.floor(now / 1000);
    assert.equal(stripe.verifyWebhook(body, stripe.signPayload(body, SECRET, t), SECRET, { now }).id, "evt_1");
    assert.equal(stripe.verifyWebhook(Buffer.from(body), stripe.signPayload(body, SECRET, t), SECRET, { now }).id, "evt_1", "raw bytes work too");
    assert.throws(() => stripe.verifyWebhook(body, stripe.signPayload(body, "other", t), SECRET, { now }), { code: "bad_signature" });
    assert.throws(() => stripe.verifyWebhook(body + " ", stripe.signPayload(body, SECRET, t), SECRET, { now }), { code: "bad_signature" });
    assert.throws(() => stripe.verifyWebhook(body, stripe.signPayload(body, SECRET, t - 3600), SECRET, { now }), { code: "bad_signature" }, "an hour old");
    assert.throws(() => stripe.verifyWebhook(body, "", SECRET, { now }), { code: "bad_signature" });
    assert.throws(() => stripe.verifyWebhook(body, "t=1,v1=zz", SECRET, { now }), { code: "bad_signature" });
    assert.throws(() => stripe.verifyWebhook(body, stripe.signPayload(body, SECRET, t), "", { now }), { code: "billing_off" });
    const two = `${stripe.signPayload(body, "old-secret", t)},v1=${crypto.createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex")}`;
    assert.equal(stripe.verifyWebhook(body, two, SECRET, { now }).id, "evt_1", "any one valid v1 is enough (secret rotation)");
  });
  test("the catalog maps Stripe prices to plans and packs, and says what is on sale", () => {
    const keep = { ...process.env };
    try {
      for (const v of catalog.requiredPriceVars()) delete process.env[v];
      delete process.env.STRIPE_SECRET_KEY;
      assert.equal(catalog.requiredPriceVars().length, paidPlanNames().length * 2 + Object.keys(PACKS).length);
      assert.equal(catalog.publicCatalog().enabled, false);
      assert.ok(catalog.publicCatalog().plans.every((p) => !p.available.monthly && !p.available.annual));
      Object.assign(process.env, PRICE_ENV, { STRIPE_SECRET_KEY: "sk_test_x" });
      assert.deepEqual(catalog.lookupPrice(PRICE_ENV.STRIPE_PRICE_PRO_ANNUAL), { kind: "plan", plan: "pro", period: "annual" });
      assert.deepEqual(catalog.lookupPrice(PRICE_ENV.STRIPE_PRICE_PACK_LARGE), { kind: "pack", pack: "large" });
      assert.equal(catalog.lookupPrice("price_unknown"), null); assert.equal(catalog.lookupPrice(""), null);
      const c = catalog.publicCatalog();
      assert.equal(c.enabled, true); assert.equal(c.plans.find((p) => p.name === "creator").price_monthly, 30);
      assert.ok(c.plans.every((p) => p.available.monthly && p.available.annual) && c.packs.every((p) => p.available));
    } finally { for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep); }
  });
  test("pack prices: bigger packs are better value, the smallest is the worst deal, and even the best costs a little more than a subscription", () => {
    const list = Object.entries(PACKS), rate = (p) => p.price / p.minutes;
    assert.ok(list.length >= 3, "several sizes");
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i][1].minutes > list[i - 1][1].minutes, `${list[i][0]} is bigger than ${list[i - 1][0]}`);
      assert.ok(rate(list[i][1]) < rate(list[i - 1][1]), `${list[i][0]} is a better rate than ${list[i - 1][0]}`);
    }
    const rates = list.map(([, p]) => rate(p));
    assert.equal(Math.max(...rates), rate(list[0][1]), "the smallest is the worst deal"); assert.equal(Math.min(...rates), rate(list[list.length - 1][1]), "the largest is the best");
    const monthlyRates = paidPlanNames().map((n) => PLANS[n].priceMonthly / PLANS[n].monthlyMinutes);
    const subscription = Math.max(...monthlyRates), best = Math.min(...rates);
    assert.ok(best > subscription, `the best pack (${best.toFixed(3)}) costs more per minute than the dearest monthly plan (${subscription.toFixed(3)})`);
    assert.ok(best <= subscription * 1.25, "but only slightly more");
    const cheapestPlanRate = Math.min(...paidPlanNames().flatMap((n) => [PLANS[n].priceMonthly, PLANS[n].priceAnnual].map((p) => p / PLANS[n].monthlyMinutes)));
    assert.ok(best > cheapestPlanRate, "and more than any annual rate");
    assert.ok(list.every(([, p]) => Number.isInteger(p.minutes) && p.price > 0 && /\d/.test(p.label)));
  });
});

const DB = process.env.DATABASE_URL_TEST;
describe("billing against a real database", { skip: !DB && "DATABASE_URL_TEST is not set" }, () => {
  const { Pool } = require("pg");
  const accounts = require("../src/accounts");
  const packs = require("../src/billing/packs");
  const service = require("../src/billing/service");
  const { migrate } = require("../src/migrate");
  const { buildApp } = require("../src/server");
  const { afterRun } = require("../src/hooks");
  const { createRun } = require("../src/intake");
  const realFetch = global.fetch;
  let pool, server, base, tmp, stripeCalls;
  const PW = "a-long-enough-password";
  const mk = async (label = "u") => accounts.signup(pool, { email: `${label}-${crypto.randomUUID().slice(0, 8)}@example.com`, password: PW });
  const row = async (id) => (await pool.query("select * from users where id = $1", [id])).rows[0];

  const client = async (label) => {
    const user = await mk(label); let cookie = "";
    const res = await realFetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: user.email, password: PW }) });
    cookie = res.headers.getSetCookie()[0].split(";")[0];
    const call = async (method, p, body) => {
      const r = await realFetch(base + p, { method, headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, json };
    };
    return { user, call };
  };
  // Stripe's side: a signed event posted to our webhook
  let evtN = 0;
  const send = async (type, object, { id = `evt_${++evtN}_${crypto.randomUUID().slice(0, 6)}`, secret = SECRET } = {}) => {
    const body = JSON.stringify({ id, type, data: { object } });
    const r = await realFetch(`${base}/billing/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": stripe.signPayload(body, secret) }, body });
    return { status: r.status, json: await r.json().catch(() => null), id };
  };
  const checkoutDone = (u, plan, period, extra = {}) => ({ id: `cs_${crypto.randomUUID().slice(0, 8)}`, mode: "subscription", client_reference_id: u.id, customer: `cus_${u.id.slice(0, 8)}`, subscription: `sub_${u.id.slice(0, 8)}`, payment_status: "paid", metadata: { user_id: u.id, plan, period }, ...extra });
  const subscription = (u, plan, period, extra = {}) => ({ id: `sub_${u.id.slice(0, 8)}`, customer: `cus_${u.id.slice(0, 8)}`, status: "active", cancel_at_period_end: false, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, metadata: { user_id: u.id }, items: { data: [{ price: { id: PRICE_ENV[`STRIPE_PRICE_${plan.toUpperCase()}_${period.toUpperCase()}`] } }] }, ...extra });

  before(async () => {
    process.env.MEME_BUILDER_STORAGE_BACKEND = "local";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mb-bill-")); process.env.MEME_BUILDER_STORAGE_ROOT = tmp;
    Object.assign(process.env, PRICE_ENV, { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: SECRET, APP_URL: "https://clips.example.com/" });
    pool = new Pool({ connectionString: DB, ssl: /\/tmp\/|localhost|127\.0\.0\.1/.test(DB) ? false : { rejectUnauthorized: false } });
    await migrate(pool);
    await pool.query("truncate usage_events, model_usage, api_keys, sessions, users, stripe_events, meme_builder_clips, meme_builder_jobs, meme_builder_personas cascade");
    await new Promise((r) => { server = http.createServer(buildApp(pool)).listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
    // Stripe's API is replaced; our own server still gets real requests
    global.fetch = async (url, init = {}) => {
      if (!String(url).startsWith("https://api.stripe.com/")) return realFetch(url, init);
      const params = Object.fromEntries(new URLSearchParams(init.body || "")); stripeCalls.push({ url: String(url), params, auth: init.headers && init.headers.Authorization });
      const url2 = String(url).includes("billing_portal") ? "https://billing.stripe.test/portal" : "https://checkout.stripe.test/pay";
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "x", url: url2 }) };
    };
  });
  beforeEach(() => { stripeCalls = []; });
  after(async () => {
    global.fetch = realFetch; server && server.close(); await pool.end(); fs.rmSync(tmp, { recursive: true, force: true });
    for (const k of [...Object.keys(PRICE_ENV), "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "APP_URL"]) delete process.env[k];
  });

  describe("starting a payment", () => {
    test("signed-out visitors are refused; billing off says so; the pricing endpoint lists what's on sale and the account's state", async () => {
      assert.equal((await realFetch(`${base}/billing/checkout`, { method: "POST" })).status, 401);
      const c = await client("pricing");
      const info = await c.call("GET", "/api/billing");
      assert.equal(info.status, 200); assert.equal(info.json.enabled, true);
      assert.deepEqual(info.json.plans.map((p) => p.name), ["starter", "creator", "pro", "agency"]);
      assert.equal(info.json.current.pack_minutes, 0); assert.equal(info.json.current.can_manage, false);
      const key = process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_SECRET_KEY;
      try { const off = await c.call("POST", "/billing/checkout", { plan: "creator", period: "monthly" }); assert.equal(off.status, 503); assert.equal(off.json.code, "billing_off"); } finally { process.env.STRIPE_SECRET_KEY = key; }
    });
    test("a plan checkout asks Stripe for a subscription tied to this account, and returns Stripe's page", async () => {
      const c = await client("co");
      const r = await c.call("POST", "/billing/checkout", { plan: "creator", period: "annual" });
      assert.equal(r.status, 200); assert.equal(r.json.url, "https://checkout.stripe.test/pay");
      assert.equal(stripeCalls.length, 1);
      const { url, params, auth } = stripeCalls[0];
      assert.ok(url.endsWith("/v1/checkout/sessions")); assert.equal(auth, "Bearer sk_test_x");
      assert.equal(params.mode, "subscription"); assert.equal(params["line_items[0][price]"], PRICE_ENV.STRIPE_PRICE_CREATOR_ANNUAL);
      assert.equal(params.client_reference_id, c.user.id); assert.equal(params.customer_email, c.user.email);
      assert.equal(params["metadata[plan]"], "creator"); assert.equal(params["metadata[period]"], "annual"); assert.equal(params["subscription_data[metadata][user_id]"], c.user.id);
      assert.equal(params.success_url, "https://clips.example.com/?billing=success", "APP_URL, no double slash");
      assert.equal(params.cancel_url, "https://clips.example.com/?billing=cancelled");
    });
    test("bad requests are refused before Stripe is called", async () => {
      const c = await client("bad");
      for (const body of [{ plan: "free", period: "monthly" }, { plan: "nope", period: "monthly" }, { plan: "pro", period: "weekly" }, { pack: "huge" }, {}]) assert.equal((await c.call("POST", "/billing/checkout", body)).status, 400, JSON.stringify(body));
      const keep = process.env.STRIPE_PRICE_PRO_MONTHLY; delete process.env.STRIPE_PRICE_PRO_MONTHLY;
      try { assert.equal((await c.call("POST", "/billing/checkout", { plan: "pro", period: "monthly" })).json.code, "not_configured"); } finally { process.env.STRIPE_PRICE_PRO_MONTHLY = keep; }
      assert.equal(stripeCalls.length, 0);
    });
    test("someone who already subscribes is sent to the portal, not sold a second subscription", async () => {
      const c = await client("twice");
      await send("checkout.session.completed", checkoutDone(c.user, "creator", "monthly"));
      const r = await c.call("POST", "/billing/checkout", { plan: "pro", period: "monthly" });
      assert.equal(r.status, 409); assert.equal(r.json.code, "already_subscribed"); assert.equal(stripeCalls.length, 0);
      const pack = await c.call("POST", "/billing/checkout", { pack: "small" });
      assert.equal(pack.status, 200, "a subscriber can still buy a pack");
      assert.equal(stripeCalls[0].params.mode, "payment"); assert.equal(stripeCalls[0].params["line_items[0][price]"], PRICE_ENV.STRIPE_PRICE_PACK_SMALL);
      assert.equal(stripeCalls[0].params["metadata[pack]"], "small"); assert.ok(stripeCalls[0].params.customer, "known customer is reused"); assert.equal(stripeCalls[0].params.customer_email, undefined);
    });
    test("the portal needs a customer, then opens Stripe's page for that customer", async () => {
      const c = await client("portal");
      assert.equal((await c.call("POST", "/billing/portal")).json.code, "no_customer");
      await send("checkout.session.completed", checkoutDone(c.user, "pro", "monthly"));
      const r = await c.call("POST", "/billing/portal");
      assert.equal(r.json.url, "https://billing.stripe.test/portal");
      assert.equal(stripeCalls[0].params.customer, `cus_${c.user.id.slice(0, 8)}`); assert.equal(stripeCalls[0].params.return_url, "https://clips.example.com/");
    });
    test("Stripe refusing the request becomes a plain error, not a crash", async () => {
      const c = await client("down"); const prev = global.fetch;
      global.fetch = async (url, init) => (String(url).startsWith("https://api.stripe.com/") ? { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "No such price" } }) } : prev(url, init));
      try { const r = await c.call("POST", "/billing/checkout", { plan: "creator", period: "monthly" }); assert.equal(r.status, 502); assert.equal(r.json.code, "billing_error"); assert.ok(!/No such price/.test(JSON.stringify(r.json)), "provider detail isn't shown"); } finally { global.fetch = prev; }
    });
  });

  describe("what Stripe's events do", () => {
    test("an unsigned, wrongly signed or stale request changes nothing", async () => {
      const u = await mk("sig"); const body = JSON.stringify({ id: "evt_x", type: "checkout.session.completed", data: { object: checkoutDone(u, "agency", "monthly") } });
      for (const header of ["", "garbage", stripe.signPayload(body, "wrong"), stripe.signPayload(body, SECRET, Math.floor(Date.now() / 1000) - 7200)]) {
        const r = await realFetch(`${base}/billing/webhook`, { method: "POST", headers: { "Content-Type": "application/json", ...(header ? { "Stripe-Signature": header } : {}) }, body });
        assert.equal(r.status, 400, header);
      }
      assert.equal((await row(u.id)).plan, "free"); assert.equal((await pool.query("select count(*)::int n from stripe_events where id = 'evt_x'")).rows[0].n, 0);
    });
    test("a paid subscription checkout puts the account on that plan, and the page sees it", async () => {
      const c = await client("sub");
      const r = await send("checkout.session.completed", checkoutDone(c.user, "pro", "annual"));
      assert.equal(r.status, 200); assert.equal(r.json.handled, true);
      const u = await row(c.user.id);
      assert.equal(u.plan, "pro"); assert.equal(u.billing_period, "annual"); assert.equal(u.plan_status, "active"); assert.ok(u.stripe_customer_id && u.stripe_subscription_id);
      const me = (await c.call("GET", "/api/me")).json;
      assert.equal(me.plan.name, "pro"); assert.equal(me.limits.monthly_minutes, PLANS.pro.monthlyMinutes); assert.equal(me.billing.period, "annual"); assert.equal(me.billing.can_manage, true);
    });
    test("the same event twice is handled once; an unknown account or unknown plan is ignored without an error", async () => {
      const u = await mk("dup");
      const evt = checkoutDone(u, "creator", "monthly");
      const first = await send("checkout.session.completed", evt, { id: "evt_dup_1" });
      const second = await send("checkout.session.completed", evt, { id: "evt_dup_1" });
      assert.equal(first.json.handled, true); assert.equal(second.json.handled, false); assert.equal(second.json.reason, "duplicate"); assert.equal(second.status, 200);
      const ghost = await send("checkout.session.completed", { ...checkoutDone(u, "creator", "monthly"), client_reference_id: crypto.randomUUID(), metadata: { user_id: crypto.randomUUID(), plan: "creator", period: "monthly" }, customer: "cus_nobody" });
      assert.equal(ghost.status, 200);
      const odd = await mk("odd");
      await send("checkout.session.completed", checkoutDone(odd, "platinum", "monthly"));
      assert.equal((await row(odd.id)).plan, "free", "an unknown plan name never grants anything");
      assert.equal((await send("some.other.event", {})).json.reason, "ignored");
    });
    test("an event that fails is not remembered, so Stripe's retry is handled", async () => {
      const id = "evt_fail_1";
      await assert.rejects(() => service.applyEvent(pool, { id, type: "checkout.session.completed", data: { object: null } }));
      assert.equal((await pool.query("select count(*)::int n from stripe_events where id = $1", [id])).rows[0].n, 0);
      const r = await send("checkout.session.completed", { id: "cs_bad", mode: "subscription" }, { id });   // now well-formed enough to be ignored cleanly
      assert.equal(r.status, 200);
    });
    test("changing plan in the portal moves the account; cancelling keeps the plan until the period ends, then it falls to free", async () => {
      const c = await client("life");
      await send("checkout.session.completed", checkoutDone(c.user, "creator", "monthly"));
      await send("customer.subscription.updated", subscription(c.user, "agency", "annual"));
      let u = await row(c.user.id); assert.equal(u.plan, "agency"); assert.equal(u.billing_period, "annual"); assert.ok(u.plan_renews_at > new Date());
      await send("customer.subscription.updated", subscription(c.user, "agency", "annual", { cancel_at_period_end: true }));
      u = await row(c.user.id); assert.equal(u.plan, "agency", "paid through the period"); assert.equal(u.plan_status, "canceling");
      await send("invoice.payment_failed", { subscription: u.stripe_subscription_id });
      assert.equal((await row(c.user.id)).plan_status, "past_due"); assert.equal((await row(c.user.id)).plan, "agency", "Stripe retries the card first");
      await send("customer.subscription.deleted", subscription(c.user, "agency", "annual", { status: "canceled" }));
      u = await row(c.user.id); assert.equal(u.plan, "free"); assert.equal(u.plan_status, "canceled"); assert.equal(u.stripe_subscription_id, null); assert.equal(u.billing_period, null);
      assert.equal((await c.call("GET", "/api/me")).json.plan.name, "free");
      await send("customer.subscription.updated", subscription(c.user, "pro", "monthly", { status: "unpaid" }));   // a late event for a gone subscription
      assert.equal((await row(c.user.id)).plan, "free");
    });
    test("an unpaid subscription falls to free; an old subscription ending doesn't touch the new one", async () => {
      const c = await client("old");
      await send("checkout.session.completed", checkoutDone(c.user, "pro", "monthly"));
      await send("customer.subscription.deleted", { id: "sub_older", customer: `cus_${c.user.id.slice(0, 8)}`, status: "canceled" });
      assert.equal((await row(c.user.id)).plan, "pro", "a different subscription ended");
      await send("customer.subscription.updated", subscription(c.user, "pro", "monthly", { status: "unpaid" }));
      assert.equal((await row(c.user.id)).plan, "free");
    });
    test("accounts set by hand (no Stripe subscription) are never changed by Stripe events", async () => {
      const u = await mk("manual"); await accounts.setPlan(pool, u.id, "agency");
      await send("customer.subscription.deleted", { id: "sub_whatever", customer: "cus_whatever", status: "canceled" });
      await send("invoice.payment_failed", { subscription: "sub_whatever" });
      const after1 = await row(u.id); assert.equal(after1.plan, "agency"); assert.equal(after1.plan_status, null);
    });
  });

  describe("top-up packs", () => {
    test("a paid pack adds minutes once, even if Stripe sends it twice under different event ids; unpaid ones add nothing", async () => {
      const c = await client("pack");
      const s = { id: "cs_pack_1", mode: "payment", client_reference_id: c.user.id, customer: "cus_p", payment_status: "paid", metadata: { user_id: c.user.id, pack: "large" } };
      await send("checkout.session.completed", s); await send("checkout.session.async_payment_succeeded", s);
      assert.equal(await packs.remaining(pool, c.user.id), PACKS.large.minutes);
      await send("checkout.session.completed", { ...s, id: "cs_pack_2", payment_status: "unpaid", metadata: { user_id: c.user.id, pack: "small" } });
      assert.equal(await packs.remaining(pool, c.user.id), PACKS.large.minutes);
      await send("checkout.session.completed", { ...s, id: "cs_pack_3", metadata: { user_id: c.user.id, pack: "bogus" } });
      assert.equal(await packs.remaining(pool, c.user.id), PACKS.large.minutes, "an unknown pack adds nothing");
      const me = (await c.call("GET", "/api/me")).json; assert.equal(me.usage.pack_minutes, PACKS.large.minutes); assert.equal(me.billing.pack_minutes, PACKS.large.minutes);
      assert.equal((await pool.query("select count(*)::int n from information_schema.columns where table_name = 'credit_packs' and column_name = 'expires_at'")).rows[0].n, 0, "packs have no expiry at all");
    });
    test("pack minutes are used oldest pack first, only past the plan's minutes, never below zero, and never expire however old", async () => {
      const u = await mk("fifo"), plan = PLANS.free;
      const add = (minutes, yearsAgo) => pool.query("insert into credit_packs (user_id, pack, minutes, remaining, created_at, stripe_session_id) values ($1, 'small', $2, $2, now() - ($3 || ' years')::interval, $4)", [u.id, minutes, String(yearsAgo), `s_${crypto.randomUUID()}`]);
      await add(40, 0); await add(30, 5); await add(20, 2);
      assert.equal(await packs.remaining(pool, u.id), 90, "a five-year-old pack still counts in full");
      assert.equal(await packs.consumeOverage(pool, u.id, plan, 0, 3), 0, "inside the plan's minutes: packs untouched");
      assert.equal(await packs.consumeOverage(pool, u.id, plan, 4, 3), 2, "1 minute left in the plan, 2 come from packs");
      const rows = (await pool.query("select minutes::float m, remaining::float r from credit_packs where user_id = $1 order by created_at", [u.id])).rows.map((r) => `${r.m}:${r.r}`);
      assert.deepEqual(rows, ["30:28", "20:20", "40:40"], "the oldest pack was used first");
      assert.equal(await packs.consumeOverage(pool, u.id, plan, 50, 500), 88, "can't take more than there is");
      assert.equal(await packs.remaining(pool, u.id), 0);
    });
    test("with the plan's minutes used up, a pack lets a run start; with no pack left, it's refused and says so", async () => {
      const u = await mk("gate");
      await pool.query("insert into usage_events (owner_id, source_seconds, clips) values ($1, $2, 3)", [u.id, PLANS.free.monthlyMinutes * 60]);
      await assert.rejects(() => accounts.assertCanStart(pool, u.id), (e) => e.status === 402 && /top-up pack/.test(e.message));
      await packs.grant(pool, u.id, "small", "cs_gate_1");
      assert.ok(await accounts.assertCanStart(pool, u.id));
      await packs.consume(pool, u.id, PACKS.small.minutes);
      await assert.rejects(() => accounts.assertCanStart(pool, u.id), { code: "quota_exceeded" });
    });
    test("a finished run past the plan's minutes is charged to the pack, and one inside them is not", async () => {
      const u = await mk("charge"); await packs.grant(pool, u.id, "small", "cs_charge_1");
      const finish = async (seconds) => {
        const job = (await createRun(pool, { ownerId: u.id }, { personaId: "truckers", sourceUrl: `https://8.8.8.8/${crypto.randomUUID()}.mp4` })).job;
        await pool.query("update meme_builder_jobs set status = 'done', video_meta = $2 where id = $1", [job.id, JSON.stringify({ duration: seconds })]);
        await afterRun(pool, job.id, { log: { error() {}, warn() {}, log() {} } });
      };
      await finish(180);                                             // 3 minutes, inside the free plan's 5
      assert.equal(await packs.remaining(pool, u.id), PACKS.small.minutes);
      await finish(301);                                             // 6 minutes billed: 3 + 6 = 9, so 4 past the plan's 5
      assert.equal(await packs.remaining(pool, u.id), PACKS.small.minutes - 4);
    });
  });

  describe("packs are for subscribers only", () => {
    test("a free account is refused; an active subscriber, and a hand-set paid plan, are not; a cancelling or past-due one is refused", async () => {
      const free = await client("pk-free");
      const r = await free.call("POST", "/billing/checkout", { pack: "small" });
      assert.equal(r.status, 403); assert.equal(r.json.code, "subscribers_only"); assert.equal(stripeCalls.length, 0);
      assert.equal((await free.call("GET", "/api/billing")).json.current.can_buy_packs, false);

      const sub = await client("pk-sub"); await send("checkout.session.completed", checkoutDone(sub.user, "starter", "monthly"));
      assert.equal((await sub.call("POST", "/billing/checkout", { pack: "mini" })).status, 200);
      assert.equal((await sub.call("GET", "/api/billing")).json.current.can_buy_packs, true);

      const manual = await client("pk-manual"); await accounts.setPlan(pool, manual.user.id, "pro");
      assert.equal((await manual.call("POST", "/billing/checkout", { pack: "mini" })).status, 200, "a paid plan set by hand counts");

      await send("customer.subscription.updated", subscription(sub.user, "starter", "monthly", { cancel_at_period_end: true }));
      assert.equal((await sub.call("POST", "/billing/checkout", { pack: "mini" })).json.code, "subscribers_only", "on the way out");
      const late = await client("pk-late"); await send("checkout.session.completed", checkoutDone(late.user, "creator", "monthly"));
      await send("invoice.payment_failed", { subscription: `sub_${late.user.id.slice(0, 8)}` });
      assert.equal((await late.call("POST", "/billing/checkout", { pack: "mini" })).json.code, "subscribers_only", "past due");
    });
  });

  describe("cancelling locks the account, and a new subscription brings everything back", () => {
    const quiet = { error() {}, warn() {}, log() {} };
    const setup = async (label, plan = "creator") => {
      const c = await client(label);
      await send("checkout.session.completed", checkoutDone(c.user, plan, "monthly"));
      await packs.grant(pool, c.user.id, "large", `cs_${crypto.randomUUID()}`);
      const job = (await createRun(pool, { ownerId: c.user.id }, { personaId: "truckers", sourceUrl: `https://8.8.8.8/${crypto.randomUUID()}.mp4` })).job;
      await pool.query("update meme_builder_jobs set status = 'done' where id = $1", [job.id]);
      return { ...c, job };
    };
    const endIt = (c) => send("customer.subscription.deleted", subscription(c.user, "creator", "monthly", { status: "canceled" }));

    test("while locked: the account is on free, nothing of it can be reached, and its packs can't be seen or spent", async () => {
      const c = await setup("lock");
      assert.equal((await c.call("GET", "/api/jobs")).status, 200, "reachable while subscribed");
      await endIt(c);
      const u = await row(c.user.id);
      assert.equal(u.plan, "free"); assert.ok(u.locked_at, "locked");
      for (const [m, p] of [["GET", "/api/jobs"], ["GET", "/api/personas"], ["GET", "/api/videos"], ["GET", "/account/keys"], ["POST", "/account/keys"], ["DELETE", `/api/jobs/${c.job.id}`], ["POST", "/api/jobs"]]) {
        const r = await c.call(m, p, m === "POST" ? { name: "x" } : undefined);
        assert.equal(r.status, 402, `${m} ${p}`); assert.equal(r.json.code, "account_locked");
      }
      const me = (await c.call("GET", "/api/me")).json;
      assert.equal(me.signedIn, true); assert.equal(me.user.locked, true); assert.equal(me.billing.locked, true);
      assert.equal(me.usage.pack_minutes, 0, "its packs are not shown as usable"); assert.equal(me.billing.pack_minutes, 0);
      assert.equal(me.billing.saved.pack_minutes, PACKS.large.minutes, "but the reactivate screen can say they are saved"); assert.equal(me.billing.saved.runs, 1);
      assert.equal(await packs.remaining(pool, c.user.id), 0); assert.equal(await packs.consume(pool, c.user.id, 10), 0, "can't be spent");
      assert.equal((await pool.query("select remaining::float r from credit_packs where user_id = $1", [c.user.id])).rows[0].r, PACKS.large.minutes, "untouched");
      assert.equal((await pool.query("select count(*)::int n from meme_builder_jobs where id = $1", [c.job.id])).rows[0].n, 1, "the run is still stored");
      assert.equal((await c.call("GET", "/api/billing")).status, 200, "billing stays reachable, that's how they come back");
      assert.equal((await c.call("GET", "/api/billing")).json.current.can_buy_packs, false);
      assert.equal((await c.call("POST", "/billing/checkout", { pack: "small" })).json.code, "subscribers_only", "no packs without a subscription");
    });
    test("their API key and old playback links stop working too", async () => {
      const c = await setup("lock-api");
      const key = await require("../src/lib/keys").createKey(pool, { ownerId: c.user.id, name: "k" });
      const clip = await require("../src/lib/store").addClip(pool, c.job.id, "truckers", 1, { caption: "x", score: 5, why: "", transcript: "", emotion: "", startSec: 1, endSec: 5, storageUri: "file:///nonexistent", bytes: 1 }, null);
      const { signClip } = require("../src/signing"); const { exp, sig } = signClip(typeof clip === "string" ? clip : clip.id || clip, { ttlSec: 600 });
      const clipId = typeof clip === "string" ? clip : clip.id || clip;
      assert.equal((await realFetch(`${base}/v1/runs`, { headers: { Authorization: `Bearer ${key.key}` } })).status, 200, "works while subscribed");
      assert.notEqual((await realFetch(`${base}/v1/clips/${clipId}/video?exp=${exp}&sig=${sig}`)).status, 403, "a link is not refused while subscribed");
      await endIt(c);
      const api = await realFetch(`${base}/v1/runs`, { headers: { Authorization: `Bearer ${key.key}` } });
      assert.equal(api.status, 403); assert.equal((await api.json()).code, "account_locked");
      const link = await realFetch(`${base}/v1/clips/${clipId}/video?exp=${exp}&sig=${sig}`);
      assert.equal(link.status, 403); assert.equal((await link.json()).code, "account_locked");
    });
    test("an unpaid subscription locks the same way; a free account that never subscribed is never locked", async () => {
      const c = await setup("lock-unpaid");
      await send("customer.subscription.updated", subscription(c.user, "creator", "monthly", { status: "unpaid" }));
      assert.ok((await row(c.user.id)).locked_at);
      const never = await client("never"); await send("customer.subscription.deleted", { id: "sub_zzz", customer: "cus_zzz", status: "canceled" });
      assert.equal((await never.call("GET", "/api/jobs")).status, 200); assert.equal((await row(never.user.id)).locked_at, null);
    });
    test("a locked account's old runs survive the retention sweep; an unlocked free account's are removed", async () => {
      const { sweep } = require("../src/retention");
      const c = await setup("lock-sweep"); await endIt(c);
      const old = await client("sweep-old");
      const job = (await createRun(pool, { ownerId: old.user.id }, { personaId: "truckers", sourceUrl: `https://8.8.8.8/${crypto.randomUUID()}.mp4` })).job;
      for (const id of [job.id, c.job.id]) await pool.query("update meme_builder_jobs set status = 'done', created_at = now() - interval '400 days' where id = $1", [id]);
      await sweep(pool, { log: quiet });
      assert.equal((await pool.query("select count(*)::int n from meme_builder_jobs where id = $1", [c.job.id])).rows[0].n, 1, "locked: kept");
      assert.equal((await pool.query("select count(*)::int n from meme_builder_jobs where id = $1", [job.id])).rows[0].n, 0, "not locked and past its plan's days: removed");
    });
    test("subscribing again unlocks it, and the runs, clips and packs are all still there", async () => {
      const c = await setup("lock-back");
      await endIt(c);
      assert.equal((await c.call("GET", "/api/jobs")).status, 402);
      await send("checkout.session.completed", { ...checkoutDone(c.user, "pro", "annual"), id: `cs_${crypto.randomUUID().slice(0, 8)}`, subscription: `sub_again_${c.user.id.slice(0, 6)}` });
      const u = await row(c.user.id); assert.equal(u.plan, "pro"); assert.equal(u.locked_at, null);
      const jobs = await c.call("GET", "/api/jobs"); assert.equal(jobs.status, 200); assert.ok(jobs.json.jobs.some((j) => j.id === c.job.id), "the old run is back");
      const me = (await c.call("GET", "/api/me")).json; assert.equal(me.user.locked, false); assert.equal(me.usage.pack_minutes, PACKS.large.minutes, "and so are the pack minutes");
      assert.equal((await c.call("POST", "/billing/checkout", { pack: "small" })).status, 200, "and packs can be bought again");
    });
    test("an admin setting a paid plan by hand unlocks the account too", async () => {
      const c = await setup("lock-admin"); await endIt(c);
      assert.ok((await row(c.user.id)).locked_at);
      await accounts.setPlan(pool, c.user.id, "free"); assert.ok((await row(c.user.id)).locked_at, "free keeps it locked");
      await accounts.setPlan(pool, c.user.id, "starter"); assert.equal((await row(c.user.id)).locked_at, null);
    });
  });

  describe("cancelling: the offer to stay, then cancel and resume", () => {
    const invoice = (u, reason, id = `in_${crypto.randomUUID().slice(0, 8)}`) => ({ id, subscription: `sub_${u.id.slice(0, 8)}`, billing_reason: reason });
    test("a monthly subscriber is offered their plan's pack; annual, free and hand-set accounts are not", async () => {
      const m = await client("of-m"); await send("checkout.session.completed", checkoutDone(m.user, "creator", "monthly"));
      const st = (await m.call("GET", "/api/billing")).json.current;
      assert.deepEqual(st.offer, { pack: PLANS.creator.retentionPack, label: PACKS[PLANS.creator.retentionPack].label, minutes: PACKS[PLANS.creator.retentionPack].minutes });
      const a = await client("of-a"); await send("checkout.session.completed", checkoutDone(a.user, "creator", "annual"));
      assert.equal((await a.call("GET", "/api/billing")).json.current.offer, null, "annual: nothing to stay one more month for");
      assert.equal((await (await client("of-f")).call("GET", "/api/billing")).json.current.offer, null);
      const h = await client("of-h"); await accounts.setPlan(pool, h.user.id, "pro");
      assert.equal((await h.call("GET", "/api/billing")).json.current.offer, null, "no Stripe subscription, nothing to cancel here");
    });
    test("every plan's offer is a real pack no bigger than a quarter of that plan's monthly minutes", () => {
      for (const n of paidPlanNames()) {
        const p = PLANS[n], pack = PACKS[p.retentionPack];
        assert.ok(pack, `${n} names a real pack`);
        assert.ok(pack.minutes <= p.monthlyMinutes * 0.25, `${n}: ${pack.minutes} minutes is at most a quarter of ${p.monthlyMinutes}`);
      }
      assert.equal(PLANS.free.retentionPack, null);
    });
    test("accepting promises the pack but adds nothing yet; it arrives with the next monthly payment, once", async () => {
      const c = await client("of-acc"); await send("checkout.session.completed", checkoutDone(c.user, "creator", "monthly"));
      const r = await c.call("POST", "/billing/offer/accept");
      assert.equal(r.status, 200); const key = r.json.pack; assert.equal(key, PLANS.creator.retentionPack);
      assert.equal(await packs.remaining(pool, c.user.id), 0, "nothing yet: staying is what earns it");
      let st = (await c.call("GET", "/api/billing")).json.current; assert.equal(st.offer, null); assert.equal(st.offer_pending.minutes, PACKS[key].minutes);
      assert.equal((await c.call("POST", "/billing/offer/accept")).status, 409, "not twice");
      await send("invoice.paid", invoice(c.user, "subscription_update"));
      assert.equal(await packs.remaining(pool, c.user.id), 0, "a plan change isn't a renewal");
      const inv = invoice(c.user, "subscription_cycle");
      await send("invoice.paid", inv); await send("invoice.paid", inv, { id: "evt_again_" + inv.id });
      assert.equal(await packs.remaining(pool, c.user.id), PACKS[key].minutes, "added once, even if the invoice is reported twice");
      st = (await c.call("GET", "/api/billing")).json.current; assert.equal(st.offer_pending, null); assert.equal(st.offer, null, "and not offered again for a long while");
      await send("invoice.paid", invoice(c.user, "subscription_cycle"));
      assert.equal(await packs.remaining(pool, c.user.id), PACKS[key].minutes, "the next renewal adds nothing more");
    });
    test("the offer comes back after six months, not before", async () => {
      const c = await client("of-cool"); await send("checkout.session.completed", checkoutDone(c.user, "creator", "monthly"));
      await c.call("POST", "/billing/offer/accept"); await send("invoice.paid", invoice(c.user, "subscription_cycle"));
      assert.equal((await c.call("GET", "/api/billing")).json.current.offer, null);
      await pool.query("update users set retention_offer_used_at = now() - interval '200 days' where id = $1", [c.user.id]);
      assert.ok((await c.call("GET", "/api/billing")).json.current.offer, "eligible again");
    });
    test("cancelling tells Stripe to stop at the period's end, keeps the plan until then, withdraws a pending offer, and earns no pack", async () => {
      const c = await client("of-cancel"); await send("checkout.session.completed", checkoutDone(c.user, "creator", "monthly"));
      await c.call("POST", "/billing/offer/accept");
      stripeCalls.length = 0;
      const r = await c.call("POST", "/billing/cancel");
      assert.equal(r.status, 200);
      assert.equal(stripeCalls.length, 1); assert.ok(stripeCalls[0].url.endsWith(`/v1/subscriptions/sub_${c.user.id.slice(0, 8)}`)); assert.equal(stripeCalls[0].params.cancel_at_period_end, "true");
      const u = await row(c.user.id); assert.equal(u.plan, "creator", "still theirs until the period ends"); assert.equal(u.plan_status, "canceling"); assert.equal(u.retention_offer_pack, null); assert.equal(u.locked_at, null);
      await send("invoice.paid", invoice(c.user, "subscription_cycle"));
      assert.equal(await packs.remaining(pool, c.user.id), 0, "no pack for someone who cancelled");
      assert.equal((await c.call("POST", "/billing/cancel")).status, 200, "cancelling twice is harmless");
      await send("customer.subscription.deleted", subscription(c.user, "creator", "monthly", { status: "canceled" }));
      assert.ok((await row(c.user.id)).locked_at, "and when the period ends the account locks");
    });
    test("resuming before the period ends puts it back to normal", async () => {
      const c = await client("of-resume"); await send("checkout.session.completed", checkoutDone(c.user, "pro", "monthly"));
      assert.equal((await c.call("POST", "/billing/resume")).status, 409, "nothing to resume yet");
      await c.call("POST", "/billing/cancel"); stripeCalls.length = 0;
      assert.equal((await c.call("POST", "/billing/resume")).status, 200);
      assert.equal(stripeCalls[0].params.cancel_at_period_end, "false");
      const u = await row(c.user.id); assert.equal(u.plan_status, "active"); assert.equal(u.plan, "pro");
    });
    test("there has to be a subscription to cancel", async () => {
      const f = await client("of-none"); assert.equal((await f.call("POST", "/billing/cancel")).json.code, "no_subscription");
      const h = await client("of-hand"); await accounts.setPlan(pool, h.user.id, "agency"); assert.equal((await h.call("POST", "/billing/cancel")).status, 409);
      assert.equal(stripeCalls.length, 0);
    });
  });

});
