"use strict";
// The whole product, end to end, with nothing mocked inside our own code: a real video file goes in through the real intake, the real
// runner picks it up, ffmpeg really renders the clips, the real API serves them. Only Google is replaced, by a small fake server that
// answers the pipeline's three kinds of question (tests/helpers/fake-gemini.js). This is the check that the parts fit together.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const { startFakeGemini } = require("./helpers/fake-gemini");
const media = require("../src/lib/media");

const DB = process.env.DATABASE_URL_TEST;
const MOMENTS = [
  ["00:06", "00:16", "Wait, you really think that is how a load gets booked around here"],
  ["00:20", "00:30", "I have been waiting four hours and nobody has said a single word"],
  ["00:34", "00:44", "No no no, that is not what we agreed on when I called yesterday"],
  ["00:48", "00:58", "Sure, I will just magically find another driver by the end of lunch"],
  ["01:02", "01:12", "You told me the dock would be open and there is a line out to the road"],
  ["01:15", "01:25", "That is the best offer you have got for me after all of this nonsense"],
].map(([start, end, transcript], i) => ({ start, end, kind: "reaction", transcript, context: `Someone is dealing with problem number ${i + 1}.`, emotion: ["disbelief", "exhausted", "irritated", "sarcastic", "fed up", "defeated"][i], dynamic: "other", intensity: 6, words: "neutral", delivery: "flat and tired", reaction_use: "any moment of quiet frustration", strength: 7 }));

describe("end to end: upload a video, get captioned clips (real ffmpeg, real database, fake Google)", { skip: !DB && "DATABASE_URL_TEST is not set" }, () => {
  const { Pool } = require("pg");
  const accounts = require("../src/accounts");
  const keys = require("../src/lib/keys");
  const store = require("../src/lib/store");
  const ai = require("../src/lib/ai");
  const { migrate } = require("../src/migrate");
  const { buildApp } = require("../src/server");
  const { createRun } = require("../src/intake");
  const { startMemeBuilderWorker } = require("../src/worker");
  const realFetch = global.fetch;
  const quiet = { log() {}, error() {}, warn() {} };
  const PW = "a-long-enough-password";
  const KEEP = {};
  let pool, server, base, tmp, fake, source;

  const login = async (label, plan) => {
    const user = await accounts.signup(pool, { email: `${label}-${crypto.randomUUID().slice(0, 6)}@example.com`, password: PW });
    await accounts.markVerified(pool, user.id); await accounts.setPlan(pool, user.id, plan);
    const r = await realFetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: user.email, password: PW }) });
    const cookie = r.headers.getSetCookie()[0].split(";")[0];
    const call = async (method, p, body) => {
      const res = await realFetch(base + p, { method, headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json, text };
    };
    return { user, call };
  };
  const upload = (u) => createRun(pool, { ownerId: u.id }, { personaId: "truckers", file: { path: source, size: fs.statSync(source).size, originalname: "ep-12.mp4", mimetype: "video/mp4" } }).then((r) => r.job);
  const process_ = async () => { const w = startMemeBuilderWorker(pool, { log: quiet, retryPauseMs: 1 }); await w.tick(); w.stop(); };
  const region = async (file, at, x, y) => {
    const raw = path.join(tmp, `r-${crypto.randomUUID()}.raw`);
    await media.runFfmpeg(["-y", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", `crop=520:90:${x}:${y},format=gray`, "-f", "rawvideo", raw]);
    return fs.readFileSync(raw);
  };

  before(async (t) => {
    process.env.MEME_BUILDER_STORAGE_BACKEND = "local";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mb-e2e-")); process.env.MEME_BUILDER_STORAGE_ROOT = tmp;
    source = path.join(tmp, "ep-12.mp4");
    try { await media.runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=10:duration=90", "-f", "lavfi", "-i", "sine=frequency=300:duration=90", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]); }
    catch { t.skip("no usable ffmpeg here"); return; }
    fake = await startFakeGemini({ moments: MOMENTS });
    for (const k of ["GOOGLE_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "KIE_API_KEY", "GOOGLE_API_BASE", "MEME_BUILDER_VIDEO_MODELS", "MEME_BUILDER_TEXT_MODELS", "EMAIL_PROVIDER", "STRIPE_SECRET_KEY"]) { KEEP[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, { GOOGLE_API_BASE: fake.url, GOOGLE_API_KEY: "test-key", MEME_BUILDER_VIDEO_MODELS: "google:fake-model", MEME_BUILDER_TEXT_MODELS: "google:fake-model" });
    ai.resetModelHealth();
    pool = new Pool({ connectionString: DB, ssl: /\/tmp\/|localhost|127\.0\.0\.1/.test(DB) ? false : { rejectUnauthorized: false } });
    await migrate(pool);
    await pool.query("truncate usage_events, model_usage, api_keys, sessions, users, auth_tokens, meme_builder_clips, meme_builder_jobs, meme_builder_personas cascade");
    ai.ledger.setPool(pool);
    await new Promise((r) => { server = http.createServer(buildApp(pool)).listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    server && server.close(); fake && await fake.close(); pool && await pool.end(); ai.resetModelHealth();
    for (const k of Object.keys(KEEP)) { if (KEEP[k] === undefined) delete process.env[k]; else process.env[k] = KEEP[k]; }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  let creator, run, clips;
  test("a paying customer uploads a video and the runner turns it into finished clips", async (t) => {
    if (!fake) return t.skip("no usable ffmpeg here");
    creator = await login("e2e-creator", "creator");
    const job = await upload(creator.user);
    assert.equal(job.status, "queued"); assert.equal(job.source_label, "ep-12.mp4");
    await process_();
    run = await store.getJob(pool, job.id);
    assert.equal(run.status, "done", `the run ended as "${run.status}": ${run.error || ""}`);
    clips = await store.listJobClips(pool, job.id);
    assert.ok(clips.length >= 4, `${clips.length} clips made`);
    for (const c of clips) {
      assert.match(c.caption, /fifteen minutes/); assert.ok(Number(c.end_sec) > Number(c.start_sec));
      assert.ok(fs.existsSync(c.storage_uri.replace("file://", "")), "the clip file is stored");
      const info = await media.probe(c.storage_uri.replace("file://", ""));
      assert.equal(info.width, 1080); assert.equal(info.height, 1920); assert.ok(info.hasAudio, "with sound"); assert.ok(info.duration > 3 && info.duration < 45, `${info.duration}s`);
      assert.ok(Number(c.bytes) > 1000, "its size is recorded");
    }
    assert.deepEqual(clips.map((c) => c.n), clips.map((_, i) => i + 1), "numbered one after another");
  });

  test("it asked the AI the right questions, in the right order of work", async (t) => {
    if (!fake) return t.skip("no usable ffmpeg here");
    const count = (k) => fake.requests.filter((r) => r.kind === k).length;
    assert.ok(count("upload") >= 1, "the small copy of the video went up");
    assert.equal(count("analysis"), 1, "the video was watched once, whole");
    assert.ok(count("captions") >= 1); assert.ok(count("verify") >= clips.length, "every clip's cut was checked");
    assert.ok(fake.requests.filter((r) => r.kind === "analysis")[0].text.includes("MM:SS"));
    assert.ok(fake.requests.filter((r) => r.kind === "captions")[0].text.includes("[m1]"), "captions were asked for the moments found");
  });

  test("the customer is billed in whole minutes and the usage is recorded against them", async (t) => {
    if (!fake) return t.skip("no usable ffmpeg here");
    const ev = (await pool.query("select source_seconds, clips from usage_events where owner_id = $1", [creator.user.id])).rows;
    assert.equal(ev.length, 1); assert.equal(Number(ev[0].source_seconds), 120, "90 seconds is billed as 2 minutes"); assert.equal(ev[0].clips, clips.length);
    const me = (await creator.call("GET", "/api/me")).json; assert.equal(me.usage.minutes, 2); assert.equal(me.usage.clips, clips.length);
    const spend = (await pool.query("select stage, count(*)::int n, sum(input_tokens)::int tin from model_usage where owner_id = $1 and provider = 'google' and ok group by stage", [creator.user.id])).rows;
    assert.ok(spend.length >= 2 && spend.every((r) => r.tin > 0), JSON.stringify(spend));
    assert.equal(me.usage.storage_bytes > 0, true, "the stored video and clips count against storage");
  });

  test("the public API serves the run, signed clip links (with Range), and the zip", async (t) => {
    if (!fake) return t.skip("no usable ffmpeg here");
    const key = await keys.createKey(pool, { ownerId: creator.user.id, name: "e2e" });
    const get = (p, h = {}) => realFetch(`${base}${p}`, { headers: { Authorization: `Bearer ${key.key}`, ...h } });
    const r = await (await get(`/v1/runs/${run.id}`)).json();
    assert.equal(r.run.status, "done"); assert.equal(r.clips.length, clips.length);
    const link = r.clips[0].video_url; assert.match(link, /^http:\/\/127\.0\.0\.1:\d+\/v1\/clips\/.+\/video\?exp=\d+&sig=/, "an absolute link, usable from anywhere");
    const part = await realFetch(link, { headers: { Range: "bytes=0-99" } });
    assert.equal(part.status, 206); assert.equal((await part.arrayBuffer()).byteLength, 100);
    const whole = await realFetch(link); assert.equal(whole.status, 200); assert.equal((await whole.arrayBuffer()).byteLength, Number(clips[0].bytes));
    if (spawnSync("which", ["python3"]).status === 0) {
      const zip = path.join(tmp, "api.zip"); fs.writeFileSync(zip, Buffer.from(await (await get(`/v1/runs/${run.id}/clips.zip`)).arrayBuffer()));
      const out = spawnSync("python3", ["-I", "-c", "import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(len(z.namelist()))", zip], { encoding: "utf8" });
      assert.equal(out.stdout.trim(), String(clips.length), out.stderr);
    }
    const usage = await (await get("/v1/usage")).json(); assert.equal(usage.minutes_processed, 2);
  });

  test("rating a clip and writing a new caption work on the finished clips", async (t) => {
    if (!fake) return t.skip("no usable ffmpeg here");
    const c = clips[0], before = c.storage_uri;
    assert.equal((await creator.call("POST", `/api/clips/${c.id}/rating`, { rating: 1 })).status, 200);
    const r = await creator.call("POST", `/api/clips/${c.id}/regenerate-caption`);
    assert.equal(r.status, 200, r.text); assert.equal(r.json.clip.caption, "A brand new caption from the fake model");
    const after = await store.getClip(pool, c.id);
    assert.notEqual(after.storage_uri, before, "the clip was re-rendered into a new file"); assert.ok(fs.existsSync(after.storage_uri.replace("file://", ""))); assert.equal(fs.existsSync(before.replace("file://", "")), false, "the old file was removed");
    assert.equal((await media.probe(after.storage_uri.replace("file://", ""))).height, 1920);
  });

  test("a free account's clips carry the watermark and a paying account's don't (same video, same captions, same cuts)", async (t) => {
    if (!fake) return t.skip("no usable ffmpeg here");
    const free = await login("e2e-free", "free");
    const job = await upload(free.user); await process_();
    const done = await store.getJob(pool, job.id); assert.equal(done.status, "done", done.error || "");
    const freeClip = (await store.listJobClips(pool, job.id))[0];
    const paidClip = (await store.listJobClips(pool, run.id)).find((c) => Number(c.start_sec) === Number(freeClip.start_sec));
    assert.ok(paidClip, "the paying account's run has the same cut to compare with");
    const [f, p] = [freeClip, paidClip].map((c) => c.storage_uri.replace("file://", ""));
    const diff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d / a.length; };
    assert.equal(Number(freeClip.start_sec), Number(paidClip.start_sec), "the same cut");
    assert.ok(diff(await region(f, 1, 40, 1135), await region(p, 1, 40, 1135)) > 3, "the mark is in the free clip");
  });

  test("when the AI account is out of credit, the run fails with a plain message, is not billed, and the customer can try again", async (t) => {
    if (!fake) return t.skip("no usable ffmpeg here");
    const u = await login("e2e-broke", "creator");
    const job = await upload(u.user); fake.setFail(402); ai.resetModelHealth();
    const realErr = console.error; console.error = () => {};
    try { await process_(); } finally { console.error = realErr; fake.setFail(null); ai.resetModelHealth(); }
    const failed = await store.getJob(pool, job.id);
    assert.equal(failed.status, "error"); assert.match(failed.error, /run out of credit/);
    assert.equal((await pool.query("select count(*)::int n from usage_events where owner_id = $1", [u.user.id])).rows[0].n, 0, "a failed run costs the customer nothing");
    const retry = await u.call("POST", `/api/jobs/${job.id}/retry`); assert.equal(retry.status, 200, retry.text);
    await process_();
    assert.equal((await store.getJob(pool, job.id)).status, "done", "the retry worked once the AI was back");
    assert.equal((await pool.query("select count(*)::int n from usage_events where owner_id = $1", [u.user.id])).rows[0].n, 1);
  });
});
