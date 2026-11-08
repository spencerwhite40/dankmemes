"use strict";
// Things done to a finished clip, shared by the web page and the public API.
const store = require("./lib/store");
const storage = require("./lib/storage");
const { regenerateCaption } = require("./lib/captions");
const { tasteFromRatings } = require("./lib/personas");
const { KieError, friendlyMessage } = require("./lib/kie");
const { rerenderClip } = require("./lib/pipeline");
const { HttpError } = require("./errors");

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

/** Burn a new caption into a clip: re-render from the stored source, swap the file, update the row. */
async function applyCaption(pool, clip, caption) {
  const newUri = await rerenderClip(pool, clip, caption);
  const oldUri = clip.storage_uri;
  await pool.query("update public.meme_builder_clips set storage_uri = $2 where id = $1", [clip.id, newUri]);
  const updated = await store.updateClipCaption(pool, clip.id, caption);
  await storage.remove(oldUri).catch(() => {});
  return updated;
}

/** The AI writes a fresh caption (a different angle from the current one) and it is burned in. */
async function regenerate(pool, clip) {
  const job = await store.getJob(pool, clip.job_id);
  const persona = await store.getPersona(pool, clip.persona_id, job && job.owner_id);
  if (!persona) throw new HttpError(409, "That audience no longer exists.", "no_audience");
  const taste = tasteFromRatings(await store.ratedClips(pool, persona.id, job && job.owner_id));
  let caption;
  try {
    caption = await regenerateCaption(persona, findMoment(job && job.analysis, clip), { taste, avoid: [clip.caption] });
  } catch (e) {
    console.error("[meme-builder] regenerateCaption failed:", e && e.message);
    throw new HttpError(e instanceof KieError ? 503 : 500, friendlyMessage(e), "caption_failed");
  }
  return applyCaption(pool, clip, caption);
}

/** Stream a clip's video (Range requests supported); download=true forces a download. */
async function streamClipVideo(req, res, clip, { download = false } = {}) {
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
  if (download) headers["Content-Disposition"] = `attachment; filename="${(clip.caption || "clip").replace(/[^\w ]+/g, "").trim().slice(0, 60).replace(/\s+/g, "-") || "clip"}.mp4"`;
  if (range) res.writeHead(206, { ...headers, "Content-Range": `bytes ${f.start}-${f.end}/${f.size}`, "Content-Length": f.end - f.start + 1 });
  else res.writeHead(200, { ...headers, "Content-Length": f.size });
  f.stream.on("error", () => res.destroy());
  f.stream.pipe(res);
}

module.exports = { findMoment, applyCaption, regenerate, streamClipVideo };
