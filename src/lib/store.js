"use strict";

// Meme Builder data access. Every function takes the pg pool first; no module
// state, so tests can pass a stub pool.

const { getPreset, listPresets, isPresetId } = require("./personas");

// ── Personas ─────────────────────────────────────────────────────────────

/** Presets first, then custom personas (data jsonb flattened + id/name). */
async function listPersonas(pool) {
  const { rows } = await pool.query("select id, name, data, created_at, updated_at from public.meme_builder_personas order by name");
  const custom = rows.map((r) => ({ ...r.data, id: r.id, name: r.name, preset: false, created_at: r.created_at, updated_at: r.updated_at }));
  return [...listPresets(), ...custom];
}

async function getPersona(pool, id) {
  const preset = getPreset(id);
  if (preset) return { ...preset, preset: true };
  const { rows } = await pool.query("select id, name, data from public.meme_builder_personas where id = $1", [id]);
  return rows[0] ? { ...rows[0].data, id: rows[0].id, name: rows[0].name, preset: false } : null;
}

async function savePersona(pool, { id, name, data, userId }) {
  if (isPresetId(id)) throw new Error("Built-in audiences can't be overwritten. Save your edit under a new name.");
  const { rows } = await pool.query(
    `insert into public.meme_builder_personas (id, name, data, created_by)
     values ($1, $2, $3::jsonb, $4)
     on conflict (id) do update set name = excluded.name, data = excluded.data, updated_at = now()
     returning id, name, data`,
    [id, name, JSON.stringify(data), userId || null],
  );
  return { ...rows[0].data, id: rows[0].id, name: rows[0].name, preset: false };
}

async function deletePersona(pool, id) {
  if (isPresetId(id)) throw new Error("Built-in audiences can't be deleted.");
  const r = await pool.query("delete from public.meme_builder_personas where id = $1", [id]);
  return r.rowCount > 0;
}

/** Rated captions for one audience, oldest first (latest rating per caption wins downstream). */
async function ratedClips(pool, personaId) {
  const { rows } = await pool.query(
    "select caption, transcript, rating from public.meme_builder_clips where persona_id = $1 and rating <> 0 order by updated_at",
    [personaId],
  );
  return rows;
}

// ── Jobs ─────────────────────────────────────────────────────────────────

async function createJob(pool, j) {
  const { rows } = await pool.query(
    `insert into public.meme_builder_jobs
       (id, created_by, persona_id, source_kind, source_label, source_url, source_uri, parent_job_id, options, analysis, video_meta)
     values (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb)
     returning *`,
    [j.id || null, j.userId || null, j.personaId, j.sourceKind, j.sourceLabel, j.sourceUrl || null, j.sourceUri || null,
      j.parentJobId || null, JSON.stringify(j.options || {}), j.analysis ? JSON.stringify(j.analysis) : null, j.videoMeta ? JSON.stringify(j.videoMeta) : null],
  );
  return rows[0];
}

/** Atomically claim the oldest queued job (SKIP LOCKED so two runners never take the same one). */
async function claimNextJob(pool) {
  const { rows } = await pool.query(
    `update public.meme_builder_jobs set status = 'running', stage = 'starting', started_at = coalesce(started_at, now()),
            heartbeat_at = now(), attempts = attempts + 1, error = null
      where id = (select id from public.meme_builder_jobs where status = 'queued' order by created_at limit 1 for update skip locked)
      returning *`,
  );
  return rows[0] || null;
}

async function setStage(pool, id, stage, info) {
  await pool.query(
    "update public.meme_builder_jobs set stage = $2, stage_info = $3::jsonb, heartbeat_at = now() where id = $1",
    [id, stage, info ? JSON.stringify(info) : null],
  );
}

async function patchJob(pool, id, fields) {
  const cols = { source_uri: "source_uri", analysis: "analysis", video_meta: "video_meta" };
  const sets = [], vals = [id];
  for (const [k, v] of Object.entries(fields)) {
    if (!cols[k]) throw new Error(`patchJob: unknown field ${k}`);
    vals.push(k === "source_uri" ? v : JSON.stringify(v));
    sets.push(`${cols[k]} = $${vals.length}${k === "source_uri" ? "" : "::jsonb"}`);
  }
  if (sets.length) await pool.query(`update public.meme_builder_jobs set ${sets.join(", ")} where id = $1`, vals);
}

/** "Still alive" signal, so a long step never looks like a dead run. */
async function touchJob(pool, id) {
  await pool.query("update public.meme_builder_jobs set heartbeat_at = now() where id = $1 and status = 'running'", [id]);
}

/** Put a run back in the queue after a transient failure (the AI service was down); it picks up from its saved progress. */
async function requeueForRetry(pool, id) {
  const { rows } = await pool.query(
    "update public.meme_builder_jobs set status = 'queued', stage = 'queued', stage_info = null where id = $1 and status = 'running' returning id",
    [id],
  );
  return rows.length > 0;
}

async function finishJob(pool, id) {
  await pool.query("update public.meme_builder_jobs set status = 'done', stage = 'done', finished_at = now(), heartbeat_at = now(), error = null where id = $1", [id]);
}

async function failJob(pool, id, message) {
  await pool.query("update public.meme_builder_jobs set status = 'error', finished_at = now(), error = $2 where id = $1", [id, String(message).slice(0, 1000)]);
}

/** Put a failed job back in the queue (admin "Retry"). Returns the job, or null if it wasn't in the error state. */
async function retryJob(pool, id) {
  const { rows } = await pool.query(
    `update public.meme_builder_jobs set status = 'queued', stage = 'queued', stage_info = null, error = null, attempts = 0, finished_at = null
      where id = $1 and status = 'error' returning *`,
    [id],
  );
  return rows[0] || null;
}

/**
 * Jobs stuck in 'running' (process died mid-run) go back to the queue, or to
 * 'error' once they've been tried `maxAttempts` times so a job that crashes
 * the process can't loop forever.
 */
async function requeueStale(pool, { staleMinutes = 3, maxAttempts = 3 } = {}) {   // a live run beats its heartbeat every 30s, so 3 minutes of silence means the process is gone
  await pool.query(
    `update public.meme_builder_jobs
        set status = case when attempts >= $2 then 'error' else 'queued' end,
            error = case when attempts >= $2 then 'The server restarted while this was running too many times.' else error end,
            finished_at = case when attempts >= $2 then now() else finished_at end
      where status = 'running' and heartbeat_at < now() - ($1 || ' minutes')::interval`,
    [String(staleMinutes), maxAttempts],
  );
}

async function listJobs(pool, { limit = 50 } = {}) {
  const { rows } = await pool.query(
    `select j.id, j.persona_id, j.source_kind, j.source_label, j.status, j.stage, j.error, j.created_at, j.finished_at, j.parent_job_id,
            (select count(*)::int from public.meme_builder_clips c where c.job_id = j.id) as clip_count
       from public.meme_builder_jobs j order by j.created_at desc limit $1`,
    [Math.min(Number(limit) || 50, 200)],
  );
  return rows;
}

/** Videos already stored, newest first, one row per stored file (the latest run that used it). */
async function listVideos(pool, { limit = 30 } = {}) {
  const { rows } = await pool.query(
    `select distinct on (source_uri) id, source_label, created_at, video_meta, persona_id,
            (select count(*)::int from public.meme_builder_jobs j2 where j2.source_uri = j.source_uri) as runs
       from public.meme_builder_jobs j
      where source_uri is not null
      order by source_uri, created_at desc`,
  );
  return rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, Math.min(Number(limit) || 30, 100));
}

async function getJob(pool, id) {
  const { rows } = await pool.query("select * from public.meme_builder_jobs where id = $1", [id]);
  return rows[0] || null;
}

// ── Clips ────────────────────────────────────────────────────────────────

/** Remove every clip row of a job (before a re-run). Returns the storage URIs so the caller can delete the files. */
async function clearClips(pool, jobId) {
  const old = await pool.query("delete from public.meme_builder_clips where job_id = $1 returning storage_uri", [jobId]);
  return old.rows.map((r) => r.storage_uri);
}

/** Save one finished clip right away, so it shows up on the page and in the Library as soon as it exists. */
async function addClip(pool, jobId, personaId, n, c, userId) {
  const { rows } = await pool.query(
    `insert into public.meme_builder_clips (job_id, persona_id, n, caption, score, why, transcript, emotion, start_sec, end_sec, storage_uri, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [jobId, personaId, n, c.caption, c.score ?? null, c.why || null, c.transcript || null, c.emotion || null, c.startSec, c.endSec, c.storageUri, userId || null],
  );
  return rows[0] ? rows[0].id : null;
}

async function listJobClips(pool, jobId) {
  const { rows } = await pool.query("select * from public.meme_builder_clips where job_id = $1 order by n", [jobId]);
  return rows;
}

async function getClip(pool, id) {
  const { rows } = await pool.query("select * from public.meme_builder_clips where id = $1", [id]);
  return rows[0] || null;
}

async function updateClipCaption(pool, id, caption) {
  const { rows } = await pool.query("update public.meme_builder_clips set caption = $2, updated_at = now() where id = $1 returning *", [id, caption]);
  return rows[0] || null;
}

async function setRating(pool, id, rating) {
  const { rows } = await pool.query("update public.meme_builder_clips set rating = $2, updated_at = now() where id = $1 returning *", [id, rating]);
  return rows[0] || null;
}

async function deleteClip(pool, id) {
  const { rows } = await pool.query("delete from public.meme_builder_clips where id = $1 returning storage_uri", [id]);
  return rows[0] ? rows[0].storage_uri : null;
}

/**
 * Delete a job + its clips. Returns { clipUris, sourceUri } where sourceUri is
 * only set when no other job shares that source video (re-captions reuse it).
 */
async function deleteJob(pool, id) {
  const job = await getJob(pool, id);
  if (!job) return null;
  const clips = await pool.query("select storage_uri from public.meme_builder_clips where job_id = $1", [id]);
  await pool.query("delete from public.meme_builder_jobs where id = $1", [id]);
  let sourceUri = null;
  if (job.source_uri) {
    const shared = await pool.query("select 1 from public.meme_builder_jobs where source_uri = $1 limit 1", [job.source_uri]);
    if (!shared.rowCount) sourceUri = job.source_uri;
  }
  return { clipUris: clips.rows.map((r) => r.storage_uri), sourceUri };
}

/** Library: every clip, newest first, filterable. */
async function listLibrary(pool, { personaId, rating, q, limit = 60, offset = 0 } = {}) {
  const where = [], vals = [];
  if (personaId) { vals.push(personaId); where.push(`c.persona_id = $${vals.length}`); }
  if (rating !== undefined && rating !== null && rating !== "") { vals.push(Number(rating)); where.push(`c.rating = $${vals.length}`); }
  if (q) { vals.push(`%${String(q).replace(/[%_]/g, "\\$&")}%`); where.push(`c.caption ilike $${vals.length}`); }
  vals.push(Math.min(Number(limit) || 60, 200), Math.max(Number(offset) || 0, 0));
  const { rows } = await pool.query(
    `select c.id, c.job_id, c.persona_id, c.n, c.caption, c.score, c.why, c.emotion, c.start_sec, c.end_sec, c.rating, c.created_at,
            j.source_label
       from public.meme_builder_clips c join public.meme_builder_jobs j on j.id = c.job_id
      ${where.length ? `where ${where.join(" and ")}` : ""}
      order by c.created_at desc, c.n limit $${vals.length - 1} offset $${vals.length}`,
    vals,
  );
  return rows;
}

module.exports = {
  listPersonas, getPersona, savePersona, deletePersona, ratedClips,
  createJob, claimNextJob, setStage, patchJob, touchJob, requeueForRetry, finishJob, failJob, retryJob, requeueStale, listJobs, listVideos, getJob,
  clearClips, addClip, listJobClips, getClip, updateClipCaption, setRating, deleteClip, deleteJob, listLibrary,
};
