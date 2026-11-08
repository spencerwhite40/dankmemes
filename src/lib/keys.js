"use strict";
// API keys and usage. A key is shown once at creation; only its SHA-256 hash is stored.
const crypto = require("node:crypto");

const hashKey = (key) => crypto.createHash("sha256").update(String(key)).digest("hex");
const newKey = () => `mk_live_${crypto.randomBytes(24).toString("base64url")}`;
const isKeyShaped = (t) => /^mk_live_[A-Za-z0-9_-]{20,}$/.test(String(t || ""));

const publicRow = (r) => ({
  id: r.id, owner_id: r.owner_id, name: r.name, key_prefix: r.key_prefix, rate_limit_per_min: r.rate_limit_per_min,
  monthly_minutes_quota: r.monthly_minutes_quota == null ? null : Number(r.monthly_minutes_quota),
  created_at: r.created_at, last_used_at: r.last_used_at, revoked_at: r.revoked_at,
});

/** Creates a key. Returns { key, webhook_secret, record }: the key and secret are never retrievable again. */
async function createKey(pool, { ownerId, name, monthlyMinutesQuota = null, rateLimitPerMin = 120 }) {
  const key = newKey();
  const webhookSecret = crypto.randomBytes(24).toString("hex");
  const { rows } = await pool.query(
    `insert into api_keys (owner_id, name, key_hash, key_prefix, webhook_secret, rate_limit_per_min, monthly_minutes_quota)
     values ($1, $2, $3, $4, $5, $6, $7) returning *`,
    [ownerId, name, hashKey(key), key.slice(0, 16), webhookSecret, rateLimitPerMin, monthlyMinutesQuota],
  );
  return { key, webhook_secret: webhookSecret, record: publicRow(rows[0]) };
}

async function listKeys(pool, ownerId) {
  const { rows } = await pool.query("select * from api_keys where owner_id = $1 order by created_at desc", [ownerId]);
  return rows.map(publicRow);
}

async function revokeKey(pool, id, ownerId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) return false;
  const r = await pool.query("update api_keys set revoked_at = now() where id = $1 and owner_id = $2 and revoked_at is null", [id, ownerId]);
  return r.rowCount > 0;
}

/** The live (not revoked) key row for a token, or null. */
async function findKey(pool, token) {
  if (!isKeyShaped(token)) return null;
  const { rows } = await pool.query("select * from api_keys where key_hash = $1 and revoked_at is null", [hashKey(token)]);
  return rows[0] || null;
}

const lastTouched = new Map();
/** last_used_at, written at most once a minute per key so reads stay cheap. */
async function touchKey(pool, id, now = Date.now()) {
  if (now - (lastTouched.get(id) || 0) < 60000) return;
  lastTouched.set(id, now);
  await pool.query("update api_keys set last_used_at = now() where id = $1", [id]).catch(() => {});
}

async function getKeyById(pool, id) {
  if (!id) return null;
  const { rows } = await pool.query("select * from api_keys where id = $1", [id]);
  return rows[0] || null;
}

/** One finished run's usage: the minutes of video it processed and the clips it made. */
async function recordUsage(pool, job, clipCount) {
  const seconds = job && job.video_meta && Number(job.video_meta.duration) ? Number(job.video_meta.duration) : 0;
  await pool.query(
    "insert into usage_events (owner_id, api_key_id, job_id, source_seconds, clips) values ($1, $2, $3, $4, $5)",
    [job.owner_id, job.api_key_id || null, job.id, seconds, clipCount || 0],
  );
}

/** Minutes of source video processed this calendar month (UTC) and the number of runs. */
async function monthUsage(pool, ownerId) {
  const { rows } = await pool.query(
    `select coalesce(sum(source_seconds), 0) as seconds, count(*)::int as runs, coalesce(sum(clips), 0)::int as clips
       from usage_events where owner_id = $1 and created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'`,
    [ownerId],
  );
  const r = rows[0] || { seconds: 0, runs: 0, clips: 0 };
  return { minutes: Math.round((Number(r.seconds) / 60) * 10) / 10, runs: r.runs, clips: r.clips };
}

module.exports = { hashKey, newKey, isKeyShaped, createKey, listKeys, revokeKey, findKey, touchKey, getKeyById, recordUsage, monthUsage, publicRow };
