"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { PassThrough, Readable } = require("node:stream");

const { writeZip, safeName } = require("../src/zip");

const have = (cmd) => spawnSync("which", [cmd]).status === 0;
const PY = have("python3");
/** Reads a zip with Python's own zipfile (an independent implementation) and tests every CRC. Returns { names, files: {name: Buffer}, bad }. */
function readWithPython(file) {
  const code = "import sys,zipfile,json,base64\nz=zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({'bad':z.testzip(),'files':{n:base64.b64encode(z.read(n)).decode() for n in z.namelist()}}))";
  const r = spawnSync("python3", ["-I", "-c", code, file], { encoding: "utf8", maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout); return { bad: j.bad, files: Object.fromEntries(Object.entries(j.files).map(([k, v]) => [k, Buffer.from(v, "base64")])) };
}
const toFile = async (entries) => { const f = path.join(os.tmpdir(), `zip-${crypto.randomUUID()}.zip`); const out = fs.createWriteStream(f); await writeZip(out, entries); return f; };
const mem = (name, data) => ({ name, open: async () => Readable.from([data]) });

describe("the zip writer (no database)", () => {
  test("file names are made safe, short and unique", () => {
    const used = new Set();
    assert.equal(safeName("01 When the dock says 15 minutes!", used, ".mp4"), "01 When the dock says 15 minutes.mp4");
    assert.equal(safeName("01 When the dock says 15 minutes!", used, ".mp4"), "01 When the dock says 15 minutes (2).mp4", "a repeat gets a number");
    assert.equal(safeName("../../etc/passwd", new Set(), ".mp4"), "etcpasswd.mp4", "no path tricks");
    assert.equal(safeName("", new Set(), ".mp4"), "clip.mp4"); assert.equal(safeName("🙂🙂", new Set(), ".mp4"), "clip.mp4");
    assert.ok(safeName("x".repeat(500), new Set(), ".mp4").length <= 64);
    assert.equal(safeName("Café déjà vu", new Set(), ""), "Café déjà vu", "letters from other languages are kept");
    assert.equal(safeName("A", used, ""), "A"); assert.equal(safeName("a", used, ""), "a (2)", "names that differ only by case collide on some systems");
  });
  test("a valid zip that an independent reader opens: the right names, the right bytes, every checksum good", { skip: !PY && "python3 is not installed" }, async () => {
    const big = crypto.randomBytes(3 * 1024 * 1024 + 17);
    const f = await toFile([mem("01 first.mp4", Buffer.from("hello clip one")), mem("02 Café déjà vu.mp4", big), mem("03 empty.mp4", Buffer.alloc(0)), { name: "04 chunks.mp4", open: async () => Readable.from([Buffer.from("aa"), Buffer.from("bbb"), Buffer.from("c")]) }]);
    try {
      const z = readWithPython(f);
      assert.equal(z.bad, null, "no entry failed its checksum");
      assert.deepEqual(Object.keys(z.files), ["01 first.mp4", "02 Café déjà vu.mp4", "03 empty.mp4", "04 chunks.mp4"]);
      assert.equal(z.files["01 first.mp4"].toString(), "hello clip one"); assert.ok(z.files["02 Café déjà vu.mp4"].equals(big)); assert.equal(z.files["03 empty.mp4"].length, 0); assert.equal(z.files["04 chunks.mp4"].toString(), "aabbbc");
      if (have("unzip")) { const r = spawnSync("unzip", ["-tq", f], { encoding: "utf8" }); assert.equal(r.status, 0, r.stdout + r.stderr); }
    } finally { fs.rmSync(f, { force: true }); }
  });
  test("an empty list is still a valid (empty) zip", { skip: !PY && "python3 is not installed" }, async () => {
    const f = await toFile([]); try { const z = readWithPython(f); assert.deepEqual(z.files, {}); } finally { fs.rmSync(f, { force: true }); }
  });
  test("if a file can't be read, the download stops with an error instead of ending as a normal-looking zip", async () => {
    const out = new PassThrough(); out.resume(); let destroyed = null; out.on("error", (e) => { destroyed = e; });
    await assert.rejects(() => writeZip(out, [mem("ok.mp4", Buffer.from("fine")), { name: "gone.mp4", open: async () => { throw new Error("file is gone"); } }]), /file is gone/);
    await new Promise((r) => setImmediate(r));   // the stream reports its error a tick later
    assert.ok(out.destroyed, "the connection was cut"); assert.ok(destroyed && /file is gone/.test(destroyed.message));
  });
  test("a slow reader doesn't make it buffer everything (it waits for the stream to drain)", async () => {
    const out = new PassThrough({ highWaterMark: 1024 }); let maxBuffered = 0; const chunks = [];
    out.on("data", async (c) => { chunks.push(c); maxBuffered = Math.max(maxBuffered, out.readableLength); });
    await writeZip(out, [{ name: "big.mp4", open: async () => Readable.from((function* () { for (let i = 0; i < 200; i++) yield Buffer.alloc(65536, i); })()) }]);
    assert.ok(maxBuffered <= 64 * 1024 + 1024, `buffered ${maxBuffered}`); assert.ok(Buffer.concat(chunks).length > 200 * 65536);
  });
});

const DB = process.env.DATABASE_URL_TEST;
describe("downloading a run's clips as one zip (real database)", { skip: !DB && "DATABASE_URL_TEST is not set" }, () => {
  const { Pool } = require("pg");
  const accounts = require("../src/accounts");
  const keys = require("../src/lib/keys");
  const store = require("../src/lib/store");
  const { migrate } = require("../src/migrate");
  const { buildApp } = require("../src/server");
  const { createRun } = require("../src/intake");
  const realFetch = global.fetch;
  let pool, server, base, tmp;
  const PW = "a-long-enough-password";

  const login = async (label, plan = "creator") => {
    const user = await accounts.signup(pool, { email: `${label}-${crypto.randomUUID().slice(0, 6)}@example.com`, password: PW });
    await accounts.markVerified(pool, user.id); await accounts.setPlan(pool, user.id, plan);
    const r = await realFetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: user.email, password: PW }) });
    const cookie = r.headers.getSetCookie()[0].split(";")[0];
    return { user, get: (p) => realFetch(base + p, { headers: { Cookie: cookie } }) };
  };
  const run = async (u, captions, label = "My Podcast Ep 12.mp4") => {
    const job = (await createRun(pool, { ownerId: u.id }, { personaId: "truckers", sourceUrl: `https://8.8.8.8/${crypto.randomUUID()}.mp4` })).job;
    await pool.query("update meme_builder_jobs set status = 'done', source_label = $2 where id = $1", [job.id, label]);
    const contents = [];
    for (const [i, caption] of captions.entries()) {
      const f = path.join(tmp, `${crypto.randomUUID()}.mp4`), data = crypto.randomBytes(5000 + i); fs.writeFileSync(f, data); contents.push(data);
      await store.addClip(pool, job.id, "truckers", i + 1, { caption, score: 7, why: "", transcript: "", emotion: "", startSec: 1, endSec: 5, storageUri: `file://${f}`, bytes: data.length }, null);
    }
    return { job, contents };
  };

  before(async () => {
    process.env.MEME_BUILDER_STORAGE_BACKEND = "local";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mb-zipdb-")); process.env.MEME_BUILDER_STORAGE_ROOT = tmp;
    pool = new Pool({ connectionString: DB, ssl: /\/tmp\/|localhost|127\.0\.0\.1/.test(DB) ? false : { rejectUnauthorized: false } });
    await migrate(pool);
    await pool.query("truncate usage_events, model_usage, api_keys, sessions, users, auth_tokens, meme_builder_clips, meme_builder_jobs, meme_builder_personas cascade");
    await new Promise((r) => { server = http.createServer(buildApp(pool)).listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { server && server.close(); await pool.end(); fs.rmSync(tmp, { recursive: true, force: true }); });

  test("the owner gets every clip, named by order and caption, with the bytes intact", { skip: !PY && "python3 is not installed" }, async () => {
    const a = await login("zip-a"); const x = await run(a.user, ["When the dock says fifteen minutes", "POV: dispatch says one more stop", "When the dock says fifteen minutes"]);
    const res = await a.get(`/api/jobs/${x.job.id}/clips.zip`);
    assert.equal(res.status, 200); assert.equal(res.headers.get("content-type"), "application/zip");
    assert.equal(res.headers.get("content-disposition"), 'attachment; filename="My-Podcast-Ep-12-clips.zip"');
    const f = path.join(tmp, "got.zip"); fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
    const z = readWithPython(f); assert.equal(z.bad, null);
    assert.deepEqual(Object.keys(z.files), ["01 When the dock says fifteen minutes.mp4", "02 POV dispatch says one more stop.mp4", "03 When the dock says fifteen minutes.mp4"]);
    Object.values(z.files).forEach((buf, i) => assert.ok(buf.equals(x.contents[i]), `clip ${i + 1} intact`));
  });
  test("another account gets 404, a run with no clips gets 404, a bad id gets 400, signed-out gets 401, a locked account gets 402", async () => {
    const a = await login("zip-own"), b = await login("zip-other"); const x = await run(a.user, ["one"]), empty = await run(a.user, []);
    assert.equal((await b.get(`/api/jobs/${x.job.id}/clips.zip`)).status, 404);
    assert.equal((await a.get(`/api/jobs/${empty.job.id}/clips.zip`)).status, 404);
    assert.equal((await a.get(`/api/jobs/nope/clips.zip`)).status, 400);
    assert.equal((await realFetch(`${base}/api/jobs/${x.job.id}/clips.zip`)).status, 401);
    await pool.query("update users set locked_at = now() where id = $1", [a.user.id]);
    assert.equal((await a.get(`/api/jobs/${x.job.id}/clips.zip`)).status, 402);
  });
  test("the API gives the same download to a key's owner, and only to them", { skip: !PY && "python3 is not installed" }, async () => {
    const a = await login("zip-api"), b = await login("zip-api-b"); const x = await run(a.user, ["alpha", "beta"]);
    const ka = await keys.createKey(pool, { ownerId: a.user.id, name: "A" }), kb = await keys.createKey(pool, { ownerId: b.user.id, name: "B" });
    const call = (k) => realFetch(`${base}/v1/runs/${x.job.id}/clips.zip`, { headers: { Authorization: `Bearer ${k.key}` } });
    const res = await call(ka); assert.equal(res.status, 200);
    const f = path.join(tmp, "api.zip"); fs.writeFileSync(f, Buffer.from(await res.arrayBuffer())); assert.deepEqual(Object.keys(readWithPython(f).files), ["01 alpha.mp4", "02 beta.mp4"]);
    assert.equal((await call(kb)).status, 404, "another customer's key"); assert.equal((await realFetch(`${base}/v1/runs/${x.job.id}/clips.zip`)).status, 401, "no key");
  });
});
