"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const media = require("../src/lib/media");

const pad = (...parts) => Buffer.concat([...parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, "latin1"))), Buffer.alloc(1024)]);

describe("recognising a video from its first bytes (no database)", () => {
  test("the common containers are recognised", () => {
    assert.equal(media.sniffVideo(pad(Buffer.from([0, 0, 0, 0x18]), "ftypmp42")), "mp4");
    assert.equal(media.sniffVideo(pad(Buffer.from([0, 0, 0, 0x14]), "ftypqt  ")), "mp4", "mov");
    assert.equal(media.sniffVideo(pad(Buffer.from([0, 0, 0, 8]), "wide")), "mov", "older QuickTime");
    assert.equal(media.sniffVideo(pad(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), "xxxxxxxx")), "matroska", "mkv and webm");
    assert.equal(media.sniffVideo(pad("RIFF", Buffer.from([1, 2, 3, 4]), "AVI LIST")), "avi");
    assert.equal(media.sniffVideo(pad("FLV", Buffer.from([1, 5, 0, 0, 0, 9, 0, 0, 0]))), "flv");
    assert.equal(media.sniffVideo(pad(Buffer.from([0x30, 0x26, 0xb2, 0x75]), "xxxxxxxx")), "asf", "wmv");
    assert.equal(media.sniffVideo(pad(Buffer.from([0, 0, 1, 0xba]), "xxxxxxxx")), "mpeg");
    assert.equal(media.sniffVideo(pad("OggS", "xxxxxxxx")), "ogg");
    const ts = Buffer.alloc(600); ts[0] = ts[188] = ts[376] = ts[564] = 0x47; assert.equal(media.sniffVideo(ts), "mpegts");
  });
  test("things that are not video are refused: text, a web page, a zip, a pdf, an image, a program, empty or tiny files, and a wrong guess from the name", () => {
    for (const [name, buf] of [
      ["text", Buffer.from("this is just a note about my video, not a video\n".repeat(30))],
      ["html", Buffer.from("<!doctype html><html><body>Please sign in to watch this video</body></html>".padEnd(2000))],
      ["zip", pad("PK", Buffer.from([3, 4, 20, 0]), "video.mp4")],
      ["pdf", pad("%PDF-1.7\n")], ["png", pad(Buffer.from([0x89]), "PNG\r\n", Buffer.from([0x1a, 10]))],
      ["jpeg", pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), "JFIF")], ["elf program", pad(Buffer.from([0x7f]), "ELF")],
      ["empty", Buffer.alloc(0)], ["tiny", Buffer.from("abc")], ["zeros", Buffer.alloc(2000)],
    ]) assert.equal(media.sniffVideo(buf), null, name);
    assert.equal(media.sniffVideo(null), null);
  });
  test("a file on disk is judged by what is inside it, not what it is called", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-sniff-"));
    try {
      const fake = path.join(dir, "holiday.mp4"); fs.writeFileSync(fake, "<html>not a video</html>".repeat(100));
      assert.equal(await media.sniffFile(fake), null);
      const real = path.join(dir, "clip.bin");
      try { await media.runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", real]); } catch { return; }
      assert.equal(await media.sniffFile(real), "mp4", "a real video with a meaningless name");
      const info = await media.probe(real); assert.equal(media.assertWorkable(info), info);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("what we will and won't work on (no database)", () => {
  const info = (o = {}) => ({ duration: 60, width: 1920, height: 1080, hasAudio: true, hasVideo: true, ...o });
  test("normal sizes pass, including vertical 4K", () => {
    for (const o of [{}, { width: 1080, height: 1920 }, { width: 3840, height: 2160 }, { width: 2160, height: 3840 }, { width: 640, height: 360 }, { duration: 2 }, { width: null, height: null }]) assert.ok(media.assertWorkable(info(o)), JSON.stringify(o));
  });
  test("no picture, too short and too large are refused, in plain words", () => {
    assert.throws(() => media.assertWorkable(info({ hasVideo: false })), /no picture/);
    assert.throws(() => media.assertWorkable(info({ duration: 1.2 })), /shorter than 2 seconds/);
    assert.throws(() => media.assertWorkable(info({ duration: null })), /shorter than/);
    assert.throws(() => media.assertWorkable(info({ width: 7680, height: 4320 })), /7680x4320.*4K/);
    assert.throws(() => media.assertWorkable(null), /no picture/);
  });
  test("the size limit can be changed", () => {
    const keep = process.env.MEME_BUILDER_MAX_PIXELS;
    try { process.env.MEME_BUILDER_MAX_PIXELS = String(640 * 360); assert.throws(() => media.assertWorkable(info()), /larger than we can work on/); assert.ok(media.assertWorkable(info({ width: 640, height: 360 }))); }
    finally { if (keep === undefined) delete process.env.MEME_BUILDER_MAX_PIXELS; else process.env.MEME_BUILDER_MAX_PIXELS = keep; }
  });
});

const DB = process.env.DATABASE_URL_TEST;
describe("uploads are checked before they are accepted (real database)", { skip: !DB && "DATABASE_URL_TEST is not set" }, () => {
  const { Pool } = require("pg");
  const accounts = require("../src/accounts");
  const { migrate } = require("../src/migrate");
  const { createRun } = require("../src/intake");
  let pool, tmp, user;
  before(async () => {
    process.env.MEME_BUILDER_STORAGE_BACKEND = "local";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mb-upchk-")); process.env.MEME_BUILDER_STORAGE_ROOT = tmp;
    pool = new Pool({ connectionString: DB, ssl: /\/tmp\/|localhost|127\.0\.0\.1/.test(DB) ? false : { rejectUnauthorized: false } });
    await migrate(pool);
    user = await accounts.signup(pool, { email: `up-${crypto.randomUUID().slice(0, 6)}@example.com`, password: "a-long-enough-password" });
    await accounts.setPlan(pool, user.id, "creator");
  });
  after(async () => { await pool.end(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const file = (p, name) => ({ path: p, size: fs.statSync(p).size, originalname: name, mimetype: "video/mp4" });

  test("a text file renamed .mp4 is refused with a clear message and no run is created", async () => {
    const p = path.join(tmp, "fake.mp4"); fs.writeFileSync(p, "just some words, definitely not a video\n".repeat(100));
    const before = (await pool.query("select count(*)::int n from meme_builder_jobs where owner_id = $1", [user.id])).rows[0].n;
    await assert.rejects(() => createRun(pool, { ownerId: user.id }, { personaId: "truckers", file: file(p, "fake.mp4") }), (e) => e.status === 400 && e.code === "bad_video" && /doesn't look like a video/.test(e.message));
    assert.equal((await pool.query("select count(*)::int n from meme_builder_jobs where owner_id = $1", [user.id])).rows[0].n, before);
  });
  test("a real video is accepted, whatever it is called", async (t) => {
    const p = path.join(tmp, "real.dat");
    try { await media.runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=3", "-f", "lavfi", "-i", "sine=duration=3", "-c:v", "libx264", "-c:a", "aac", "-shortest", "-f", "mp4", p]); } catch { return t.skip("no usable ffmpeg here"); }
    const { job } = await createRun(pool, { ownerId: user.id }, { personaId: "truckers", file: file(p, "My Holiday.MOV") });
    assert.equal(job.status, "queued"); assert.equal(job.source_label, "My Holiday.MOV");
  });
  test("a video that is too short is refused", async (t) => {
    const p = path.join(tmp, "short.mp4");
    try { await media.runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", p]); } catch { return t.skip("no usable ffmpeg here"); }
    await assert.rejects(() => createRun(pool, { ownerId: user.id }, { personaId: "truckers", file: file(p, "short.mp4") }), (e) => e.code === "bad_video" && /shorter than 2 seconds/.test(e.message));
  });
});
