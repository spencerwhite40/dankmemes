"use strict";
// Users, passwords, sessions, and what an account is allowed to do.
const crypto = require("node:crypto");
const { promisify } = require("node:util");

const { getPlan, DEFAULT_PLAN, planNames, GB } = require("./plans");
const { HttpError } = require("./errors");
const keys = require("./lib/keys");
const mail = require("./email");
const packs = require("./billing/packs");

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

// ── Passwords: scrypt with a random salt, stored as scrypt$N$r$p$salt$hash ─────────────────────────────────
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}
async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || "").split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64");
  const got = await scrypt(password, Buffer.from(salt, "base64"), want.length, { N: Number(N), r: Number(r), p: Number(p) });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
let dummyHash;   // so a login for an email that doesn't exist takes as long as one that does
const dummy = async () => (dummyHash = dummyHash || (await hashPassword("not-a-real-password")));

const normEmail = (e) => String(e || "").trim().toLowerCase();
const adminEmails = () => String(process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const userOut = (u) => ({ id: u.id, email: u.email, name: u.name || null, plan: u.plan, is_admin: !!u.is_admin, locked: !!u.locked_at, email_verified: !!u.email_verified_at, created_at: u.created_at });

function checkCredentials(email, password) {
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "Enter a valid email address.", "bad_email");
  if (typeof password !== "string" || password.length < 10) throw new HttpError(400, "Choose a password of at least 10 characters.", "weak_password");
  if (password.length > 200) throw new HttpError(400, "That password is too long.", "bad_password");
}

async function signup(pool, { email, password, name, acceptedTerms = false }) {
  if ((process.env.SIGNUPS || "open").toLowerCase() === "closed") throw new HttpError(403, "Sign-ups are closed right now.", "signups_closed");
  email = normEmail(email);
  checkCredentials(email, password);
  const hash = await hashPassword(password);
  try {
    const { rows } = await pool.query(
      "insert into users (email, password_hash, name, plan, is_admin, terms_accepted_at) values ($1, $2, $3, $4, $5, $6) returning *",
      [email, hash, name ? String(name).trim().slice(0, 80) : null, DEFAULT_PLAN, adminEmails().includes(email), acceptedTerms ? new Date() : null],
    );
    return rows[0];
  } catch (e) {
    if (e && e.code === "23505") throw new HttpError(409, "There's already an account with that email. Sign in instead.", "email_taken");
    throw e;
  }
}

/** The user for a correct email + password, else null. */
async function authenticate(pool, email, password) {
  const { rows } = await pool.query("select * from users where lower(email) = $1", [normEmail(email)]);
  const user = rows[0];
  const ok = await verifyPassword(String(password || ""), user ? user.password_hash : await dummy());
  if (!user || !ok) return null;
  if (adminEmails().includes(user.email.toLowerCase()) && !user.is_admin) { await pool.query("update users set is_admin = true where id = $1", [user.id]); user.is_admin = true; }
  await pool.query("update users set last_login_at = now() where id = $1", [user.id]);
  return user;
}

// ── Sessions: a random token in an HttpOnly cookie; only its hash is stored, so a database leak can't be replayed ──
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
async function createSession(pool, userId, userAgent) {
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query("insert into sessions (token_hash, user_id, expires_at, user_agent) values ($1, $2, now() + ($3 || ' days')::interval, $4)", [sha(token), userId, String(SESSION_DAYS), String(userAgent || "").slice(0, 200)]);
  return token;
}
/** The signed-in user for a session token (and the session's expiry is pushed out), or null. */
async function userForSession(pool, token) {
  if (!token || token.length < 20) return null;
  const { rows } = await pool.query(
    `update sessions s set last_seen_at = now(), expires_at = greatest(s.expires_at, now() + ($2 || ' days')::interval)
       from users u where s.token_hash = $1 and s.expires_at > now() and u.id = s.user_id
     returning u.*`,
    [sha(token), String(SESSION_DAYS)],
  );
  return rows[0] || null;
}
async function endSession(pool, token) { if (token) await pool.query("delete from sessions where token_hash = $1", [sha(token)]); }
async function endAllSessions(pool, userId) { await pool.query("delete from sessions where user_id = $1", [userId]); }

/** Email must be confirmed before work starts, but only where email can actually be sent (otherwise nobody could confirm). */
const verificationRequired = () => mail.configured();
async function markVerified(pool, userId) { await pool.query("update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1", [userId]); }
async function assertVerified(pool, ownerId) {
  if (!verificationRequired() || !/^[0-9a-f-]{36}$/i.test(String(ownerId || ""))) return;
  const { rows } = await pool.query("select email, email_verified_at from users where id = $1", [ownerId]);
  if (rows[0] && !rows[0].email_verified_at) throw new HttpError(403, `Confirm your email address first. We sent a link to ${rows[0].email}.`, "email_not_verified");
}

async function setPassword(pool, userId, password) {
  if (typeof password !== "string" || password.length < 10) throw new HttpError(400, "Choose a password of at least 10 characters.", "weak_password");
  await pool.query("update users set password_hash = $2 where id = $1", [userId, await hashPassword(password)]);
  await endAllSessions(pool, userId);
}
async function setPlan(pool, userId, plan) {
  if (!planNames().includes(plan)) throw new Error(`Unknown plan "${plan}". Plans: ${planNames().join(", ")}`);
  // moving to a paid plan by hand also unlocks the account
  const r = await pool.query("update users set plan = $2, locked_at = case when $2 = 'free' then locked_at else null end where id = $1", [userId, plan]);
  return r.rowCount > 0;
}
/** Is this owner's account locked (its subscription ended)? Owners with no account are not. */
async function isLocked(pool, ownerId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(ownerId || ""))) return false;
  const { rows } = await pool.query("select locked_at is not null as locked from users where id = $1", [ownerId]);
  return !!(rows[0] && rows[0].locked);
}

// ── What an account is allowed ──────────────────────────────────────────────────────────────────────────────
/** The plan limits for an owner id (a user id). Owners with no account (the old "default") get the free plan. */
async function planFor(pool, ownerId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(ownerId || ""))) return getPlan(DEFAULT_PLAN);
  const { rows } = await pool.query("select plan from users where id = $1", [ownerId]);
  return getPlan(rows[0] && rows[0].plan);
}

async function storageBytes(pool, ownerId) {
  const { rows } = await pool.query(
    `select coalesce((select sum(source_bytes) from meme_builder_jobs where owner_id = $1), 0)
          + coalesce((select sum(c.bytes) from meme_builder_clips c join meme_builder_jobs j on j.id = c.job_id where j.owner_id = $1), 0) as bytes`,
    [ownerId],
  );
  return Number(rows[0].bytes);
}
async function activeRuns(pool, ownerId) {
  const { rows } = await pool.query("select count(*)::int as n from meme_builder_jobs where owner_id = $1 and status in ('queued','running')", [ownerId]);
  return rows[0].n;
}

/** Everything the account page shows: usage against each limit. */
async function usageSnapshot(pool, ownerId) {
  const plan = await planFor(pool, ownerId);
  const isUser = /^[0-9a-f-]{36}$/i.test(String(ownerId || ""));
  const [month, bytes, active, packMinutes] = await Promise.all([keys.monthUsage(pool, ownerId), storageBytes(pool, ownerId), activeRuns(pool, ownerId), isUser ? packs.remaining(pool, ownerId) : 0]);
  return {
    plan: { name: plan.name, label: plan.label },
    limits: { monthly_minutes: plan.monthlyMinutes, max_video_minutes: plan.maxVideoMinutes, max_upload_mb: plan.maxUploadMb, storage_gb: plan.storageGb, retention_days: plan.retentionDays, concurrent_runs: plan.concurrentRuns, api_access: plan.apiAccess, clips_per_run: plan.clipsPerRun, watermark: !!plan.watermark },
    usage: { minutes: month.minutes, runs: month.runs, clips: month.clips, storage_bytes: bytes, active_runs: active, pack_minutes: Math.round(packMinutes * 10) / 10 },
  };
}

/**
 * Refuse to start a run the plan doesn't allow. fileBytes: the size of an upload about to be stored (0 for a link or a re-run).
 * Throws an HttpError that says what to do about it.
 */
async function assertCanStart(pool, ownerId, { fileBytes = 0 } = {}) {
  await assertVerified(pool, ownerId);
  const plan = await planFor(pool, ownerId);
  const month = await keys.monthUsage(pool, ownerId);
  if (month.minutes >= plan.monthlyMinutes && !((await packs.remaining(pool, ownerId)) > 0)) throw new HttpError(402, `You've used all ${plan.monthlyMinutes} minutes of the ${plan.label} plan this month. They reset on the 1st (UTC). You can buy a top-up pack or move to a bigger plan.`, "quota_exceeded");
  if ((await activeRuns(pool, ownerId)) >= plan.concurrentRuns) throw new HttpError(429, `The ${plan.label} plan runs ${plan.concurrentRuns} video${plan.concurrentRuns === 1 ? "" : "s"} at a time. Wait for the current one to finish.`, "too_many_runs");
  if (fileBytes > plan.maxUploadMb * 1024 * 1024) throw new HttpError(413, `That file is over the ${plan.maxUploadMb} MB limit of the ${plan.label} plan.`, "file_too_large");
  if ((await storageBytes(pool, ownerId)) + fileBytes > plan.storageGb * GB) throw new HttpError(413, `You're out of storage (${plan.storageGb} GB on the ${plan.label} plan). Delete old runs to make room.`, "storage_full");
  return plan;
}

module.exports = {
  hashPassword, verifyPassword, signup, authenticate, createSession, userForSession, endSession, endAllSessions, setPassword, setPlan,
  markVerified, assertVerified, verificationRequired, planFor, isLocked, storageBytes, activeRuns, usageSnapshot, assertCanStart, userOut, normEmail, SESSION_DAYS,
};
