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
const { cleanCaption, regenerateCaption } = require("./lib/captions");
const { tasteFromRatings } = require("./lib/personas");
const { KieError, friendlyMessage } = require("./lib/kie");
const { notifyJobQueued } = require("./lib/queue-signal");
const { rerenderClip } = require("./lib/pipeline");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_UPLOAD_MB = () => Number(process.env.MEME_BUILDER_MAX_UPLOAD_MB || 500);
const BASE = "/api";

const clampInt = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
};

/** Normalise the per-run options an admin can set. */
function parseOptions(body) {
  const o = {};
  if (body.minScore !== undefined && body.minScore !== "") o.minScore = clampInt(body.minScore, 1, 10, 1);
  if (body.maxClips !== undefined && body.maxClips !== "") o.maxClips = clampInt(body.maxClips, 1, 60, 30);
  return o;
}

/** The analysis moment a clip came from (nearest midpoint within 20s), or a minimal stand-in built from the clip itself. Pure. */
function findMoment(analysis, clip) {
  const start = Number(clip.start_sec), end = Number(clip.end_sec);
  const mid = (start + end) / 2;
  let best = null, bestD = Infinity;
  for (const m of Array.isArray(analysis) ? analysis : []) {
    const d = Math.abs((m.startSec + m.endSec) / 2 - mid);
    if (d < bestD) { best = m; bestD = d; }
  }
  if (best && bestD <= 20) return { ...best, startSec: start, endSec: end };
  return {
    id: "m1", kind: end - start >= 15 ? "bit" : "reaction", startSec: start, endSec: end, transcript: clip.transcript || "",
    context: "", emotion: clip.emotion || "", delivery: "", reaction_use: clip.why || "",
  };
}

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

  // Burn a new caption into a clip: re-render from the stored source, swap the file, update the row.
  async function applyCaption(clip, caption) {
    const newUri = await rerenderClip(pool, clip, caption);
    const oldUri = clip.storage_uri;
    await pool.query("update public.meme_builder_clips set storage_uri = $2 where id = $1", [clip.id, newUri]);
    const updated = await store.updateClipCaption(pool, clip.id, caption);
    await storage.remove(oldUri).catch(() => {});
    return updated;
  }

  // ── Audiences ──────────────────────────────────────────────────────────
  app.get("/api/personas", canView, asyncRoute(async (_req, res) => {
    res.json({ personas: await store.listPersonas(pool) });
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
    res.json({ persona: await store.savePersona(pool, { id, name, data: { ...data, name }, userId: userIdOf(req) }) });
  }));

  app.delete("/api/personas/:id", canEdit, asyncRoute(async (req, res) => {
    if (isPresetId(req.params.id)) return res.status(400).json({ error: "Built-in audiences can't be deleted." });
    const ok = await store.deletePersona(pool, req.params.id);
    return ok ? res.json({ ok: true }) : res.status(404).json({ error: "not found" });
  }));

  // ── Jobs ───────────────────────────────────────────────────────────────
  app.get("/api/jobs", canView, asyncRoute(async (_req, res) => {
    // `storage` lets the page warn when files are on the server's temporary disk instead of R2.
    res.json({ jobs: await store.listJobs(pool), storage: storage.backendName() });
  }));

  app.post("/api/jobs", canEdit, uploadMw, asyncRoute(async (req, res) => {
    const tmp = req.file && req.file.path;
    try {
      const b = req.body || {};
      const personaId = typeof b.personaId === "string" ? b.personaId : "";
      if (!(await store.getPersona(pool, personaId))) return res.status(400).json({ error: "Pick an audience first." });
      const options = parseOptions(b);

      if (req.file) {
        try { await media.probe(tmp); } catch { return res.status(400).json({ error: "That file doesn't look like a video we can read (try mp4 or mov)." }); }
        const id = crypto.randomUUID();
        const ext = (path.extname(req.file.originalname || "") || ".mp4").toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 8) || ".mp4";
        const uri = await storage.putFile(tmp, `${id}/source${ext}`, req.file.mimetype || "video/mp4");
        const job = await store.createJob(pool, {
          id, userId: userIdOf(req), personaId, sourceKind: "upload", sourceLabel: (req.file.originalname || "upload").slice(0, 200), sourceUri: uri, options,
        });
        notifyJobQueued();
        return res.status(201).json({ job });
      }

      const sourceUrl = typeof b.sourceUrl === "string" ? b.sourceUrl.trim() : "";
      if (!sourceUrl) return res.status(400).json({ error: "Upload a video file or paste a direct video link." });
      if (/(^|\.)(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|vimeo\.com)$/i.test((() => { try { return new URL(sourceUrl).hostname; } catch { return ""; } })())) {
        return res.status(400).json({ error: "Links to YouTube, TikTok and similar sites can't be downloaded from the server. Download the video and upload the file, or paste a direct link to the video file (.mp4)." });
      }
      try { await media.assertPublicUrl(sourceUrl); } catch (e) { return res.status(400).json({ error: e.message }); }
      const label = decodeURIComponent(sourceUrl.split("?")[0].split("/").pop() || sourceUrl).slice(0, 200);
      const job = await store.createJob(pool, { userId: userIdOf(req), personaId, sourceKind: "url", sourceLabel: label, sourceUrl, options });
      notifyJobQueued();
      return res.status(201).json({ job });
    } finally {
      if (tmp) fs.promises.rm(tmp, { force: true }).catch(() => {});
    }
  }));

  // Videos already uploaded, so a new run can reuse one without uploading it again (start it with POST /jobs/:id/recaption).
  app.get("/api/videos", canView, asyncRoute(async (_req, res) => {
    const rows = await store.listVideos(pool);
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

  app.post("/api/jobs/:id/recaption", canEdit, asyncRoute(async (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const parent = await store.getJob(pool, id);
    if (!parent) return res.status(404).json({ error: "not found" });
    if (!parent.source_uri) return res.status(409).json({ error: "The source video for this run isn't stored yet." });
    const personaId = typeof (req.body || {}).personaId === "string" ? req.body.personaId : "";
    if (!(await store.getPersona(pool, personaId))) return res.status(400).json({ error: "Pick an audience." });
    const job = await store.createJob(pool, {
      userId: userIdOf(req), personaId, sourceKind: parent.source_kind, sourceLabel: parent.source_label, sourceUrl: parent.source_url,
      sourceUri: parent.source_uri, parentJobId: parent.id, analysis: parent.analysis, videoMeta: parent.video_meta, options: { ...(parent.options || {}), ...parseOptions(req.body || {}) },
    });
    notifyJobQueued();
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
    const rows = await store.listLibrary(pool, { personaId, rating, q, limit, offset });
    res.json({ clips: rows.map(clipJson) });
  }));

  app.patch("/api/clips/:id", canEdit, asyncRoute(async (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const caption = cleanCaption(typeof (req.body || {}).caption === "string" ? req.body.caption : "");
    if (!caption || caption.length > 200) return res.status(400).json({ error: "Caption must be 1 to 200 characters." });
    const clip = await store.getClip(pool, id);
    if (!clip) return res.status(404).json({ error: "not found" });
    res.json({ clip: clipJson(await applyCaption(clip, caption)) });
  }));

  // The AI writes a fresh caption for this clip (a different angle from the current one) and it is burned in.
  app.post("/api/clips/:id/regenerate-caption", canEdit, asyncRoute(async (req, res) => {
    const id = idParam(req, res); if (!id) return;
    const clip = await store.getClip(pool, id);
    if (!clip) return res.status(404).json({ error: "not found" });
    const [job, persona] = await Promise.all([store.getJob(pool, clip.job_id), store.getPersona(pool, clip.persona_id)]);
    if (!persona) return res.status(409).json({ error: "That audience no longer exists." });
    const taste = tasteFromRatings(await store.ratedClips(pool, persona.id));
    let caption;
    try {
      caption = await regenerateCaption(persona, findMoment(job && job.analysis, clip), { taste, avoid: [clip.caption] });
    } catch (e) {
      console.error("[meme-builder] regenerateCaption failed:", e && e.message);
      return res.status(e instanceof KieError ? 503 : 500).json({ error: friendlyMessage(e) });
    }
    res.json({ clip: clipJson(await applyCaption(clip, caption)) });
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
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    let range = null;
    if (m && (m[1] || m[2])) {
      const total = await storage.sizeOf(clip.storage_uri);
      const start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
      if (start >= total || start > end) return res.status(416).set("Content-Range", `bytes */${total}`).end();
      range = { start, end };
    }
    const f = await storage.openRead(clip.storage_uri, range);
    const headers = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=300" };
    if (req.query.download) headers["Content-Disposition"] = `attachment; filename="${(clip.caption || "clip").replace(/[^\w ]+/g, "").trim().slice(0, 60).replace(/\s+/g, "-") || "clip"}.mp4"`;
    if (range) {
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${f.start}-${f.end}/${f.size}`, "Content-Length": f.end - f.start + 1 });
    } else {
      res.writeHead(200, { ...headers, "Content-Length": f.size });
    }
    f.stream.on("error", () => res.destroy());
    f.stream.pipe(res);
  }));
}

module.exports = { registerMemeBuilderRoutes, parseOptions, clipJson, findMoment };
