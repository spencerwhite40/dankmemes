"use strict";
// Records every model call (tokens in/out/cached, time, ok or not) against the account and run that caused it.
// The caller's identity travels with the work (AsyncLocalStorage), so the pipeline code doesn't have to pass it around.
// Prices are optional config (MODEL_PRICES_JSON or MODEL_PRICES_FILE), never built in: cost is filled in only when a price is known.
const fs = require("node:fs");
const { AsyncLocalStorage } = require("node:async_hooks");

const als = new AsyncLocalStorage();
let pool = null;
let pricesCache = null;

const setPool = (p) => { pool = p; };
const runWithContext = (ctx, fn) => als.run({ ...ctx }, fn);
const getContext = () => als.getStore() || null;
/** Which step of the run is spending (the pipeline calls this as it moves on). */
const setStage = (stage) => { const c = als.getStore(); if (c) c.stage = stage; };

function loadPrices() {
  if (pricesCache) return pricesCache;
  try {
    if (process.env.MODEL_PRICES_JSON) pricesCache = JSON.parse(process.env.MODEL_PRICES_JSON);
    else if (process.env.MODEL_PRICES_FILE) pricesCache = JSON.parse(fs.readFileSync(process.env.MODEL_PRICES_FILE, "utf8"));
  } catch (e) { console.error("[ledger] model prices could not be read:", e.message); }
  return (pricesCache = pricesCache || {});
}
const resetPrices = () => { pricesCache = null; };

/**
 * Cost in dollars when a price is configured for this model ({"google:gemini-x": {"input": 0.3, "output": 2.5, "cached_input": 0.075}},
 * all per million tokens), otherwise null. Pure apart from reading the config.
 */
function costOf(provider, model, u) {
  const p = loadPrices()[`${provider}:${model}`];
  if (!p || typeof p.input !== "number" || typeof p.output !== "number") return null;
  const cached = u.cached || 0;
  const freshInput = Math.max(0, (u.input || 0) - cached);
  const cachedRate = typeof p.cached_input === "number" ? p.cached_input : p.input;
  return (freshInput * p.input + cached * cachedRate + (u.output || 0) * p.output) / 1e6;
}

/** Never throws and never delays the caller more than the insert. */
async function record(entry) {
  if (!pool) return;
  const ctx = getContext() || {};
  const u = entry.usage || {};
  try {
    await pool.query(
      `insert into model_usage (owner_id, job_id, stage, provider, model, kind, input_tokens, output_tokens, cached_tokens, cost_usd, latency_ms, ok, error)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [ctx.ownerId || "unknown", ctx.jobId || null, ctx.stage || null, entry.provider, entry.model, entry.kind || "text",
        u.input || 0, u.output || 0, u.cached || 0, entry.ok ? costOf(entry.provider, entry.model, u) : null, entry.latencyMs || null, !!entry.ok, entry.error ? String(entry.error).slice(0, 300) : null],
    );
  } catch (e) { console.error("[ledger]", e && e.message); }
}

/** Totals by model for one owner since a date (default: start of this UTC month). */
async function summary(db, ownerId, since) {
  const { rows } = await db.query(
    `select provider, model, count(*) filter (where ok)::int as calls, count(*) filter (where not ok)::int as failures,
            coalesce(sum(input_tokens), 0)::bigint as input_tokens, coalesce(sum(output_tokens), 0)::bigint as output_tokens,
            coalesce(sum(cached_tokens), 0)::bigint as cached_tokens, sum(cost_usd) as cost_usd
       from model_usage where owner_id = $1 and created_at >= coalesce($2::timestamptz, date_trunc('month', now() at time zone 'utc') at time zone 'utc')
      group by provider, model order by 3 desc`,
    [ownerId, since || null],
  );
  return rows.map((r) => ({ provider: r.provider, model: r.model, calls: r.calls, failures: r.failures, input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens), cached_tokens: Number(r.cached_tokens), cost_usd: r.cost_usd == null ? null : Number(r.cost_usd) }));
}

module.exports = { setPool, runWithContext, getContext, setStage, record, costOf, summary, resetPrices };
