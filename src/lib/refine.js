"use strict";

// Meme Builder: check each chosen clip against a short excerpt before rendering.
//
// The first pass finds moments in the whole video, where the AI's timestamps
// drift (more on long videos). For each clip we cut a short excerpt around it
// and ask the model, looking at just that excerpt, (1) is this moment really in
// here, and (2) exactly where should it start and end. Timestamps inside a
// 30 second excerpt are far more accurate than inside a 12 minute video, and a
// clip whose quoted line isn't there (the "completely wack" match) is dropped.
// If a check can't be done, the clip keeps its original times: this step only
// ever improves a clip, it never blocks one.

const path = require("node:path");
const ai = require("./ai");
const media = require("./media");
const { parseTime, MAX_CLIP_SEC } = require("./analyze");
const { mapLimit } = require("./cuts");

const BEFORE_SEC = 8;    // room before the AI's start, for the setup
const AFTER_SEC = 10;    // room after the AI's end, for a punchline that runs long

const LETTERS = ["A", "B", "C"];
const FIT_DROP = 3;          // a fit this low or lower means the clip does not deliver any of the captions

function buildVerifyPrompt(moment, windowSec, candidates = []) {
  const kind = moment.kind === "bit" ? "a longer take where the buildup matters" : "a quick reaction beat";
  const caps = candidates.slice(0, 3);
  const captionPart = caps.length
    ? `\nThis clip is going to be used as a REACTION MEME: a caption is shown on screen and this clip is the reaction. ` +
      `The caption describes a situation from the viewer's life, and the clip should be the perfect reaction to it, even though the clip is about something else. ` +
      `Here are the candidate captions:\n${caps.map((c, i) => `${LETTERS[i]}. ${c}`).join("\n")}\n` +
      `3. Watch and LISTEN to the moment. Which caption does it deliver best? Judge the FEELING and the dynamic (does the tone, face and timing match the situation?) ` +
      `and whether the spoken words clash with the caption. Give "pick" as the letter, or "none" if it does not deliver any of them, and "fit" from 1 to 10 ` +
      `(1-3 it does not work, 4-6 it half works, 7-10 it lands as a reaction).\n`
    : "";
  return (
    `This is a short excerpt (about ${Math.round(windowSec)} seconds) cut from a longer video. It should contain this moment:\n` +
    `- what is said: "${moment.transcript}"\n` +
    `- what kind: ${kind}\n` +
    (moment.context ? `- context: ${moment.context}\n` : "") +
    `\n1. Is that moment actually in this excerpt? The wording can differ slightly, but it must be the same moment.\n` +
    `2. If it is, say where it should be cut, in SECONDS FROM THE START OF THIS EXCERPT (decimals are fine). ` +
    `Begin where the setup or thought begins (for a quick reaction, just before the speaker starts) and end just after it lands, ` +
    `including the laugh or the reaction beat. Never start or end in the middle of a word or a sentence. Include the whole punchline.\n` +
    captionPart +
    `\nReply with ONLY JSON: {"found": true or false, "start": seconds, "end": seconds${caps.length ? ', "pick": "A" | "B" | "C" | "none", "fit": 1-10' : ""}}`
  );
}

/**
 * Validate the model's answer. Returns { found:false } | { found:true, startSec, endSec, pick?, fit? } (times relative to the excerpt) | null if unusable.
 * pick is the index of the chosen caption (-1 for "none"), fit is 1-10; both are absent when the answer didn't include them.
 */
function parseVerdict(raw, windowSec) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!(raw.found === true || raw.found === "true")) return raw.found === false || raw.found === "false" ? { found: false } : null;
  let s, e;
  try { s = parseTime(raw.start); e = parseTime(raw.end); } catch { return null; }
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  s = Math.max(0, s);
  e = Math.min(windowSec, e);
  if (e - s < 1 || e - s > MAX_CLIP_SEC) return null;
  const out = { found: true, startSec: s, endSec: e };
  const letter = String(raw.pick == null ? "" : raw.pick).trim().toUpperCase();
  if (letter === "NONE") out.pick = -1;
  else if (LETTERS.includes(letter)) out.pick = LETTERS.indexOf(letter);
  const fit = Number(raw.fit);
  if (Number.isFinite(fit)) out.fit = Math.max(1, Math.min(10, fit));
  return out;
}

/**
 * picked: [{ score, best, candidates?, moment: { startSec, endSec, transcript, kind, context, ... } }].
 * Each clip is cut to a short excerpt and the video model, which actually watches and hears it, (1) confirms the moment is there,
 * (2) fixes the exact start and end, and (3) says which caption candidate the clip delivers best, and how well.
 * A clip no caption fits is dropped. The pick and the fit replace the writer's own choice and score: the grade comes from the one that saw the clip.
 * Returns { clips, dropped, unverified, nofit }.
 */
async function refineMoments(picked, { sourceFile, workDir, duration, onProgress, concurrency = 3, makeExcerpt = media.makeExcerpt, upload = ai.uploadFile, chat = ai.chatJSON } = {}) {
  let done = 0;
  const results = await mapLimit(picked, concurrency, async (c, i) => {
    const m = c.moment;
    const a = Math.max(0, m.startSec - BEFORE_SEC);
    const b = Math.min(duration || Infinity, m.endSec + AFTER_SEC);
    const windowSec = b - a;
    const file = path.join(workDir, `excerpt-${i + 1}.mp4`);
    const cands = Array.isArray(c.candidates) && c.candidates.length ? c.candidates.slice(0, 3) : (c.best ? [c.best] : []);
    let outcome;
    try {
      await makeExcerpt(sourceFile, a, windowSec, file);
      const url = await upload(file, { uploadPath: "meme-builder/excerpts" });
      const raw = await chat({
        models: ai.videoModels(),
        maxTokens: 500,
        retries: 2,
        messages: [{ role: "user", content: [{ type: "text", text: buildVerifyPrompt(m, windowSec, cands) }, { type: "media", url }] }],
      });
      const verdict = parseVerdict(raw, windowSec);
      if (!verdict) outcome = { clip: c, verified: false };
      else if (!verdict.found) outcome = { clip: null, verified: true, reason: "missing" };
      else {
        const refined = { ...c, moment: { ...m, startSec: a + verdict.startSec, endSec: a + verdict.endSec } };
        const noFit = cands.length && (verdict.pick === -1 || (verdict.fit != null && verdict.fit <= FIT_DROP));
        if (noFit) outcome = { clip: null, verified: true, reason: "nofit" };
        else {
          if (cands.length && verdict.pick != null && verdict.pick >= 0 && cands[verdict.pick]) refined.best = cands[verdict.pick];
          if (verdict.fit != null) refined.score = verdict.fit;
          refined.fit = verdict.fit;
          outcome = { clip: refined, verified: true };
        }
      }
    } catch (err) {
      console.error(`[meme-builder] verifying clip ${i + 1}/${picked.length} failed, keeping its original times:`, err && err.message);
      outcome = { clip: c, verified: false };
    } finally {
      require("node:fs").promises.rm(file, { force: true }).catch(() => {});
    }
    done += 1;
    if (onProgress) { try { await onProgress(done, picked.length); } catch { /* progress is best effort */ } }
    return outcome;
  });

  let clips = results.filter((r) => r.clip).map((r) => r.clip);
  const dropped = results.filter((r) => !r.clip).length;
  const nofit = results.filter((r) => r.reason === "nofit").length;
  const unverified = results.filter((r) => r.clip && !r.verified).length;
  // If the check rejected everything, the check is the suspect, not every clip: keep the originals.
  if (!clips.length && picked.length) clips = picked;
  const all = clips === picked;
  return { clips, dropped: all ? 0 : dropped, nofit: all ? 0 : nofit, unverified: all ? picked.length : unverified };
}

module.exports = { refineMoments, buildVerifyPrompt, parseVerdict, BEFORE_SEC, AFTER_SEC, FIT_DROP };
