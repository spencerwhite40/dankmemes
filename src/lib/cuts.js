"use strict";

// Where a clip starts and ends. Pure helpers, unit-tested.
//
// The AI's timestamps are only good to a second or two, and drift on longer
// videos, so a cut taken straight from them can land mid-word and clip the end
// of a punchline. We fix the edges against the audio: speech starts when a
// pause ends and finishes when the next pause begins.

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Parse ffmpeg `silencedetect` stderr into [{ start, end }] in seconds.
 * A pause that runs to the end of the file has end = Infinity.
 */
function parseSilences(text) {
  const out = [];
  let start = null;
  for (const m of String(text || "").matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    const t = Number(m[2]);
    if (m[1] === "start") start = Math.max(0, t);
    else if (start !== null) { out.push({ start, end: t }); start = null; }
  }
  if (start !== null) out.push({ start, end: Infinity });
  return out;
}

/**
 * Move a clip's edges to the nearest pause in the speech.
 *  - start: the end of the closest pause at or before the AI's start (speech begins when it ends),
 *           looking back up to 3s, never forward more than 0.3s so the setup isn't trimmed.
 *  - end:   the beginning of the first pause after the AI's end (speech finishes when it begins),
 *           looking ahead up to 4s so a punchline that runs past the AI's end is kept.
 * With no pause nearby (or no audio), fall back to a little extra room on both sides.
 */
function snapBounds({ startSec, endSec }, silences = [], duration = Infinity) {
  const LEAD = 0.15;   // start a hair before the first word
  const TAIL = 0.3;    // let the last syllable and any laugh finish
  let start = startSec - 0.5;
  let bestEnd = -Infinity;
  for (const s of silences) {
    if (Number.isFinite(s.end) && s.end >= startSec - 3 && s.end <= startSec + 0.3 && s.end > bestEnd) bestEnd = s.end;
  }
  if (bestEnd > -Infinity) start = bestEnd - LEAD;

  let end = endSec + 1.0;
  let bestStart = Infinity;
  for (const s of silences) {
    if (s.start >= endSec - 0.5 && s.start <= endSec + 4 && s.start < bestStart) bestStart = s.start;
  }
  if (bestStart < Infinity) end = bestStart + TAIL;

  start = Math.max(0, start);
  end = Math.min(duration, end);
  if (!(end - start >= 1)) { // a degenerate result: keep the AI's own times with a little room
    start = Math.max(0, startSec - 0.3);
    end = Math.min(duration, endSec + 0.7);
  }
  return { startSec: round2(start), endSec: round2(end) };
}

/** Run fn over items, `limit` at a time, keeping the original order of results. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** Keep the best-scoring clips and drop any that overlap one already kept. clips: [{ score, moment: { startSec, endSec } }]. */
function dropOverlaps(clips) {
  const kept = [];
  for (const c of [...clips].sort((a, b) => (b.score || 0) - (a.score || 0))) {
    if (!kept.some((k) => c.moment.startSec < k.moment.endSec && k.moment.startSec < c.moment.endSec)) kept.push(c);
  }
  return kept;
}

module.exports = { parseSilences, snapBounds, mapLimit, dropOverlaps };
