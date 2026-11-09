"use strict";
// Top-up minutes. A pack is bought once, lasts PACK_MONTHS months, and is used only after the plan's monthly minutes are gone.
const { PACKS, PACK_MONTHS } = require("../plans");

async function remaining(pool, userId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(userId || ""))) return 0;   // owners with no account (the old "default") have no packs
  const { rows } = await pool.query("select coalesce(sum(remaining), 0) as n from credit_packs where user_id = $1 and remaining > 0 and expires_at > now()", [userId]);
  return Number(rows[0].n);
}

/** Adds a pack for a paid checkout. The Stripe session id makes it safe to receive twice. Returns true if it was new. */
async function grant(pool, userId, packKey, stripeSessionId) {
  const pack = PACKS[packKey];
  if (!pack) return false;
  const { rowCount } = await pool.query(
    `insert into credit_packs (user_id, pack, minutes, remaining, stripe_session_id, expires_at)
     values ($1, $2, $3, $3, $4, now() + ($5 || ' months')::interval) on conflict (stripe_session_id) do nothing`,
    [userId, packKey, pack.minutes, stripeSessionId, String(PACK_MONTHS)],
  );
  return rowCount === 1;
}

/** Takes minutes off the packs, the ones that expire first going first. Never goes below zero. */
async function consume(pool, userId, minutes) {
  let left = Number(minutes);
  if (!(left > 0)) return 0;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query("select id, remaining from credit_packs where user_id = $1 and remaining > 0 and expires_at > now() order by expires_at, created_at for update", [userId]);
    for (const r of rows) {
      if (left <= 0) break;
      const take = Math.min(Number(r.remaining), left);
      await client.query("update credit_packs set remaining = remaining - $2 where id = $1", [r.id, take]);
      left -= take;
    }
    await client.query("commit");
  } catch (e) { await client.query("rollback").catch(() => {}); throw e; } finally { client.release(); }
  return Number(minutes) - Math.max(0, left);
}

/**
 * A finished run used runMinutes. Whatever part of it went past the plan's monthly minutes comes out of the packs.
 * usedBefore is the month's usage before this run was counted.
 */
async function consumeOverage(pool, userId, plan, usedBefore, runMinutes) {
  const allowanceLeft = Math.max(0, plan.monthlyMinutes - Number(usedBefore));
  const over = Math.max(0, Number(runMinutes) - allowanceLeft);
  return over > 0 ? consume(pool, userId, over) : 0;
}

module.exports = { remaining, grant, consume, consumeOverage };
