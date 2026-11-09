"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const funding = require("../src/funding");
const ai = require("../src/lib/ai");

const realFetch = global.fetch;
const KEYS = ["GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "KIE_API_KEY", "MEME_BUILDER_TEXT_MODELS", "MEME_BUILDER_VIDEO_MODELS"];
const withAi = async (fn) => {
  const keep = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { GOOGLE_API_KEY: "g", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", MEME_BUILDER_TEXT_MODELS: "google:gem-test,anthropic:claude-test" });
  ai.resetModelHealth();
  const errors = []; const realError = console.error; console.error = (...a) => errors.push(a.join(" "));
  try { return await fn(errors); } finally { console.error = realError; global.fetch = realFetch; ai.resetModelHealth(); for (const k of KEYS) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } }
};
const reply = (status, body) => ({ status, ok: status < 400, headers: new Map(), text: async () => JSON.stringify(body) });

describe("choosing auto-reload settings (no database)", () => {
  test("reload below ~3 days of spend, add ~7 days, stop automatic reloads at 1.5x a month; whole multiples of $5, never under $5", () => {
    assert.deepEqual(funding.suggest(10), { reload_when_below: 30, reload_amount: 70, monthly_auto_reload_limit: 450 });
    assert.deepEqual(funding.suggest(0.2), { reload_when_below: 5, reload_amount: 5, monthly_auto_reload_limit: 10 }, "tiny spend still respects the $5 minimum");
    assert.equal(funding.suggest(0), null); assert.equal(funding.suggest(-1), null); assert.equal(funding.suggest(NaN), null);
    const s = funding.suggest(3.37); for (const v of Object.values(s)) assert.equal(v % 5, 0);
    assert.ok(funding.suggest(5, 300).monthly_auto_reload_limit >= 450, "a busy month raises the limit");
  });
});

describe("a provider with an empty balance (no database)", () => {
  test("HTTP 402 from any provider means out of credit, so the request moves on to the next provider", async () => {
    for (const [first, second, body] of [
      ["google:gem-test", "anthropic:claude-test", { error: { message: "Payment required", status: "FAILED_PRECONDITION" } }],
      ["anthropic:claude-test", "google:gem-test", { type: "error", error: { type: "billing_error", message: "Your credit balance is too low" } }],
    ]) {
      await withAi(async () => {
        process.env.MEME_BUILDER_TEXT_MODELS = `${first},${second}`;
        global.fetch = async (url) => (String(url).includes(first.split(":")[0] === "google" ? "googleapis" : "anthropic") ? reply(402, body) : String(url).includes("anthropic") ? reply(200, { content: [{ type: "text", text: "from anthropic" }], usage: {} }) : reply(200, { candidates: [{ content: { parts: [{ text: "from google" }] } }] }));
        const out = await ai.chat({ messages: [{ role: "user", content: "hi" }] });
        assert.match(out, /^from /, `${first} was empty, the next one answered`);
      });
    }
  });
  test("it is set aside for a few minutes and logged once, so later requests don't try it first; it comes back when health is reset", async () => {
    await withAi(async (errors) => {
      let googleCalls = 0, claudeCalls = 0;
      global.fetch = async (url) => {
        if (String(url).includes("googleapis")) { googleCalls++; return reply(402, { error: { message: "Payment required" } }); }
        claudeCalls++; return reply(200, { content: [{ type: "text", text: "ok" }], usage: {} });
      };
      for (let i = 0; i < 3; i++) assert.equal(await ai.chat({ messages: [{ role: "user", content: "hi" }] }), "ok");
      assert.equal(googleCalls, 1, "tried once, then skipped"); assert.equal(claudeCalls, 3);
      assert.equal(errors.filter((e) => e.includes("[funding]")).length, 1, "said once");
      assert.match(errors[0], /google is out of credit/);
      ai.resetModelHealth(); await ai.chat({ messages: [{ role: "user", content: "hi" }] });
      assert.equal(googleCalls, 2, "tried again after a reset (as it would after the window)");
    });
  });
  test("if every provider is empty the person gets a plain message, not a crash", async () => {
    await withAi(async () => {
      global.fetch = async () => reply(402, { error: { message: "Payment required" } });
      await assert.rejects(() => ai.chat({ messages: [{ role: "user", content: "hi" }] }), (e) => e.code === "out_of_credit" && /run out of credit/.test(ai.friendlyMessage(e)));
    });
  });
});

const DB = process.env.DATABASE_URL_TEST;
describe("the funding report against a real database", { skip: !DB && "DATABASE_URL_TEST is not set" }, () => {
  const { Pool } = require("pg");
  const accounts = require("../src/accounts");
  const { migrate } = require("../src/migrate");
  let pool;
  before(async () => {
    pool = new Pool({ connectionString: DB, ssl: /\/tmp\/|localhost|127\.0\.0\.1/.test(DB) ? false : { rejectUnauthorized: false } });
    await migrate(pool);
    await pool.query("truncate usage_events, model_usage, credit_packs, sessions, users, meme_builder_jobs cascade");
  });
  after(async () => { await pool.end(); });

  test("spend per provider, measured cost per minute, what is owed, suggested settings, and an alert for an empty balance", async () => {
    const mk = async (label, plan) => { const u = await accounts.signup(pool, { email: `${label}-${crypto.randomUUID().slice(0, 6)}@example.com`, password: "a-long-enough-password" }); if (plan) await accounts.setPlan(pool, u.id, plan); return u; };
    const a = await mk("a", "creator"), b = await mk("b", "pro");
    await pool.query("update users set stripe_subscription_id = 'sub_a', billing_period = 'monthly', plan_status = 'active' where id = $1", [a.id]);
    await pool.query("update users set stripe_subscription_id = 'sub_b', billing_period = 'annual', plan_status = 'active' where id = $1", [b.id]);
    await pool.query("insert into credit_packs (user_id, pack, minutes, remaining, stripe_session_id) values ($1, 'small', 50, 30, 'cs_f1'), ($1, 'mini', 20, 20, 'cs_f2')", [a.id]);
    // 110 source minutes in the last 7 days (6600 seconds)
    await pool.query("insert into usage_events (owner_id, source_seconds, clips) values ($1, 3600, 10), ($1, 2400, 6), ($1, 600, 2)", [a.id]);
    const use = (provider, model, cost, ok = true, error = null, daysAgo = 1) => pool.query(
      "insert into model_usage (owner_id, provider, model, input_tokens, output_tokens, cost_usd, ok, error, created_at) values ($1, $2, $3, 1000, 100, $4, $5, $6, now() - ($7 || ' days')::interval)", [a.id, provider, model, cost, ok, error, String(daysAgo)]);
    await use("google", "flash", 2.1); await use("google", "flash", 0.7); await use("anthropic", "claude", 1.4); await use("anthropic", "claude", 5, true, null, 20);
    await use("openai", "gpt", null, false, "openai: gpt: the account is out of credit (x)", 0);

    const r = await funding.report(pool);
    assert.equal(r.minutes.last7, 110); assert.equal(r.minutes.last30, 110);
    const g = r.providers.find((p) => p.provider === "google"), c = r.providers.find((p) => p.provider === "anthropic");
    assert.equal(g.last30.cost, 2.8); assert.equal(g.last7.calls, 2);
    assert.equal(c.last7.cost, 1.4); assert.equal(c.last30.cost, 6.4, "the older call counts in 30 days, not in 7");
    assert.deepEqual(g.suggestion, funding.suggest(2.8 / 7, 2.8));
    assert.equal(r.ai_cost.last7, null, "a provider's calls aren't all priced (the failed openai call), so no total is claimed");
    assert.equal(r.owed.topup_minutes_outstanding, 50);
    assert.equal(r.owed.monthly_recurring_revenue, 30 + 76.5, "a monthly Creator, plus an annual Pro counted at its monthly equivalent");
    assert.deepEqual(r.out_of_credit_last_day.map((e) => e.provider), ["openai"]);
    const lines = []; funding.print(r, (l) => lines.push(l));
    assert.ok(lines.some((l) => /ALERT: openai/.test(l)) && lines.some((l) => /suggested auto-reload/.test(l)) && lines.some((l) => /top-up minutes unused/.test(l)));
  });
  test("with every call priced, the report states the cost per source minute", async () => {
    await pool.query("delete from model_usage where cost_usd is null");
    const r = await funding.report(pool);
    assert.equal(r.ai_cost.last30, 9.2); assert.equal(r.cost_per_source_minute, 0.0836, "9.20 over 110 minutes");
  });
  test("an empty system reports zeros and no suggestions without failing", async () => {
    await pool.query("truncate usage_events, model_usage, credit_packs, sessions, users, meme_builder_jobs cascade");
    const r = await funding.report(pool);
    assert.equal(r.minutes.last30, 0); assert.equal(r.cost_per_source_minute, null); assert.deepEqual(r.providers, []);
    funding.print(r, () => {});
  });
});
