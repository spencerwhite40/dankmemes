"use strict";
// The public API (versioned, API-key auth). Every query is scoped to the key's owner: a customer only ever sees their own runs and clips.
// See docs/api.md.
const fs = require("node:fs");
const express = require("express");

const store = require("./lib/store");
const storage = require("./lib/storage");
const keys = require("./lib/keys");
const { expandPersona, customPersonaId, isPresetId } = require("./lib/personas");
const { KieError, friendlyMessage } = require("./lib/kie");
const { createRun, rerun } = require("./intake");
const { regenerate, streamClipVideo } = require("./clips");
const { signClip, verifyClip } = require("./signing");
const { createLimiter } = require("./ratelimit");
const { uploadMiddleware } = require("./upload");
const { asyncRoute } = require("./async-route");
const { HttpError } = require("./errors");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINK_TTL_SEC = 3600;
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

function buildV1(pool, { baseUrl = process.env.PUBLIC_BASE_URL || "" } = {}) {
  const router = express.Router();
  const limiter = createLimiter();
  const safe = (fn) => asyncRoute(async (req, res, next) => {
    try { await fn(req, res, next); } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, code: e.code });
      throw e;
    }
  });
  const fail = (res, status, code, message, extra) => res.status(status).json({ error: message, code, ...extra });

  // ── Playback links: no key needed, the signature is the credential ───────────────────────────────
  router.get("/clips/:id/video", safe(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return fail(res, 400, "bad_id", "invalid id");
    if (!verifyClip(id, req.query.exp, req.query.sig)) return fail(res, 403, "link_expired", "This link has expired or is not valid. Fetch the run again for a fresh link.");
    const clip = await store.getClip(pool, id);
    if (!clip) return fail(res, 404, "not_found", "not found");
    await streamClipVideo(req, res, clip, { download: !!req.query.download });
  }));

  // ── Everything below needs an API key ──────────────────────────────────────────────────────────
  router.use(safe(async (req, res, next) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
    if (!m) return fail(res, 401, "no_key", "Send your API key as: Authorization: Bearer <key>");
    const key = await keys.findKey(pool, m[1]);
    if (!key) return fail(res, 401, "bad_key", "That API key is not valid or has been revoked.");
    const rate = limiter.check(key.id, key.rate_limit_per_min);
    if (!rate.ok) { res.set("Retry-After", String(rate.retryAfterSec)); return fail(res, 429, "rate_limited", "Too many requests. Slow down and retry shortly.", { retry_after_sec: rate.retryAfterSec }); }
    keys.touchKey(pool, key.id);
    req.owner = { ownerId: key.owner_id, apiKeyId: key.id };
    req.apiKey = key;
    next();
  }));

  const clipOut = (c) => {
    const { exp, sig } = signClip(c.id, { ttlSec: LINK_TTL_SEC });
    return {
      id: c.id, run_id: c.job_id, n: c.n, caption: c.caption, score: c.score == null ? null : Number(c.score), emotion: c.emotion || null,
      start_sec: Number(c.start_sec), end_sec: Number(c.end_sec), rating: c.rating, created_at: c.created_at,
      video_url: `${baseUrl}/v1/clips/${c.id}/video?exp=${exp}&sig=${sig}`, video_url_expires_at: new Date(exp * 1000).toISOString(),
    };
  };
  const runOut = (j, extra = {}) => ({
    id: j.id, status: j.status, stage: j.stage, progress: j.stage_info || {}, audience: j.persona_id, source_label: j.source_label,
    error: j.error || null, clip_count: j.clip_count == null ? undefined : j.clip_count, parent_run_id: j.parent_job_id || null,
    created_at: j.created_at, started_at: j.started_at || null, finished_at: j.finished_at || null, ...extra,
  });
  const ownedRun = async (req) => {
    if (!UUID_RE.test(req.params.id || "")) throw new HttpError(400, "invalid id", "bad_id");
    const job = await store.getJob(pool, req.params.id);
    if (!job || job.owner_id !== req.owner.ownerId) throw new HttpError(404, "not found", "not_found");   // 404, not 403: don't reveal that it exists
    return job;
  };
  const ownedClip = async (req) => {
    if (!UUID_RE.test(req.params.id || "")) throw new HttpError(400, "invalid id", "bad_id");
    const clip = await store.getClip(pool, req.params.id);
    const job = clip && await store.getJob(pool, clip.job_id);
    if (!clip || !job || job.owner_id !== req.owner.ownerId) throw new HttpError(404, "not found", "not_found");
    return clip;
  };
  const checkQuota = async (req) => {
    const quota = req.apiKey.monthly_minutes_quota;
    if (quota == null) return;
    const used = await keys.monthUsage(pool, req.owner.ownerId);
    if (used.minutes >= Number(quota)) throw new HttpError(402, `Monthly quota of ${Number(quota)} minutes reached.`, "quota_exceeded");
  };

  // ── Audiences ────────────────────────────────────────────────────────────────────────────────────
  router.get("/audiences", safe(async (req, res) => {
    const list = await store.listPersonas(pool, req.owner.ownerId);
    res.json({ audiences: list.map((p) => ({ id: p.id, name: p.name, built_in: !!p.preset, summary: p.summary || null })) });
  }));

  router.post("/audiences", safe(async (req, res) => {
    const name = typeof (req.body || {}).name === "string" ? req.body.name.trim() : "";
    const notes = typeof (req.body || {}).notes === "string" ? req.body.notes.trim() : "";
    if (!name || name.length > 80) throw new HttpError(400, "Give the audience a name (80 characters max).", "bad_name");
    if (notes.length < 20 || notes.length > 20000) throw new HttpError(400, "notes must be 20 to 20,000 characters describing the audience.", "bad_notes");
    let persona;
    try { persona = await expandPersona({ name, notes }); }
    catch (e) { throw new HttpError(e instanceof KieError ? 503 : 500, friendlyMessage(e), "expand_failed"); }
    const id = `${slug(req.owner.ownerId)}-${customPersonaId(name)}`;
    if (isPresetId(id)) throw new HttpError(400, "That name is reserved.", "reserved");
    const { id: _i, preset: _p, created_at: _c, updated_at: _u, ...data } = persona;
    let saved;
    try { saved = await store.savePersona(pool, { id, name, data: { ...data, name }, ownerId: req.owner.ownerId }); }
    catch (e) { throw new HttpError(409, e.message, "name_taken"); }
    res.status(201).json({ audience: { id: saved.id, name: saved.name, built_in: false, summary: saved.summary || null } });
  }));

  // ── Runs ─────────────────────────────────────────────────────────────────────────────────────────
  router.post("/runs", uploadMiddleware(), safe(async (req, res) => {
    const tmp = req.file && req.file.path;
    try {
      await checkQuota(req);
      const b = req.body || {};
      const idem = req.headers["idempotency-key"];
      const options = typeof b.options === "string" ? (() => { try { return JSON.parse(b.options); } catch { return {}; } })() : (b.options || {});
      const { job, created } = await createRun(pool, req.owner, {
        personaId: b.audience || "truckers", sourceUrl: b.source_url, file: req.file, options, webhookUrl: b.webhook_url, idempotencyKey: idem,
      });
      res.status(created ? 202 : 200).json({ run: runOut(job) });
    } finally {
      if (tmp) fs.promises.rm(tmp, { force: true }).catch(() => {});
    }
  }));

  router.get("/runs", safe(async (req, res) => {
    const jobs = await store.listJobs(pool, { ownerId: req.owner.ownerId, limit: Number(req.query.limit) || 50 });
    res.json({ runs: jobs.map((j) => runOut(j)) });
  }));

  router.get("/runs/:id", safe(async (req, res) => {
    const job = await ownedRun(req);
    const clips = (await store.listJobClips(pool, job.id)).map(clipOut);
    res.json({ run: runOut(job, { clip_count: clips.length }), clips });
  }));

  router.post("/runs/:id/rerun", safe(async (req, res) => {
    const parent = await ownedRun(req);
    await checkQuota(req);
    const b = req.body || {};
    const { job } = await rerun(pool, req.owner, parent.id, { personaId: b.audience || parent.persona_id, options: b.options || {}, webhookUrl: b.webhook_url });
    res.status(202).json({ run: runOut(job) });
  }));

  router.get("/videos", safe(async (req, res) => {
    const rows = await store.listVideos(pool, { ownerId: req.owner.ownerId });
    res.json({ videos: rows.map((r) => ({ run_id: r.id, label: r.source_label, created_at: r.created_at, runs: r.runs, duration_sec: r.video_meta && Number(r.video_meta.duration) ? Number(r.video_meta.duration) : null })) });
  }));

  // ── Clips ────────────────────────────────────────────────────────────────────────────────────────
  router.get("/clips/:id", safe(async (req, res) => { res.json({ clip: clipOut(await ownedClip(req)) }); }));

  router.post("/clips/:id/rating", safe(async (req, res) => {
    const clip = await ownedClip(req);
    const r = Number((req.body || {}).rating);
    if (![-1, 0, 1].includes(r)) throw new HttpError(400, "rating must be -1, 0 or 1", "bad_rating");
    await store.setRating(pool, clip.id, r);
    res.json({ clip: clipOut({ ...clip, rating: r }) });
  }));

  router.post("/clips/:id/regenerate-caption", safe(async (req, res) => {
    const clip = await ownedClip(req);
    const updated = await regenerate(pool, clip);
    res.json({ clip: clipOut(updated) });
  }));

  router.delete("/clips/:id", safe(async (req, res) => {
    const clip = await ownedClip(req);
    const uri = await store.deleteClip(pool, clip.id);
    if (uri) await storage.remove(uri).catch(() => {});
    res.json({ ok: true });
  }));

  // ── Usage ────────────────────────────────────────────────────────────────────────────────────────
  router.get("/usage", safe(async (req, res) => {
    const used = await keys.monthUsage(pool, req.owner.ownerId);
    const quota = req.apiKey.monthly_minutes_quota == null ? null : Number(req.apiKey.monthly_minutes_quota);
    res.json({ period: "this calendar month (UTC)", minutes_processed: used.minutes, runs: used.runs, clips: used.clips, monthly_minutes_quota: quota, minutes_remaining: quota == null ? null : Math.max(0, Math.round((quota - used.minutes) * 10) / 10) });
  }));

  router.use((_req, res) => fail(res, 404, "not_found", "No such endpoint."));
  return router;
}

module.exports = { buildV1 };
