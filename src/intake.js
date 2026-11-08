"use strict";
// Starting a run, shared by the web page and the public API so both behave identically:
// validate the audience, take the video (an uploaded file or a direct link), create the job, wake the runner.
const crypto = require("node:crypto");
const path = require("node:path");

const store = require("./lib/store");
const storage = require("./lib/storage");
const media = require("./lib/media");
const { notifyJobQueued } = require("./lib/queue-signal");
const accounts = require("./accounts");
const { HttpError } = require("./errors");

const clampInt = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
};

/** Per-run options a caller can set. Unknown keys are ignored. */
function parseOptions(body) {
  const o = {};
  if (body.minScore !== undefined && body.minScore !== "") o.minScore = clampInt(body.minScore, 1, 10, 1);
  if (body.maxClips !== undefined && body.maxClips !== "") o.maxClips = clampInt(body.maxClips, 1, 60, 30);
  return o;
}

const SOCIAL_HOSTS = /(^|\.)(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|vimeo\.com)$/i;
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ""; } };

/**
 * owner: { ownerId, apiKeyId? }.  input: { personaId, sourceUrl?, file?: { path, originalname, mimetype }, options?, webhookUrl?, idempotencyKey? }.
 * Returns { job, created } (created is false when an idempotency key matched an earlier run).
 */
async function createRun(pool, owner, input) {
  const personaId = typeof input.personaId === "string" ? input.personaId : "";
  if (!(await store.getPersona(pool, personaId, owner.ownerId))) throw new HttpError(400, "Pick an audience first.", "bad_audience");

  if (input.idempotencyKey) {
    const prior = await store.findJobByIdempotencyKey(pool, owner.ownerId, input.idempotencyKey);
    if (prior) return { job: prior, created: false };
  }
  const options = { ...parseOptions(input.options || {}) };
  const fitToPlan = (plan) => { options.maxClips = Math.min(options.maxClips || plan.clipsPerRun, plan.clipsPerRun); return plan; };
  if (input.webhookUrl) {
    try { await media.assertPublicUrl(input.webhookUrl); } catch (e) { throw new HttpError(400, `webhook_url: ${e.message}`, "bad_webhook"); }
    options.webhookUrl = input.webhookUrl;
  }
  if (input.idempotencyKey) options.idempotencyKey = String(input.idempotencyKey).slice(0, 120);
  const base = { personaId, options, ownerId: owner.ownerId, apiKeyId: owner.apiKeyId || null };

  if (input.file) {
    // What the account's plan allows: minutes left, runs at once, upload size, storage.
    const plan = fitToPlan(await accounts.assertCanStart(pool, owner.ownerId, { fileBytes: Number(input.file.size) || 0 }));
    let info;
    try { info = await media.probe(input.file.path); } catch { throw new HttpError(400, "That file doesn't look like a video we can read (try mp4 or mov).", "bad_video"); }
    if (info.duration > plan.maxVideoMinutes * 60) throw new HttpError(413, `That video is ${Math.round(info.duration / 60)} minutes. The ${plan.label} plan allows up to ${plan.maxVideoMinutes}.`, "video_too_long");
    const id = crypto.randomUUID();
    const ext = (path.extname(input.file.originalname || "") || ".mp4").toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 8) || ".mp4";
    const uri = await storage.putFile(input.file.path, `${id}/source${ext}`, input.file.mimetype || "video/mp4");
    const job = await store.createJob(pool, { ...base, id, sourceKind: "upload", sourceLabel: (input.file.originalname || "upload").slice(0, 200), sourceUri: uri, sourceBytes: Number(input.file.size) || 0 });
    notifyJobQueued();
    return { job, created: true };
  }

  const sourceUrl = typeof input.sourceUrl === "string" ? input.sourceUrl.trim() : "";
  if (!sourceUrl) throw new HttpError(400, "Upload a video file or give a direct video link.", "no_video");
  if (SOCIAL_HOSTS.test(hostOf(sourceUrl))) {
    throw new HttpError(400, "Links to YouTube, TikTok and similar sites can't be downloaded from the server. Download the video and upload the file, or give a direct link to the video file (.mp4).", "unsupported_link");
  }
  try { await media.assertPublicUrl(sourceUrl); } catch (e) { throw new HttpError(400, e.message, "bad_link"); }
  fitToPlan(await accounts.assertCanStart(pool, owner.ownerId, { fileBytes: 0 }));
  const label = decodeURIComponent(sourceUrl.split("?")[0].split("/").pop() || sourceUrl).slice(0, 200);
  const job = await store.createJob(pool, { ...base, sourceKind: "url", sourceLabel: label, sourceUrl });
  notifyJobQueued();
  return { job, created: true };
}

/** Make clips from a video that is already stored (no upload), for the same or another audience. */
async function rerun(pool, owner, parentId, input) {
  const parent = await store.getJob(pool, parentId);
  if (!parent || parent.owner_id !== owner.ownerId) throw new HttpError(404, "not found", "not_found");
  if (!parent.source_uri) throw new HttpError(409, "The source video for this run isn't stored yet.", "no_source");
  const personaId = typeof input.personaId === "string" ? input.personaId : "";
  if (!(await store.getPersona(pool, personaId, owner.ownerId))) throw new HttpError(400, "Pick an audience.", "bad_audience");
  const plan = await accounts.assertCanStart(pool, owner.ownerId, { fileBytes: 0 });
  const options = { ...(parent.options || {}), ...parseOptions(input.options || input) };
  options.maxClips = Math.min(options.maxClips || plan.clipsPerRun, plan.clipsPerRun);
  delete options.idempotencyKey;
  if (input.webhookUrl) {
    try { await media.assertPublicUrl(input.webhookUrl); } catch (e) { throw new HttpError(400, `webhook_url: ${e.message}`, "bad_webhook"); }
    options.webhookUrl = input.webhookUrl;
  } else delete options.webhookUrl;
  const job = await store.createJob(pool, {
    ownerId: owner.ownerId, apiKeyId: owner.apiKeyId || null, personaId,
    sourceKind: parent.source_kind, sourceLabel: parent.source_label, sourceUrl: parent.source_url,
    sourceUri: parent.source_uri, parentJobId: parent.id, analysis: parent.analysis, videoMeta: parent.video_meta, options,
  });
  notifyJobQueued();
  return { job, created: true };
}

module.exports = { createRun, rerun, parseOptions };
