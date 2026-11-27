"use strict";

// Meme Builder step 3: cut the original video, lay it out vertically (9:16)
// and burn the caption in.
//
// The layout is the one people recognise as a meme: a white caption card with
// black bold text sitting directly on top of the video, the two together a
// little above the middle of the frame (clear of the app's buttons at the
// bottom), over a darkened blur of the same video. A tall (phone) video fills
// the frame instead, with the caption on white boxes near the top.
//
// The caption is burned in with libass (an .ass subtitle file) because the
// ffmpeg-static binary has no drawtext filter. The font is the Liberation
// Sans Bold already bundled for the newsroom (loaded via fontsdir), so
// captions look identical on every host with no dependency on system fonts.

const fs = require("node:fs");
const path = require("node:path");
const { run, runFfmpeg, ffmpegBin, probe } = require("./media");

const FONT_DIR = path.join(__dirname, "..", "..", "assets", "fonts");
const FONT_FILE = path.join(FONT_DIR, "LiberationSans-Bold.ttf");

/** Greedy word-wrap to a max number of characters per line. */
function greedyWrap(text, maxChars) {
  const lines = [];
  let line = "";
  for (const w of String(text).trim().split(/\s+/)) {
    if (line && `${line} ${w}`.length > maxChars) { lines.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Word-wrap to at most maxChars per line, balanced: the same number of lines the plain wrap needs, but as even as possible,
 * so a caption never ends on one orphaned word ("...and it is hour" / "six"). Pure.
 */
function wrapCaption(text, maxChars = 24) {
  const lines = greedyWrap(text, maxChars);
  if (lines.length < 2) return lines.join("\n");
  let best = lines;
  for (let m = maxChars - 1; m >= 8; m--) {
    const tryLines = greedyWrap(text, m);
    if (tryLines.length > lines.length) break;
    best = tryLines;
  }
  return best.join("\n");
}

/** ASS text field: wrapped, with override-block and escape characters neutralised. */
function assText(caption, maxChars = 24) {
  return wrapCaption(caption, maxChars)
    .replace(/[{}]/g, (c) => (c === "{" ? "(" : ")"))
    .replace(/\\/g, "")
    .replace(/\n/g, "\\N");
}

// ── The watermark (plans that have one) ──────────────────────────────────
// It is part of the picture: drawn by libass in the same pass as the caption, so it is in every frame of the file that is stored.
// No clean copy is kept anywhere, so there is nothing to download that lacks it. It moves between four spots every three seconds
// (on the video and below it), so cropping one strip off the frame doesn't remove it.
const WATERMARK_SPOTS = [[300, 1180], [780, 1700], [300, 1560], [780, 1330]];
const WATERMARK_EVERY_SEC = 3;
/** The words in the mark: WATERMARK_TEXT, else a default. Pure apart from the environment. */
function watermarkText() {
  const t = String(process.env.WATERMARK_TEXT || "made with dankmemes").replace(/[{}\\\n\r]/g, " ").trim().slice(0, 60);
  return t || "made with dankmemes";
}
const assClock = (sec) => {
  const cs = Math.round(sec * 100), h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
function watermarkLines(seconds, text) {
  const total = Math.max(1, Math.ceil(seconds)), lines = [];
  for (let t = 0, i = 0; t < total; t += WATERMARK_EVERY_SEC, i++) {
    const [x, y] = WATERMARK_SPOTS[i % WATERMARK_SPOTS.length];
    lines.push(`Dialogue: 1,${assClock(t)},${assClock(Math.min(total, t + WATERMARK_EVERY_SEC))},Mark,,0,0,0,,{\\an5\\pos(${x},${y})}${text}`);
  }
  return lines;
}

// ── Layout, in 1080x1920 units (scaled for a 720x1280 output) ─────────────
const TOP_SAFE = 150;        // the app's own header covers the very top
const TALL_SHARE = 0.6;      // a video taller than this share of the frame is treated as a phone video: it fills, the caption overlays
const CARD_PAD = 40;
const CARD_SIZES = [[76, 21], [66, 24], [58, 28], [50, 32]];   // [font px, characters per line], biggest that fits in 4 lines wins
const even = (n) => 2 * Math.round(n / 2);

/**
 * Where everything goes for one caption on one source size. Pure.
 * card:    { mode, fontSize, wrap, lines, cardY, cardH, videoY, videoH }  (landscape and square sources)
 * overlay: { mode, fontSize, wrap, lines, marginV }                        (phone videos)
 */
function captionLayout({ srcW, srcH, caption = "" } = {}) {
  const ratio = srcW > 0 && srcH > 0 ? srcH / srcW : 9 / 16;
  const videoH = even(1080 * ratio);
  const fitFor = (wrapAt) => wrapCaption(caption, wrapAt).split("\n").length;
  // Big text first: the two biggest sizes at up to 3 lines, then the biggest at up to 4 lines, then the smallest size.
  const [fontSize, wrap] = CARD_SIZES.slice(0, 2).find(([, w]) => fitFor(w) <= 3) || CARD_SIZES.find(([, w]) => fitFor(w) <= 4) || CARD_SIZES[CARD_SIZES.length - 1];
  const lines = fitFor(wrap);
  if (videoH > 1920 * TALL_SHARE) return { mode: "overlay", fontSize: Math.min(fontSize, 64), wrap: Math.max(wrap, 24), lines: fitFor(Math.max(wrap, 24)), marginV: 230 };
  const cardH = even(lines * fontSize * 1.18 + CARD_PAD * 2);
  const group = cardH + videoH;
  // A little above the middle: the bottom of the screen is covered by the app's caption, buttons and progress bar.
  const cardY = even(Math.max(TOP_SAFE, Math.min(1920 - group, (1920 - group) / 2 - 110)));
  return { mode: "card", fontSize, wrap, lines, cardY, cardH, videoY: cardY + cardH, videoH };
}

/** Whole .ass file for one caption shown for `seconds` seconds (PlayRes matches the 1080x1920 output). watermark: the mark's words, or falsy for none. layout: from captionLayout. */
function buildAss(caption, seconds, watermark, layout = captionLayout({ srcW: 1920, srcH: 1080, caption })) {
  const t = Math.max(1, Math.ceil(seconds));
  const mm = String(Math.floor(t / 60)).padStart(2, "0");
  const ss = String(t % 60).padStart(2, "0");
  const card = layout.mode === "card";
  // Card: black text, no outline, centred in the white card. Overlay: black text on white boxes (BorderStyle 3 draws the box in the outline colour).
  const capStyle = card
    ? `Style: Cap,Liberation Sans,${layout.fontSize},&H00101010,&H00101010,&H00FFFFFF,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,50,50,0,1`
    : `Style: Cap,Liberation Sans,${layout.fontSize},&H00101010,&H00101010,&H00FFFFFF,&H00000000,-1,0,0,0,100,100,0,0,3,14,0,8,70,70,${layout.marginV},1`;
  const pos = card ? `{\\an5\\pos(540,${layout.cardY + layout.cardH / 2})}` : "";
  return [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920", "WrapStyle: 0", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    capStyle,
    "Style: Mark,Liberation Sans,50,&H33FFFFFF,&H33FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,0,5,0,0,0,1", "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 0,0:00:00.00,0:${mm}:${ss}.00,Cap,,0,0,0,,${pos}${assText(caption, layout.wrap)}`,
    ...(watermark ? watermarkLines(seconds, assText(watermark).replace(/\\N/g, " ")) : []), "",
  ].join("\n");
}

// Escape a path for an ffmpeg filter argument.
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");

// ── Audio: light touch-ups, only when needed ──────────────────────────────
// Podcast audio is often too quiet. Each clip is measured first; if its loudness is already fine the
// audio is left alone. Otherwise: a gentle high-pass (rumble), a mild compressor (evens out loud and
// quiet), then ONE fixed gain (measured, so the same boost for the whole clip: it cannot pump or
// gate) toward about -16 LUFS, with a soft peak limiter as a safety net. Near-silence is never
// boosted (that would only raise the noise), the boost is capped, and the result is checked before
// it is used: if speech has gone missing or the level is wrong, the clip keeps its original audio.
const AUDIO_PRE = "highpass=f=80,acompressor=threshold=-24dB:ratio=2.5:attack=20:release=250:makeup=1";
const LIMITER = "alimiter=limit=0.84:attack=7:release=120:level=disabled";
const TARGET_LUFS = -16;
const MAX_GAIN_DB = 22;      // never lift by more than this
const MAX_CUT_DB = 12;       // loud clips are only brought down a little
const LIMITER_HEADROOM_DB = 3; // the limiter may shave this much off peaks, no more (more sounds harsh)

function parseLoudnorm(stderr) {
  const m = String(stderr || "").match(/\{[^{}]*"input_i"[^{}]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return { i: Number(j.input_i), tp: Number(j.input_tp), lra: Number(j.input_lra), thresh: Number(j.input_thresh), offset: Number(j.target_offset) };
  } catch { return null; }
}

/** Does this clip's audio need touching? false for fine, silent, or no-audio clips. Pure. */
function audioNeeds(m) {
  if (!m || !Number.isFinite(m.i)) return false;     // no audio, or digital silence
  if (m.i < -58) return false;                       // effectively silence: boosting would only raise the noise
  const fine = m.i >= -19 && m.i <= -13 && m.tp <= -1 && m.lra <= 15;
  return !fine;
}

/** The single gain (dB) to apply after the pre-chain, given its measured loudness and true peak. Pure. */
function chooseGain(post) {
  const want = TARGET_LUFS - post.i;
  const byPeak = -1.5 - post.tp + LIMITER_HEADROOM_DB;   // beyond this the limiter would be doing the work
  return Math.round(Math.max(-MAX_CUT_DB, Math.min(MAX_GAIN_DB, want, byPeak)) * 10) / 10;
}

/** Loudness numbers for a stretch of audio, optionally through a filter chain (measurement only; nothing is changed). */
async function measureLoudness(source, startSec, durSec, { pre = "" } = {}) {
  const af = `${pre ? `${pre},` : ""}loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11:print_format=json`;
  const r = await run(ffmpegBin(), ["-hide_banner", "-nostdin", "-nostats", "-ss", String(startSec), "-t", String(durSec), "-i", source, "-vn", "-af", af, "-f", "null", "-"]);
  return parseLoudnorm(r.stderr);
}

/** Level (dB RMS) of each quarter second of a stretch of audio, optionally through a filter chain. */
async function audioWindows(source, startSec, durSec, af) {
  const chain = `${af ? `${af},` : ""}aresample=16000,asetnsamples=n=4000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`;
  const r = await run(ffmpegBin(), ["-hide_banner", "-nostdin", "-nostats", "-ss", String(startSec), "-t", String(durSec), "-i", source, "-vn", "-af", chain, "-f", "null", "-"]);
  return [...r.stdout.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map((m) => (m[1] === "-inf" ? -120 : Number(m[1])));
}

/** Is the processed audio safe to use? It must not have lost speech the original had. Pure. */
function audioLooksOk(before, after) {
  const n = Math.min(before.length, after.length);
  if (n < 4) return true;
  let lost = 0, spoken = 0;
  for (let i = 0; i < n; i++) {
    if (before[i] > -50) { spoken++; if (after[i] < -65 || after[i] < before[i] - 12) lost++; } // speech must not get quieter or vanish
  }
  return spoken === 0 || lost / spoken <= 0.03;
}

/** { filter, measured, gainDb }: filter is the ffmpeg audio chain to apply, or null when the audio is fine, cannot be measured, or fails its own check. */
async function audioFilter(source, startSec, durSec) {
  let raw;
  try { raw = await measureLoudness(source, startSec, durSec); } catch { return { filter: null, measured: null }; }
  if (!audioNeeds(raw)) return { filter: null, measured: raw };
  let post;
  try { post = await measureLoudness(source, startSec, durSec, { pre: AUDIO_PRE }); } catch { post = null; }
  if (!post || !Number.isFinite(post.i) || !Number.isFinite(post.tp)) return { filter: null, measured: raw };
  const gainDb = chooseGain(post);
  const filter = `${AUDIO_PRE},volume=${gainDb}dB,${LIMITER},aresample=48000`;
  try {
    const [before, after] = await Promise.all([audioWindows(source, startSec, durSec), audioWindows(source, startSec, durSec, filter)]);
    if (!audioLooksOk(before, after)) {
      console.error(`[meme-builder] audio touch-up dropped speech for ${source}@${startSec}; keeping the original audio`);
      return { filter: null, measured: raw, rejected: true };
    }
  } catch { return { filter: null, measured: raw }; }   // can't verify -> don't risk it
  return { filter, measured: raw, gainDb };
}

/** Longer clips take far longer to encode on a small server, so they use a faster (slightly larger) encode. */
function encodePreset(durSec) {
  if (durSec > 60) return "ultrafast";
  if (durSec > 25) return "superfast";
  return "veryfast";
}

/** One word for what happened to a clip's audio, for the run summary. Pure. */
function audioStatus(plan) {
  if (!plan || !plan.measured || !Number.isFinite(plan.measured.i)) return "none";   // no audio track, or digital silence
  if (plan.rejected) return "rejected";
  if (!plan.filter) return plan.measured.i < -58 ? "none" : "ok";
  return plan.gainDb >= 0 ? "boosted" : "trimmed";
}

/** Output size: full 1080x1920, but long clips use 720x1280 (about 2.2x fewer pixels to encode, which is what keeps a long clip from taking forever on a small server). Pure. */
function outputSize(durSec) { return durSec > LONG_CLIP_SEC ? { w: 720, h: 1280 } : { w: 1080, h: 1920 }; }
const LONG_CLIP_SEC = 45;

/** The ffmpeg filter graph for one layout at output size w x h. Pure. */
function layoutFilter(layout, w, h, assFile) {
  const k = w / 1080;
  const px = (n) => even(n * k);
  // The background is blurred anyway, so blur a tiny copy and scale it back up: ~2.4x faster than
  // blurring the full 1080x1920 frame, which matters on a small server, and it looks the same. It is darkened so the card and video stand out.
  const bg = `[bg]scale=${w / 10}:${h / 10}:force_original_aspect_ratio=increase,crop=${w / 10}:${h / 10},boxblur=3:1,eq=brightness=-0.18:saturation=0.75,scale=${w}:${h}:flags=bilinear[bgb];`;
  const caption = `ass='${esc(assFile)}':fontsdir='${esc(FONT_DIR)}',setsar=1[v]`;
  if (layout.mode === "card") {
    return "[0:v]split=2[bg][fg];" + bg +
      `[fg]scale=${w}:${px(layout.videoH)}:flags=fast_bilinear,setsar=1[fgs];` +
      `[bgb][fgs]overlay=0:${px(layout.videoY)}[base];` +
      `[base]drawbox=x=0:y=${px(layout.cardY)}:w=${w}:h=${px(layout.cardH)}:color=white@1:t=fill,${caption}`;
  }
  return "[0:v]split=2[bg][fg];" + bg +
    `[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=fast_bilinear,setsar=1[fgs];` +
    "[bgb][fgs]overlay=(W-w)/2:(H-h)/2[base];" + `[base]${caption}`;
}

/** srcSize: { width, height } of the source (upright). Probed when not given. */
async function renderClip({ source, startSec, endSec, caption, out, padSec = 0.05, onAudio, size, watermark, threads, srcSize }) {
  const start = Math.max(0, startSec - padSec);
  const dur = endSec + padSec - start;
  const { w, h } = size || outputSize(dur);
  const dims = srcSize && srcSize.width && srcSize.height ? srcSize : await probe(source).catch(() => ({}));
  const layout = captionLayout({ srcW: dims.width, srcH: dims.height, caption });
  const assFile = out.replace(/\.mp4$/, ".caption.ass");
  await fs.promises.writeFile(assFile, buildAss(caption, dur, watermark, layout));
  try {
    const vf = layoutFilter(layout, w, h, assFile);
    const audio = await audioFilter(source, start, dur);
    if (onAudio) { try { onAudio(audioStatus(audio), audio); } catch { /* informational */ } }
    await runFfmpeg([
      "-y", "-ss", String(start), "-t", String(dur), "-i", source,
      "-filter_complex", vf, "-map", "[v]", "-map", "0:a?",
      ...(audio.filter ? ["-af", audio.filter] : []),
      "-c:v", "libx264", "-preset", encodePreset(dur), "-crf", "23", "-pix_fmt", "yuv420p",
      ...(threads ? ["-threads", String(threads)] : []),
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
      out,
    ]);
  } finally {
    fs.promises.rm(assFile, { force: true }).catch(() => {});
  }
  return out;
}

module.exports = { captionLayout, layoutFilter, outputSize, audioStatus, encodePreset, renderClip, wrapCaption, assText, buildAss, watermarkText, watermarkLines, FONT_FILE, parseLoudnorm, audioNeeds, chooseGain, audioLooksOk, audioWindows, audioFilter, measureLoudness };
