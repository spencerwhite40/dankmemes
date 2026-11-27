"use strict";

// Meme Builder media helpers: ffmpeg/ffprobe plumbing, safe URL download,
// analysis proxy. Uses the ffmpeg-static binary (Render's Node runtime ships
// no system ffmpeg); falls back to a system `ffmpeg` on PATH for local dev.
// MEME_BUILDER_FFMPEG overrides both.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const dns = require("node:dns").promises;
const net = require("node:net");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");

function ffmpegBin() {
  if (process.env.MEME_BUILDER_FFMPEG) return process.env.MEME_BUILDER_FFMPEG;
  try {
    const p = require("ffmpeg-static");
    if (p && fs.existsSync(p)) return p;
  } catch { /* not installed: fall back to PATH */ }
  return "ffmpeg";
}

/** Run a binary; resolves { code, stdout, stderr } and never throws on a non-zero exit (callers decide). */
function run(cmd, args, { timeoutMs = 20 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const killer = setTimeout(() => p.kill("SIGKILL"), timeoutMs); // a wedged ffmpeg must not hold the runner forever
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; if (stdout.length > 2e6) stdout = stdout.slice(-1e6); });
    p.stderr.on("data", (d) => { stderr += d; if (stderr.length > 2e6) stderr = stderr.slice(-1e6); });
    p.on("error", (e) => { clearTimeout(killer); reject(new Error(`${cmd}: ${e.message}`)); });
    p.on("close", (code) => { clearTimeout(killer); resolve({ code, stdout, stderr }); });
  });
}

async function runFfmpeg(args) {
  const r = await run(ffmpegBin(), ["-hide_banner", "-nostdin", ...args]);
  if (r.code !== 0) throw new Error(`ffmpeg exited ${r.code}: ${r.stderr.slice(-500)}`);
  return r;
}

/** Parse `ffmpeg -i` banner text into { duration, width, height, hasAudio }. Pure, unit-tested. */
function parseProbe(text) {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const v = /Stream #[^\n]*Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(text);
  // Phone videos are often stored sideways with a rotation flag; ffmpeg turns them upright when decoding, so report the upright size.
  const rot = /rotation of (-?[\d.]+) degrees/.exec(text) || /\brotate\s*:\s*(-?\d+)/.exec(text);
  const sideways = rot && Math.abs(Math.round(Number(rot[1]))) % 180 === 90;
  const [cw, ch] = v ? [Number(v[1]), Number(v[2])] : [null, null];
  return {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
    width: sideways ? ch : cw,
    height: sideways ? cw : ch,
    hasAudio: /Stream #[^\n]*Audio:/.test(text),
    hasVideo: !!v,
  };
}

async function probe(file) {
  // `ffmpeg -i file` with no output exits 1 but prints the stream info we need.
  const r = await run(ffmpegBin(), ["-hide_banner", "-nostdin", "-i", file]);
  const info = parseProbe(r.stderr);
  if (!info.hasVideo || !info.duration) throw new Error("That file doesn't look like a video ffmpeg can read.");
  return info;
}

/** Pause detector: [{ start, end }] in seconds where the audio is quiet. Used to snap cuts to the gaps between words. */
async function detectSilences(file, { noiseDb = -32, minSec = 0.25 } = {}) {
  const r = await run(ffmpegBin(), ["-hide_banner", "-nostdin", "-nostats", "-i", file, "-vn", "-af", `silencedetect=noise=${noiseDb}dB:d=${minSec}`, "-f", "null", "-"], { timeoutMs: 10 * 60 * 1000 });
  return require("./cuts").parseSilences(r.stderr);
}

/** A short low-res excerpt for the model to check a clip against (fast; same shape as the analysis copy). */
async function makeExcerpt(file, startSec, lengthSec, out) {
  await runFfmpeg([
    "-y", "-ss", String(startSec), "-t", String(lengthSec), "-i", file,
    "-vf", "scale=-2:360,fps=10",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "33",
    "-c:a", "aac", "-b:a", "64k", "-ac", "1",
    "-movflags", "+faststart",
    out,
  ]);
  return out;
}

/** A small low-bitrate copy of just one stretch of the video (the AI watches long videos a few minutes at a time). */
async function makeAnalysisSegment(file, startSec, lengthSec, out) {
  await runFfmpeg([
    "-y", "-ss", String(startSec), "-t", String(lengthSec), "-i", file,
    "-vf", "scale=-2:360,fps=10",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "33",
    "-c:a", "aac", "-b:a", "64k", "-ac", "1",
    "-movflags", "+faststart",
    out,
  ]);
  return out;
}

/** Small, low-bitrate copy for the model to watch (fast upload, cheap tokens). */
async function makeAnalysisProxy(file, out) {
  await runFfmpeg([
    "-y", "-i", file,
    "-vf", "scale=-2:360,fps=10",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "33",
    "-c:a", "aac", "-b:a", "64k", "-ac", "1",
    "-movflags", "+faststart",
    out,
  ]);
  return out;
}

// --- Downloading a video from a URL (admin-supplied, so still SSRF-guarded) ---

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:");
}

async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("That isn't a valid URL."); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http(s) links are supported.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("That link points at a private address.");
  return u;
}

/** Download a direct video link to `dest` (size-capped). YouTube/page links are NOT supported here: use upload or a direct file URL. */
async function downloadUrl(raw, dest, { maxBytes = 1024 * 1024 * 1024 } = {}) {
  const u = await assertPublicUrl(raw);
  const res = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error(`Couldn't download that link (HTTP ${res.status}).`);
  const type = (res.headers.get("content-type") || "").toLowerCase();
  if (type.startsWith("text/html")) throw new Error("That link is a web page, not a video file. Use a direct .mp4 link, or upload the file.");
  const len = Number(res.headers.get("content-length") || 0);
  if (len && len > maxBytes) throw new Error("That video is too large.");
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  let seen = 0;
  const limited = Readable.fromWeb(res.body);
  limited.on("data", (c) => { seen += c.length; if (seen > maxBytes) limited.destroy(new Error("That video is too large.")); });
  await pipeline(limited, fs.createWriteStream(dest));
  return dest;
}

// ── Is this really a video, and one we can work on? ──────────────────────────────────────────────────────
/** The kind of video container a file starts with, judged from its first bytes, or null if it isn't one we know. Pure. */
function sniffVideo(buf) {
  if (!buf || buf.length < 12) return null;
  const at = (o, n) => buf.subarray(o, o + n).toString("latin1");
  if (at(4, 4) === "ftyp") return "mp4";                                         // mp4, m4v, mov, 3gp
  if (["moov", "mdat", "wide", "free", "skip"].includes(at(4, 4))) return "mov";  // older QuickTime files
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "matroska";   // mkv, webm
  if (at(0, 4) === "RIFF" && at(8, 4) === "AVI ") return "avi";
  if (at(0, 3) === "FLV") return "flv";
  if (buf[0] === 0x30 && buf[1] === 0x26 && buf[2] === 0xb2 && buf[3] === 0x75) return "asf";           // wmv
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && (buf[3] === 0xba || buf[3] === 0xb3)) return "mpeg";
  if (at(0, 4) === "OggS") return "ogg";
  if (buf[0] === 0x47 && buf.length > 376 && buf[188] === 0x47 && buf[376] === 0x47) return "mpegts";
  return null;
}
async function sniffFile(file) {
  const fh = await fs.promises.open(file, "r");
  try { const buf = Buffer.alloc(1024); const { bytesRead } = await fh.read(buf, 0, 1024, 0); return sniffVideo(buf.subarray(0, bytesRead)); } finally { await fh.close(); }
}

const MAX_PIXELS = () => Number(process.env.MEME_BUILDER_MAX_PIXELS) || 3840 * 2160 * 1.03;   // about 4K; larger is too slow to work on
const MIN_SECONDS = 2;
/** Throws a plain-words Error if what probe() found can't be worked on. Pure. */
function assertWorkable(info) {
  if (!info || !info.hasVideo) throw new Error("That file has no picture in it.");
  if (!(info.duration >= MIN_SECONDS)) throw new Error(`That video is shorter than ${MIN_SECONDS} seconds.`);
  if (info.width && info.height && info.width * info.height > MAX_PIXELS()) throw new Error(`That video is ${info.width}x${info.height}, which is larger than we can work on. The limit is about 4K (3840x2160). Export it at a smaller size and try again.`);
  return info;
}

module.exports = { sniffVideo, sniffFile, assertWorkable, ffmpegBin, run, runFfmpeg, parseProbe, probe, makeAnalysisProxy, makeAnalysisSegment, detectSilences, makeExcerpt, downloadUrl, assertPublicUrl, isPrivateIp };
