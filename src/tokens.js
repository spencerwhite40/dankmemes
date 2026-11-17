"use strict";
// One-time links by email: a random token, stored only as a hash, with an expiry, usable once.
const crypto = require("node:crypto");

const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
const TTL_HOURS = { verify: 72, reset: 1, email_change: 24 };
const ONE_AT_A_TIME = new Set(["reset", "email_change"]);   // a newer link cancels the older unused ones

/** A fresh token for a user. payload is an optional value the token confirms (an email change's new address). */
async function create(pool, userId, purpose, { payload = null } = {}) {
  if (!TTL_HOURS[purpose]) throw new Error(`unknown token purpose ${purpose}`);
  const token = crypto.randomBytes(32).toString("base64url");
  if (ONE_AT_A_TIME.has(purpose)) await pool.query("update auth_tokens set used_at = now() where user_id = $1 and purpose = $2 and used_at is null", [userId, purpose]);
  await pool.query("insert into auth_tokens (token_hash, user_id, purpose, payload, expires_at) values ($1, $2, $3, $4, now() + ($5 || ' hours')::interval)", [sha(token), userId, purpose, payload, String(TTL_HOURS[purpose])]);
  return token;
}

/** Uses a token (marks it used, in one step): { userId, payload } if it is right, unexpired and unused, else null. */
async function consumeRow(pool, token, purpose) {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  const { rows } = await pool.query(
    "update auth_tokens set used_at = now() where token_hash = $1 and purpose = $2 and used_at is null and expires_at > now() returning user_id, payload",
    [sha(token), purpose],
  );
  return rows[0] ? { userId: rows[0].user_id, payload: rows[0].payload } : null;
}
/** The user id only (see consumeRow). */
async function consume(pool, token, purpose) { const r = await consumeRow(pool, token, purpose); return r ? r.userId : null; }

module.exports = { create, consume, consumeRow, TTL_HOURS };
