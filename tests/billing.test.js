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
  test("a pack always costs more per minute than any plan, annual included", () => {
    const cheapestPlanRate = Math.min(...paidPlanNames().flatMap((n) => [PLANS[n].priceMonthly, PLANS[n].priceAnnual].map((p) => p / PLANS[n].monthlyMinutes)));
    for (const [k, p] of Object.entries(PACKS)) assert.ok(p.price / p.minutes > PLANS.creator.priceMonthly / PLANS.creator.monthlyMinutes, `${k} is dearer per minute than Creator monthly`);
    assert.ok(Object.values(PACKS).every((p) => p.price / p.minutes > cheapestPlanRate));
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
      assert.deepEqual(info.json.plans.map((p) => p.name), ["creator", "pro", "agency"]);
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
      assert.equal((await pool.query("select expires_at > now() + interval '11 months' as ok from credit_packs where user_id = $1", [c.user.id])).rows[0].ok, true, "lasts about a year");
    });
    test("pack minutes are used oldest-expiring first, only past the plan's minutes, and never below zero; expired packs don't count", async () => {
      const u = await mk("fifo"), plan = PLANS.free;
      const add = (pack, minutes, remaining, days) => pool.query("insert into credit_packs (user_id, pack, minutes, remaining, expires_at, stripe_session_id) values ($1, $2, $3, $4, now() + ($5 || ' days')::interval, $6)", [u.id, pack, minutes, remaining, String(days), `s_${crypto.randomUUID()}`]);
      await add("small", 40, 40, 100); await add("small", 40, 40, 10); await add("small", 40, 40, -5);
      assert.equal(await packs.remaining(pool, u.id), 80, "the expired one isn't counted");
      assert.equal(await packs.consumeOverage(pool, u.id, plan, 0, 3), 0, "inside the plan's minutes: packs untouched");
      assert.equal(await packs.consumeOverage(pool, u.id, plan, 4, 3), 2, "1 minute left in the plan, 2 come from packs");
      const rows = (await pool.query("select remaining::float r from credit_packs where user_id = $1 order by expires_at", [u.id])).rows.map((r) => r.r);
      assert.deepEqual(rows, [40, 38, 40], "the pack expiring in 10 days was used first (the expired one is skipped)");
      assert.equal(await packs.consumeOverage(pool, u.id, plan, 50, 100), 78, "can't take more than there is");
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
});
