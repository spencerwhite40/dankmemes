"use strict";
// A person's right to take their data and to leave: a download of everything the service holds about them, and a real deletion.
const store = require("./lib/store");
const storage = require("./lib/storage");
const keys = require("./lib/keys");
const { HttpError } = require("./errors");

/** Everything held about the account, as one JSON-able object. The videos and clips themselves are files: download those from the page. */
async function exportAccount(pool, userId) {
  const q = async (sql, params = [userId]) => (await pool.query(sql, params)).rows;
  const user = (await q("select email, name, plan, billing_period, plan_status, is_admin, created_at, terms_accepted_at, email_verified_at, last_login_at from users where id = $1"))[0];
  return {
    exported_at: new Date().toISOString(),
    note: "The videos you uploaded and the clips made from them are files and aren't included here: download them from the page.",
    account: user,
    audiences: await q("select id, name, data, created_at from meme_builder_personas where owner_id = $1 order by created_at"),
    runs: await q("select id, source_kind, source_label, source_url, status, persona_id, options, created_at from meme_builder_jobs where owner_id = $1 order by created_at"),
    clips: await q("select c.id, c.job_id as run_id, c.n, c.caption, c.rating, c.score, c.emotion, c.start_sec, c.end_sec, c.created_at from meme_builder_clips c join meme_builder_jobs j on j.id = c.job_id where j.owner_id = $1 order by j.created_at, c.n"),
    api_keys: (await keys.listKeys(pool, userId)).map((k) => ({ id: k.id, name: k.name, key_prefix: k.key_prefix, created_at: k.created_at, revoked_at: k.revoked_at })),
    usage: await q("select created_at, source_seconds, clips from usage_events where owner_id = $1 order by created_at"),
    topup_packs: await q("select pack, minutes, remaining, created_at from credit_packs where user_id = $1 order by created_at"),
  };
}

/**
 * Deletes the account and everything it owns: runs, their stored videos and clips, audiences, keys, usage records, packs, sessions.
 * Refuses while a run is in progress. Payment records stay with the payment provider (they must be kept for tax and fraud reasons).
 * Returns what was removed.
 */
async function deleteAccount(pool, userId) {
  const busy = await pool.query("select 1 from meme_builder_jobs where owner_id = $1 and status in ('queued','running') limit 1", [userId]);
  if (busy.rowCount) throw new HttpError(409, "A run is still going. Wait for it to finish, then delete your account.", "still_running");
  const { rows: jobs } = await pool.query("select id from meme_builder_jobs where owner_id = $1", [userId]);
  const uris = [];
  for (const { id } of jobs) {
    const gone = await store.deleteJob(pool, id);
    if (gone) { uris.push(...gone.clipUris); if (gone.sourceUri) uris.push(gone.sourceUri); }
  }
  await pool.query("delete from meme_builder_personas where owner_id = $1", [userId]);
  await pool.query("delete from api_keys where owner_id = $1", [userId]);
  await pool.query("delete from usage_events where owner_id = $1", [userId]);
  await pool.query("delete from model_usage where owner_id = $1", [userId]);
  await pool.query("delete from users where id = $1", [userId]);        // sessions, tokens, packs and notices go with it
  let filesFailed = 0;
  for (const uri of uris) await storage.remove(uri).catch(() => { filesFailed++; });
  return { runs: jobs.length, files: uris.length, files_failed: filesFailed };
}

module.exports = { exportAccount, deleteAccount };
