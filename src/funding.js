"use strict";
// What the AI providers have cost, what is owed to customers, and how much to keep loaded with each provider.
// The providers are paid in advance (prepaid credits, topped up automatically when low), so the question is never "how much
// do we owe" but "how much should each balance hold". This reads the usage ledger and answers it from real spend.
// Costs need prices (MODEL_PRICES_JSON or MODEL_PRICES_FILE); without them the report shows tokens and says so.
const { PLANS } = require("./plans");

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const upTo5 = (n) => Math.max(5, Math.ceil(n / 5) * 5);

/**
 * How to set a provider's auto-reload from its average daily spend (dollars):
 *   reload when the balance falls below ~3 days of spend, add ~7 days of spend each time,
 *   and stop automatic reloads at ~1.5x a normal month, so a runaway bug or abuse can't drain the card.
 * Whole dollars, multiples of 5, never under 5 (the providers' smallest purchase).
 */
function suggest(dailySpend, monthlySpend = dailySpend * 30) {
  if (!(dailySpend > 0)) return null;
  return { reload_when_below: upTo5(dailySpend * 3), reload_amount: upTo5(dailySpend * 7), monthly_auto_reload_limit: upTo5(Math.max(monthlySpend, dailySpend * 30) * 1.5) };
}

async function report(pool) {
  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  const minutes = async (days) => Number((await q("select coalesce(sum(source_seconds), 0) / 60 as m from usage_events where created_at > now() - ($1 || ' days')::interval", [String(days)]))[0].m);
  const spend = (days) => q(
    `select provider, count(*) filter (where ok)::int as calls, count(*) filter (where not ok)::int as failures,
            coalesce(sum(input_tokens), 0)::bigint as input_tokens, coalesce(sum(output_tokens), 0)::bigint as output_tokens,
            sum(cost_usd) as cost, count(*) filter (where cost_usd is not null)::int as priced
       from model_usage where created_at > now() - ($1 || ' days')::interval group by provider order by provider`, [String(days)]);
  const shape = (rows) => rows.map((r) => ({ provider: r.provider, calls: r.calls, failures: r.failures, input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens), cost: r.cost == null ? null : Number(r.cost), all_priced: r.priced === r.calls + r.failures }));

  const [m7, m30, s7, s30] = [await minutes(7), await minutes(30), shape(await spend(7)), shape(await spend(30))];
  const total = (rows) => (rows.length && rows.every((r) => r.cost != null) ? rows.reduce((a, r) => a + r.cost, 0) : null);
  const t7 = total(s7), t30 = total(s30);

  const providers = s30.map((p30) => {
    const p7 = s7.find((p) => p.provider === p30.provider);
    const daily = p7 && p7.cost != null ? p7.cost / 7 : null;
    return { provider: p30.provider, last7: p7 || null, last30: p30, suggestion: daily == null ? null : suggest(daily, p30.cost == null ? daily * 30 : p30.cost) };
  });

  // money already taken that still has to be served: top-up minutes bought and not used
  const packs = Number((await q("select coalesce(sum(remaining), 0) as n from credit_packs where remaining > 0"))[0].n);
  const subs = await q("select plan, billing_period, count(*)::int as n from users where plan <> 'free' and stripe_subscription_id is not null and locked_at is null group by plan, billing_period");
  const mrr = subs.reduce((a, r) => a + r.n * (r.billing_period === "annual" ? PLANS[r.plan].priceAnnual : PLANS[r.plan].priceMonthly), 0);

  // providers that refused work because their balance was empty, in the last day
  const empty = await q("select provider, count(*)::int as n, max(created_at) as last from model_usage where not ok and (error ilike '%out of credit%' or error ilike '%prepaid balance is empty%') group by provider having max(created_at) > now() - interval '1 day'");

  return {
    minutes: { last7: round(m7, 1), last30: round(m30, 1) },
    ai_cost: { last7: t7 == null ? null : round(t7), last30: t30 == null ? null : round(t30) },
    cost_per_source_minute: t30 != null && m30 > 0 ? round(t30 / m30, 4) : null,
    providers,
    owed: { topup_minutes_outstanding: round(packs, 1), subscribers: subs, monthly_recurring_revenue: round(mrr) },
    out_of_credit_last_day: empty.map((r) => ({ provider: r.provider, failures: r.n, last: r.last })),
  };
}

function print(r, log = console.log) {
  const $ = (n) => (n == null ? "n/a" : `$${n.toFixed(2)}`);
  log(`Source minutes processed: ${r.minutes.last7} in 7 days, ${r.minutes.last30} in 30 days`);
  log(`AI cost: ${$(r.ai_cost.last7)} in 7 days, ${$(r.ai_cost.last30)} in 30 days` + (r.ai_cost.last30 == null ? "   (no prices configured: set MODEL_PRICES_JSON or MODEL_PRICES_FILE to see dollars)" : ""));
  if (r.cost_per_source_minute != null) log(`Measured cost per source minute: $${r.cost_per_source_minute}   <- compare with the pricing assumptions`);
  log("");
  for (const p of r.providers) {
    log(`${p.provider}: ${p.last30.calls} calls (${p.last30.failures} failed) in 30 days, ${p.last30.input_tokens} in / ${p.last30.output_tokens} out tokens, cost ${$(p.last30.cost)}`);
    if (p.suggestion) log(`   suggested auto-reload: when balance < $${p.suggestion.reload_when_below}, add $${p.suggestion.reload_amount}, monthly auto-reload limit $${p.suggestion.monthly_auto_reload_limit}`);
  }
  log("");
  log(`Owed to customers: ${r.owed.topup_minutes_outstanding} top-up minutes unused. Paying subscribers: ${r.owed.subscribers.map((s) => `${s.n} ${s.plan} (${s.billing_period})`).join(", ") || "none"}. Monthly recurring revenue: $${r.owed.monthly_recurring_revenue}`);
  for (const e of r.out_of_credit_last_day) log(`ALERT: ${e.provider} refused ${e.failures} request(s) in the last day because its balance was empty (last at ${new Date(e.last).toISOString()}). Top it up now.`);
}

module.exports = { report, print, suggest };
