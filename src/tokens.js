"use strict";
// One-time links by email: a random token, stored only as a hash, with an expiry, usable once.
const crypto = require("node:crypto");

const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
const TTL_HOURS = { verify: 72, reset: 1 };

/** A fresh token for a user. A new reset link cancels the earlier unused ones, so only the latest works. */
async function create(pool, userId, purpose) {
  if (!TTL_HOURS[purpose]) throw new Error(`unknown token purpose ${purpose}`);
  const token = crypto.randomBytes(32).toString("base64url");
  if (purpose === "reset") await pool.query("update auth_tokens set used_at = now() where user_id = $1 and purpose = 'reset' and used_at is null", [userId]);
  await pool.query("insert into auth_tokens (token_hash, user_id, purpose, expires_at) values ($1, $2, $3, now() + ($4 || ' hours')::interval)", [sha(token), userId, purpose, String(TTL_HOURS[purpose])]);
  return token;
}

/** Uses a token: returns the user id if it is right, unexpired and unused (and marks it used, in one step), else null. */
async function consume(pool, token, purpose) {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  const { rows } = await pool.query(
    "update auth_tokens set used_at = now() where token_hash = $1 and purpose = $2 and used_at is null and expires_at > now() returning user_id",
    [sha(token), purpose],
  );
  return rows[0] ? rows[0].user_id : null;
}

module.exports = { create, consume, TTL_HOURS };
