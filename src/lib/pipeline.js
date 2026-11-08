"use strict";

// Meme Builder job pipeline: one queued job -> clips in storage + rows.
//
//   fetch    source video onto local disk (from storage, or download a direct link and store it)
//   prepare  probe it
//   upload   small analysis copy -> KIE temp host            (skipped when analysis is cached)
//   analyze  a video model watches it, flags reaction moments (skipped when cached)
//   captions the audience persona writes + scores captions, taste from past 👍/👎
//   render   cut + vertical layout + burned caption, store each clip
//
// Analysis is audience-agnostic and cached on the job, so a re-caption for
// another audience skips upload + analyze (the slow, expensive part).

const fs = require("node:fs");
const path = require("node:path");

const store = require("./store");
const storage = require("./storage");
const media = require("./media");
const { analyzeVideo, planSpans, fallbackSpans, ANALYSIS_VERSION } = require("./analyze");
const { writeCaptions, selectClips } = require("./captions");
const { refineMoments } = require("./refine");
const { snapBounds, dropOverlaps, mapLimit } = require("./cuts");
const { renderClip } = require("./render");
const { uploadFile } = require("./kie");
const { tasteFromRatings } = require("./personas");

// Every captioned moment becomes a clip (best first); the score is a label, not a filter. A minimum score can be set in Options.
const DEFAULTS = { minScore: 1, maxClips: 30, minClips: 5 };

async function processJob(pool, job, { log = console } = {}) {
  const workDir = await storage.makeWorkDir(job.id);
  const stage = (name, info) => store.setStage(pool, job.id, name, info);
  // Heartbeat the whole time the run is alive, so a slow step (a long AI call, a slow render) is never mistaken for a dead run.
  const heartbeat = setInterval(() => { store.touchJob(pool, job.id).catch(() => {}); }, 30 * 1000);
  if (heartbeat.unref) heartbeat.unref();
  try {
    // fetch
    await stage("fetch");
    const sourceFile = path.join(workDir, "source.mp4");
    if (job.source_uri) {
      try {
        await storage.downloadToFile(job.source_uri, sourceFile);
      } catch (err) {
        throw storage.isNotFound(err) ? new Error(storage.SOURCE_GONE) : err;
      }
    } else if (job.source_url) {
      await media.downloadUrl(job.source_url, sourceFile);
      const uri = await storage.putFile(sourceFile, `${job.id}/source.mp4`, "video/mp4");
      await store.patchJob(pool, job.id, { source_uri: uri });
    } else {
      throw new Error("This job has no video source.");
    }

    // prepare
    await stage("prepare");
    const meta = job.video_meta || await media.probe(sourceFile);
    if (!job.video_meta) await store.patchJob(pool, job.id, { video_meta: meta });

    // upload + analyze (cached across re-captions). An analysis saved by an older version is redone.
    let moments = job.analysis;
    if (!Array.isArray(moments) || !moments.every((m) => m && m.v >= ANALYSIS_VERSION)) {
      await stage("upload");
      // Normal videos go up as one small copy and are watched in one go. Only very long ones are cut into pieces up front.
      const cutAndUpload = async (spans) => {
        const segments = [];
        let uploaded = 0;
        await mapLimit(spans, 2, async ([a, b], i) => {
          const file = path.join(workDir, `analysis-${spans.length}-${i}.mp4`);
          if (spans.length === 1) await media.makeAnalysisProxy(sourceFile, file);
          else await media.makeAnalysisSegment(sourceFile, a, b - a, file);
          const url = await uploadFile(file, { uploadPath: `meme-builder/${job.id}` });
          segments[i] = { url, offsetSec: a, lengthSec: spans.length === 1 ? meta.duration : b - a };
          await fs.promises.rm(file, { force: true }).catch(() => {});
          uploaded += 1;
          await stage("upload", { total: spans.length, done: uploaded });
        });
        return segments;
      };
      const spans = planSpans(meta.duration);
      const segments = await cutAndUpload(spans);
      await stage("analyze", { total: segments.length });
      const pieces = spans.length === 1 ? fallbackSpans(meta.duration) : null;
      try {
        moments = await analyzeVideo(segments, { duration: meta.duration, attempts: pieces ? 2 : 3 });
      } catch (err) {
        // The AI service drops long answers now and then. Retry with shorter pieces (shorter answers) before giving up.
        if (!pieces) throw err;
        if (log.warn) log.warn("[meme-builder] watching the whole video failed, retrying in smaller pieces:", err && err.message);
        await stage("upload");
        const small = await cutAndUpload(pieces);
        await stage("analyze", { total: small.length });
        moments = await analyzeVideo(small, { duration: meta.duration });
      }
      await store.patchJob(pool, job.id, { analysis: moments });
    }
    await stage("analyzed", { moments: moments.length });
    if (!moments.length) throw new Error("The model didn't find any reaction-worthy moments in this video. Try a video with more conflict, emotion or banter.");

    // captions
    await stage("captions", { moments: moments.length });
    const persona = await store.getPersona(pool, job.persona_id);
    if (!persona) throw new Error(`Audience "${job.persona_id}" no longer exists.`);
    const taste = tasteFromRatings(await store.ratedClips(pool, persona.id));
    const captionModels = new Set();
    const captionStats = {};
    const ranked = await writeCaptions(persona, moments, {
      taste, stats: captionStats,
      onModel: (m) => captionModels.add(m),
      onChunk: (done, total) => stage("captions", { moments: moments.length, chunk: done, chunks: total }),
    });
    const opts = { ...DEFAULTS, ...(job.options || {}) };
    const selected = selectClips(ranked, opts);
    const { lowConfidence } = selected;
    if (!selected.picked.length) throw new Error("The AI couldn't write usable captions for this video. Try again, or try a different audience.");
    await stage("selected", { candidates: ranked.length, kept: selected.picked.length, minScore: opts.minScore, lowConfidence });

    // verify: check each chosen clip against a short excerpt, and fix its exact start and end
    await stage("verify", { total: selected.picked.length, done: 0 });
    const refined = await refineMoments(selected.picked, {
      sourceFile, workDir, duration: meta.duration,
      onProgress: (done, total) => stage("verify", { total, done }),
    });
    const picked = dropOverlaps(refined.clips);

    // render + store
    const renderInfo = {
      count: picked.length, candidates: ranked.length, kept: picked.length, minScore: opts.minScore, lowConfidence,
      captionModel: [...captionModels].join(", "), captionBatches: captionStats.batches, captionBatchesFailed: captionStats.failed, verifyDropped: refined.dropped, noFit: refined.nofit, unverified: refined.unverified,
      noAudio: meta.hasAudio === false,
    };
    await stage("render", { ...renderInfo, done: 0 });
    // Snap each clip's edges to the pauses in the speech (once per video), so nothing is cut mid-word.
    let silences = [];
    try { silences = await media.detectSilences(sourceFile); } catch (err) { if (log.warn) log.warn("[meme-builder] pause detection failed, using padding only:", err && err.message); }
    // A re-run starts from nothing: drop the old rows now, delete their files after the new ones exist.
    const oldUris = await store.clearClips(pool, job.id);
    let saved = 0, failedClips = 0, lastRenderErr = null;
    const audioCounts = { none: 0, ok: 0, boosted: 0, trimmed: 0, rejected: 0 };
    for (const [i, c] of picked.entries()) {
      const name = `clip-${String(i + 1).padStart(2, "0")}.mp4`;
      const out = path.join(workDir, name);
      try {
        const cut = snapBounds(c.moment, silences, meta.duration);
        await renderClip({ source: sourceFile, startSec: cut.startSec, endSec: cut.endSec, caption: c.best, out, onAudio: (status) => { audioCounts[status] = (audioCounts[status] || 0) + 1; } });
        const uri = await storage.putFile(out, `${job.id}/${Date.now()}-${name}`, "video/mp4");
        // Saved the moment it exists: the page shows it (and the Library lists it) while the rest still render.
        // The stored times are the ones actually rendered, so a later caption edit re-renders the identical cut.
        saved += 1;
        await store.addClip(pool, job.id, persona.id, saved, { caption: c.best, score: c.score, why: c.why, transcript: c.moment.transcript, emotion: c.moment.emotion, startSec: cut.startSec, endSec: cut.endSec, storageUri: uri }, job.created_by);
      } catch (err) {
        // One bad clip must not cost the other eleven.
        failedClips += 1; lastRenderErr = err;
        if (log.error) log.error(`[meme-builder] clip ${i + 1}/${picked.length} failed, continuing:`, err && err.message);
      }
      await fs.promises.rm(out, { force: true }).catch(() => {});
      await stage("render", { ...renderInfo, done: i + 1, failed: failedClips, audio: { ...audioCounts } });
    }
    if (saved === 0) throw lastRenderErr || new Error("None of the clips could be rendered.");
    for (const u of oldUris) await storage.remove(u).catch((e) => log.warn && log.warn("[meme-builder] cleanup:", e.message));
    await store.finishJob(pool, job.id);
  } finally {
    clearInterval(heartbeat);
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Re-render one clip with new caption text (used by the "Update caption" button). */
async function rerenderClip(pool, clip, caption) {
  const job = await store.getJob(pool, clip.job_id);
  if (!job || !job.source_uri) throw new Error("The source video for this clip is no longer stored.");
  const workDir = await storage.makeWorkDir(`rerender-${clip.id}`);
  try {
    const sourceFile = path.join(workDir, "source.mp4");
    try {
      await storage.downloadToFile(job.source_uri, sourceFile);
    } catch (err) {
      throw storage.isNotFound(err) ? new Error(storage.SOURCE_GONE) : err;
    }
    const out = path.join(workDir, "clip.mp4");
    await renderClip({ source: sourceFile, startSec: Number(clip.start_sec), endSec: Number(clip.end_sec), caption, out });
    const uri = await storage.putFile(out, `${job.id}/${Date.now()}-clip-${String(clip.n).padStart(2, "0")}.mp4`, "video/mp4");
    return uri;
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { processJob, rerenderClip, DEFAULTS };
