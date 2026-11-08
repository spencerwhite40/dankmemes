"use strict";

// Meme Builder step 1: a video-capable model WATCHES the content and picks the
// moments worth turning into clips. Deliberately audience-agnostic (it describes
// what happens), so the same analysis can be re-captioned for any persona
// without watching the video again.
//
// The agent is given a GOAL, not length rules: it decides how long each moment
// needs to be. A quick reaction can be a few seconds; a rant or a story that
// builds to a payoff can run a minute. The only hard limit is a loose safety
// cap so a nonsense answer can't produce an hour-long "clip".

const { chatJSON, videoModels } = require("./ai");

const MAX_CLIP_SEC = 150;          // sanity cap, not a quality standard
const KINDS = ["reaction", "bit"];

function parseTime(t) {
  if (typeof t === "number") return t;
  const parts = String(t).trim().split(":").map(Number);
  if (!parts.length || parts.some(Number.isNaN)) throw new Error(`bad timestamp: ${t}`);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/** How many candidates to aim for in one pass: about one per 25s of video, between 8 and 24. */
function wantedMoments(duration) {
  return duration ? Math.min(40, Math.max(8, Math.round(duration / 25))) : 15;
}

const ANALYSIS_VERSION = 3;        // bump to make older saved analyses get redone
const SINGLE_PASS_MAX_SEC = 1500;  // up to 25 minutes is watched in one go: the model keeps the whole video in mind and nothing is cut at an edge
const SPAN_SEC = 600;              // only longer videos are cut into pieces, and each piece reaches 30s into the next so nothing is lost at an edge
const SPAN_OVERLAP_SEC = 30;
const FALLBACK_SPAN_SEC = 240;     // used only when the AI service keeps failing on the whole video: shorter answers are more reliable
const FALLBACK_OVERLAP_SEC = 20;
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Stretches of the video to ask about: [[startSec, endSec], ...]. Normal videos are one stretch. Pure. */
function planSpans(duration) {
  if (!duration || duration <= SINGLE_PASS_MAX_SEC) return [[0, duration || 0]];
  const spans = [];
  for (let a = 0; a < duration; a += SPAN_SEC) spans.push([a, Math.min(duration, a + SPAN_SEC + SPAN_OVERLAP_SEC)]);
  // a leftover tail shorter than 2 minutes is folded into the stretch before it
  if (spans.length > 1 && duration - (spans.length - 1) * SPAN_SEC < 120) {
    spans.pop();
    spans[spans.length - 1][1] = duration;
  }
  return spans;
}

/** Smaller pieces to retry with when watching the whole video keeps failing (null when the video is already short). Pure. */
function fallbackSpans(duration) {
  if (!duration || duration <= FALLBACK_SPAN_SEC + 60) return null;
  const spans = [];
  for (let a = 0; a < duration; a += FALLBACK_SPAN_SEC) spans.push([a, Math.min(duration, a + FALLBACK_SPAN_SEC + FALLBACK_OVERLAP_SEC)]);
  if (spans.length > 1 && duration - (spans.length - 1) * FALLBACK_SPAN_SEC < 60) {
    spans.pop();
    spans[spans.length - 1][1] = duration;
  }
  return spans;
}

const DYNAMICS = ["condescension", "dodging", "caught", "exasperation", "disbelief", "smug", "deadpan", "defeat", "pleading", "polite-rage", "vindication", "pride", "confusion", "cringe", "panic", "warmth", "confidence", "other"];

function buildPrompt(duration) {
  return (
    `You are scouting REACTION CLIPS for short-form video memes. Watch this video carefully (picture AND audio). ` +
    `It is ${duration ? `${Math.round(duration)} seconds long` : "long-form content"}.\n\n` +
    `HOW THESE MEMES WORK: a caption describes a situation from someone's life ("When the broker offers 20% under spot"), ` +
    `and the clip is the reaction that perfectly fits that feeling, even though the clip is about something completely different. ` +
    `So the topic of the clip does not matter. What matters is the FEELING and the social dynamic (someone being condescending, ` +
    `dodging a question, getting caught, losing patience, being smug, quietly giving up) and how clearly it comes across.\n\n` +
    `GOAL: find every moment that shows ONE clear feeling or dynamic that people would recognise from their own lives and want to reuse. ` +
    `Strong delivery (voice, face, timing) beats clever content. A clear feeling understood in the first two seconds is ideal.\n\n` +
    `Clips come in many sizes and you decide each one:\n` +
    `- "reaction": a quick beat: one line, one look, one pause. The viewer reads the caption for about two seconds before the reaction lands, ` +
    `so give it room: include the beat of lead-in before the line and the beat after it, usually 6 to 15 seconds in all. ` +
    `A very short punchline (a second or two) still needs those seconds around it. Most picks will be these.\n` +
    `- "bit": a longer take where the buildup matters (20 to 60 seconds, longer if needed), such as someone confidently explaining something, ` +
    `a rant, a story that escalates, a setup and payoff. Only when the whole thing carries one clear dynamic.\n\n` +
    `Be generous: aim for about ${wantedMoments(duration)} moments or more, spread across the WHOLE video. ` +
    `A moment does not need to be the best thing in the video, it only needs to show a clear, reusable feeling. ` +
    `Skip moments where nothing is clearly felt or the meaning depends on a long explanation.\n\n` +
    `Begin where the setup or the thought begins and end just after it lands (include the laugh, the reaction, the beat). ` +
    `Never start or end in the middle of a word or a sentence.\n\n` +
    `Timestamps are MM:SS (or HH:MM:SS) from the start of the video, as precise as you can make them. ` +
    `Quote the words spoken exactly. Only describe things that really happen in this video.\n\n` +
    `Reply with ONLY a JSON array. Each item:\n` +
    `{ "start": "MM:SS", "end": "MM:SS", "kind": "reaction" | "bit", "transcript": "exact words spoken in the clip", ` +
    `"context": "one or two sentences: what is going on", ` +
    `"emotion": "the one clear feeling, one or two words", ` +
    `"dynamic": one of ${DYNAMICS.map((d) => `"${d}"`).join(", ")}, ` +
    `"intensity": 1-10 (how strongly it comes across), ` +
    `"words": "neutral" if the spoken words are generic reaction language that would fit any topic (e.g. "there's no way", "you have no idea what you're talking about"), ` +
    `or "topic" if the words are about a specific subject that would clash with an unrelated caption, ` +
    `"delivery": "how it is said/shown (tone, face, gesture)", ` +
    `"reaction_use": "what kind of everyday situation this clip is a perfect reaction to, in general terms", ` +
    `"strength": 1-10 (how reusable and clear overall) }`
  );
}

const words = (t) => new Set(String(t || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean));
/** Same quote said twice? (A model that loses its place tends to repeat itself at a later timestamp.) Pure. */
function sameQuote(a, b) {
  const x = words(a), y = words(b);
  if (x.size < 5 || y.size < 5) return false;
  let both = 0; for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both) >= 0.6;
}

/** Merge moments from several stretches: drop near-duplicates (keep the stronger), sort by time, renumber m1..mN. Pure. */
function mergeMoments(lists) {
  const all = lists.flat().sort((a, b) => (b.strength || 0) - (a.strength || 0));
  const kept = [];
  for (const m of all) {
    const dup = kept.some((k) => {
      const overlap = Math.min(m.endSec, k.endSec) - Math.max(m.startSec, k.startSec);
      return overlap > 0.5 * Math.min(m.endSec - m.startSec, k.endSec - k.startSec) || sameQuote(m.transcript, k.transcript);
    });
    if (!dup) kept.push(m);
  }
  return kept.sort((a, b) => a.startSec - b.startSec).map((m, i) => ({ ...m, id: `m${i + 1}` }));
}

/**
 * segments: [{ url, offsetSec, lengthSec }]: the video cut into real pieces, each uploaded separately, so the model only
 * ever sees the minutes it is asked about (asking it to "look only at 3:00 to 6:00" of a whole video made it lose its place).
 * A bare URL string means the whole video is one piece. Timestamps come back relative to the piece; the offset is added here.
 */
async function analyzeVideo(input, { duration, chat = chatJSON, concurrency = 2, attempts = 3 } = {}) {
  const segments = typeof input === "string" ? [{ url: input, offsetSec: 0, lengthSec: duration }] : input;
  const results = new Array(segments.length);
  let next = 0, failures = 0, lastErr = null;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= segments.length) return;
      const seg = segments[i];
      let ok = false;
      // Each piece gets its own tries: the AI service drops the odd request, and one drop must not cost the whole video.
      for (let attempt = 0; attempt < attempts && !ok; attempt++) {
        try {
          const raw = await chat({
            models: videoModels(),
            maxTokens: 10000,
            retries: 3,
            messages: [{ role: "user", content: [{ type: "text", text: buildPrompt(seg.lengthSec) }, { type: "media", url: seg.url }] }],
          });
          if (!Array.isArray(raw)) throw new Error("analysis did not return an array");
          results[i] = normalizeMoments(raw, seg.lengthSec).map((m) => ({ ...m, startSec: m.startSec + seg.offsetSec, endSec: m.endSec + seg.offsetSec }));
          ok = true;
        } catch (err) {
          lastErr = err;
          console.error(`[meme-builder] watching piece ${i + 1}/${segments.length} failed (try ${attempt + 1}/${attempts}):`, err && err.message);
        }
      }
      if (!ok) { failures++; results[i] = []; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, segments.length) }, worker));
  if (failures === segments.length) throw lastErr;     // nothing at all: let the run retry itself
  return mergeMoments(results);
}

/** Validate + clamp raw model output into usable moments. Pure, unit-tested. */
function normalizeMoments(moments, duration) {
  return moments
    .map((m, i) => {
      try {
        return { id: `m${i + 1}`, ...m, startSec: parseTime(m.start), endSec: parseTime(m.end) };
      } catch { return null; }
    })
    .filter((m) => m && m.endSec - m.startSec >= 1 && (!duration || m.startSec < duration))
    .map((m) => ({ ...m, endSec: duration ? Math.min(m.endSec, duration) : m.endSec }))
    .filter((m) => m.endSec - m.startSec >= 1 && m.endSec - m.startSec <= MAX_CLIP_SEC)
    .map((m) => ({
      ...m,
      // The agent labels its own moments; if it didn't, longer ones are treated as bits.
      v: ANALYSIS_VERSION,
      dynamic: DYNAMICS.includes(m.dynamic) ? m.dynamic : "other",
      words: m.words === "topic" ? "topic" : "neutral",
      intensity: Number.isFinite(Number(m.intensity)) ? Math.max(1, Math.min(10, Number(m.intensity))) : 5,
      kind: KINDS.includes(m.kind) ? m.kind : (m.endSec - m.startSec >= 15 ? "bit" : "reaction"),
      context: typeof m.context === "string" ? m.context : "",
    }));
}

module.exports = { DYNAMICS, analyzeVideo, normalizeMoments, parseTime, wantedMoments, planSpans, fallbackSpans, mergeMoments, sameQuote, buildPrompt, ANALYSIS_VERSION, MAX_CLIP_SEC, KINDS };
