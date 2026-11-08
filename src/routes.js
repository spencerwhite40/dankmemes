"use strict";

// Meme Builder admin API (Content tab). Describe an audience, give it a video,
// get captioned vertical reaction clips; every clip is kept in the Library.
//
//   GET    /api/personas
//   POST   /api/personas            { name, notes } (AI expands) | { persona } (saved as-is)
//   DELETE /api/personas/:id
//   GET    /api/jobs
//   POST   /api/jobs                multipart (file) or JSON { sourceUrl }; + personaId, minScore, maxClips
//   GET    /api/jobs/:id            status + clips
//   POST   /api/jobs/:id/recaption  { personaId } re-caption the same video (reuses the analysis)
//   POST   /api/jobs/:id/retry      re-queue a failed run
//   DELETE /api/jobs/:id
//   GET    /api/library
//   GET    /api/videos                 videos already uploaded (reuse via jobs/:id/recaption)
//   PATCH  /api/clips/:id           { caption } re-renders the clip
//   POST   /api/clips/:id/regenerate-caption   the AI writes a fresh caption (a different angle) and re-renders
//   POST   /api/clips/:id/rating    { rating: -1 | 0 | 1 }
//   DELETE /api/clips/:id
//   GET    /api/clips/:id/video     streams (Range supported); ?download=1 forces a download
//
// Auth: the same admin gate as the other Content tabs (email_outreach.settings).
// Jobs are processed by src/jobs/meme-builder-worker.js.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const multer = require("multer");

const store = require("./lib/store");
const storage = require("./lib/storage");
const media = require("./lib/media");
const { expandPersona, customPersonaId, isPresetId } = require("./lib/personas");
const { cleanCaption } = require("./lib/captions");
const { KieError, friendlyMessage } = require("./lib/kie");
const { createRun, rerun, parseOptions } = require("./intake");
const { findMoment, applyCaption, regenerate, streamClipVideo } = require("./clips");
const { HttpError } = require("./errors");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_UPLOAD_MB = () => Number(process.env.MEME_BUILDER_MAX_UPLOAD_MB || 500);
const BASE = "/api";

const userIdOf = (req) => (req.admin && req.admin.id && req.admin.id !== "env-admin" ? req.admin.id : null);

function clipJson(c) {
  return {
    id: c.id, job_id: c.job_id, persona_id: c.persona_id, n: c.n, caption: c.caption, score: c.score == null ? null : Number(c.score),
    why: c.why, transcript: c.transcript, emotion: c.emotion, start_sec: Number(c.start_sec), end_sec: Number(c.end_sec),
    rating: c.rating, created_at: c.created_at, source_label: c.source_label,
    video_url: `${BASE}/clips/${c.id}/video`,
  };
}

function registerMemeBuilderRoutes(app, { asyncRoute, pool, requireAdmin, requirePermission }) {
  // The web page acts as the "default" owner; API customers each have their own, so their runs never show up here.
  const OWNER = { ownerId: "default" };
  // Like asyncRoute, but a deliberate HttpError becomes a JSON answer with its status.
  const safe = (fn) => asyncRoute(async (req, res, next) => {
    try { await fn(req, res, next); } catch (e) { if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, code: e.code }); throw e; }
  });
  const canView = requirePermission ? requirePermission("email_outreach.settings", "view") : requireAdmin;
  const canEdit = requirePermission ? requirePermission("email_outreach.settings", "edit") : requireAdmin;

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, os.tmpdir()),
      filename: (_req, file, cb) => cb(null, `mb-upload-${crypto.randomBytes(6).toString("hex")}${path.extname(file.originalname || "").slice(0, 8)}`),
    }),
    limits: { fileSize: MAX_UPLOAD_MB() * 1024 * 1024, files: 1 },
  });
  const uploadMw = (req, res, next) => upload.single("file")(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === "LIMIT_FILE_SIZE";
    return res.status(tooBig ? 413 : 400).json({ error: tooBig ? `That file is over the ${MAX_UPLOAD_MB()} MB limit.` : err.message });
  });

  const idParam = (req, res) => {
    if (!UUID_RE.test(req.params.id || "")) { res.status(400).json({ error: "invalid id" }); return null; }
    return req.params.id;
  };

  // ── Audiences ──────────────────────────────────────────────────────────
  app.get("/api/personas", canView, asyncRoute(async (_req, res) => {
    res.json({ personas: await store.listPersonas(pool, OWNER.ownerId) });
  }));

  app.post("/api/personas", canEdit, asyncRoute(async (req, res) => {
    const b = req.body || {};
    let persona;
    if (b.persona && typeof b.persona === "object") {
      persona = b.persona;
      if (typeof persona.name !== "string" || !persona.name.trim()) return res.status(400).json({ error: "persona.name is required" });
      if (typeof persona.summary !== "string" || !persona.summary.trim()) return res.status(400).json({ error: "persona.summary is required" });
    } else {
      const name = typeof b.name === "string" ? b.name.trim() : "";
      const notes = typeof b.notes === "string" ? b.notes.trim() : "";
      if (!name || name.length > 80) return res.status(400).json({ error: "Give the audience a name (80 characters max)." });
      if (notes.length < 20) return res.status(400).json({ error: "Add a few lines of notes about this audience (20+ characters)." });
      if (notes.length > 20000) return res.status(400).json({ error: "Notes are too long (20,000 characters max)." });
      try {
        persona = await expandPersona({ name, notes });
      } catch (e) {
        console.error("[meme-builder] expandPersona failed:", e && e.message);
        return res.status(e instanceof KieError ? 503 : 500).json({ error: friendlyMessage(e) });
      }
    }
    const name = persona.name.trim().slice(0, 80);
    // Editing keeps the id; a brand-new audience gets one from its name (never a built-in's id).
    const id = typeof persona.id === "string" && persona.id && !isPresetId(persona.id) ? persona.id : customPersonaId(name);
    const { id: _i, preset: _p, created_at: _c, updated_at: _u, ...data } = persona;
    res.json({ persona: await store.savePersona(pool, { id, name, data: { ...data, name }, userId: userIdOf(req), ownerId: OWNER.ownerId }) });
  }));

  app.delete("/api/personas/:id", canEdit, asyncRoute(async (req, res) => {
    if (isPresetId(req.params.id)) return res.status(400).json({ error: "Built-in audiences can't be deleted." });
    const ok = await store.deletePersona(pool, req.params.id, OWNER.ownerId);
    return ok ? res.json({ ok: true }) : res.status(404).json({ error: "not found" });
  }));

  // ── Jobs ───────────────────────────────────────────────────────────────
  app.get("/api/jobs", canView, asyncRoute(async (_req, res) => {
    // `storage` lets the page warn when files are on the server's temporary disk instead of R2.
    res.json({ jobs: await store.listJobs(pool, { ownerId: OWNER.ownerId }), storage: storage.backendName() });
  }));

  app.post("/api/jobs", canEdit, uploadMw, safe(async (req, res) => {
    const tmp = req.file && req.file.path;
    try {
      const b = req.body || {};
      const { job } = await createRun(pool, OWNER, { personaId: b.personaId, sourceUrl: b.sourceUrl, file: req.file, options: b });
      return res.status(201).json({ job });
    } finally {
      if (tmp) fs.promises.rm(tmp, { force: true }).catch(() => {});
    }
  }));

  // Videos already uploaded, so a new run can reuse one without uploading it again (start it with POST /jobs/:id/recaption).
  app.get("/api/videos", canView, asyncRoute(async (_req, res) => {
    const rows = await store.listVideos(pool, { ownerId: OWNER.ownerId });
    res.json({ videos: rows.map((r) => ({
      job_id: r.id, label: r.source_label, created_at: r.created_at, runs: r.runs,
      duration: r.video_meta && Number(r.video_meta.duration) ? Number(r.video_meta.duration) : null,
    })) });
  }));

  app.get("/api/jobs/:id", canView, asyncRoute(async (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const job = await store.getJob(pool, id);
    if (!job) return res.status(404).json({ error: "not found" });
    const clips = (await store.listJobClips(pool, id)).map((c) => clipJson({ ...c, source_label: job.source_label }));
    const { analysis: _a, source_uri: _s, ...safeJob } = job; // internal columns stay server-side
    res.json({ job: { ...safeJob, moments: Array.isArray(job.analysis) ? job.analysis.length : null }, clips });
  }));

  app.post("/api/jobs/:id/recaption", canEdit, safe(async (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const { job } = await rerun(pool, OWNER, id, req.body || {});
    res.status(201).json({ job });
  }));

  app.post("/api/jobs/:id/retry", canEdit, asyncRoute(async (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const job = await store.retryJob(pool, id);
    if (job) notifyJobQueued();
    return job ? res.json({ job: { id: job.id, status: job.status } }) : res.status(409).json({ error: "Only failed runs can be retried." });
  }));

  app.delete("/api/jobs/:id", canEdit, asyncRoute(async (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const job = await store.getJob(pool, id);
    if (job && job.status === "running") return res.status(409).json({ error: "That run is still processing." });
    const gone = await store.deleteJob(pool, id);
    if (!gone) return res.status(404).json({ error: "not found" });
    for (const u of [...gone.clipUris, gone.sourceUri]) await storage.remove(u).catch(() => {});
    res.json({ ok: true });
  }));

  // ── Library + clips ────────────────────────────────────────────────────
  app.get("/api/library", canView, asyncRoute(async (req, res) => {
    const { personaId, rating, q, limit, offset } = req.query;
    const rows = await store.listLibrary(pool, { personaId, rating, q, limit, offset, ownerId: OWNER.ownerId });
    res.json({ clips: rows.map(clipJson) });
  }));

  app.patch("/api/clips/:id", canEdit, asyncRoute(async (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const caption = cleanCaption(typeof (req.body || {}).caption === "string" ? req.body.caption : "");
    if (!caption || caption.length > 200) return res.status(400).json({ error: "Caption must be 1 to 200 characters." });
    const clip = await store.getClip(pool, id);
    if (!clip) return res.status(404).json({ error: "not found" });
    res.json({ clip: clipJson(await applyCaption(pool, clip, caption)) });
  }));

  // The AI writes a fresh caption for this clip (a different angle from the current one) and it is burned in.
  app.post("/api/clips/:id/regenerate-caption", canEdit, safe(async (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const clip = await store.getClip(pool, id);
    if (!clip) return res.status(404).json({ error: "not found" });
    res.json({ clip: clipJson(await regenerate(pool, clip)) });
  }));

  app.post("/api/clips/:id/rating", canEdit, asyncRoute(async (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const rating = Number((req.body || {}).rating);
    if (![-1, 0, 1].includes(rating)) return res.status(400).json({ error: "rating must be -1, 0 or 1" });
    const updated = await store.setRating(pool, id, rating);
    return updated ? res.json({ clip: clipJson(updated) }) : res.status(404).json({ error: "not found" });
  }));

  app.delete("/api/clips/:id", canEdit, asyncRoute(async (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const uri = await store.deleteClip(pool, id);
    if (!uri) return res.status(404).json({ error: "not found" });
    await storage.remove(uri).catch(() => {});
    res.json({ ok: true });
  }));

  app.get("/api/clips/:id/video", canView, asyncRoute(async (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const clip = await store.getClip(pool, id);
    if (!clip) return res.status(404).json({ error: "not found" });
    await streamClipVideo(req, res, clip, { download: !!req.query.download });
  }));
}

module.exports = { registerMemeBuilderRoutes, parseOptions, clipJson, findMoment };
