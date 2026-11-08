"use strict";
// The AI door: each provider's request shape and answer parsing, the fallback chain, media routing, and the usage ledger.
// No network: fetch is replaced in every test.
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ai = require("../src/lib/ai");
const models = require("../src/lib/ai/models");
const ledger = require("../src/lib/ai/ledger");
const google = require("../src/lib/ai/providers/google");

const KEYS = ["GOOGLE_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "KIE_API_KEY", "MEME_BUILDER_VIDEO_MODELS", "MEME_BUILDER_TEXT_MODELS",
  "MEME_BUILDER_UPLOAD_PROVIDER", "GOOGLE_FLASH_MODEL", "GOOGLE_PRO_MODEL", "ANTHROPIC_WRITER_MODEL", "OPENAI_MODEL", "MODEL_PRICES_JSON"];
const saved = {}; let realFetch;
beforeEach(() => { realFetch = global.fetch; for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } ai.resetModelHealth(); ledger.resetPrices(); ledger.setPool(null); });
afterEach(() => { global.fetch = realFetch; for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } ledger.resetPrices(); ledger.setPool(null); });
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: new Map(), text: async () => (typeof body === "string" ? body : JSON.stringify(body)), json: async () => body });
const say = (text) => [{ role: "user", content: text }];
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

describe("model names and default chains", () => {
  test("a model is provider:model; a bare name means kie.ai", () => {
    assert.deepEqual(models.parseModelId("google:gemini-3.1-pro"), { provider: "google", model: "gemini-3.1-pro" });
    assert.deepEqual(models.parseModelId("anthropic:claude-fable-5-1"), { provider: "anthropic", model: "claude-fable-5-1" });
    assert.deepEqual(models.parseModelId("gemini-3-6-flash"), { provider: "kie", model: "gemini-3-6-flash" });
  });
  test("the default chains only use providers whose key is set, Claude first for captions and Gemini for video", () => {
    assert.deepEqual(ai.textModels(), []); assert.deepEqual(ai.videoModels(), []);
    process.env.GOOGLE_API_KEY = "g";
    assert.ok(ai.videoModels().every((m) => m.startsWith("google:")) && ai.videoModels().length >= 2);
    assert.ok(ai.textModels().every((m) => m.startsWith("google:")));
    process.env.ANTHROPIC_API_KEY = "a"; process.env.OPENAI_API_KEY = "o";
    const t = ai.textModels();
    assert.equal(t[0], "anthropic:claude-fable-5-1", "Claude writes the humor first");
    assert.ok(t.includes("google:gemini-3.1-pro") && t.some((m) => m.startsWith("openai:")));
    assert.ok(ai.videoModels().every((m) => m.startsWith("google:")), "Claude and GPT never get video");
    process.env.GOOGLE_PRO_MODEL = "gemini-9-pro"; assert.ok(ai.textModels().includes("google:gemini-9-pro"), "names can be overridden");
    process.env.MEME_BUILDER_TEXT_MODELS = "openai:x, google:y"; assert.deepEqual(ai.textModels(), ["openai:x", "google:y"], "a whole chain can be set");
  });
});

describe("Google Gemini (direct)", () => {
  test("a text call: request shape, JSON mode, system prompt, usage including thinking tokens", async () => {
    process.env.GOOGLE_API_KEY = "gkey"; let seen;
    global.fetch = async (url, init) => { seen = { url: String(url), init, body: JSON.parse(init.body) }; return reply(200, { candidates: [{ content: { parts: [{ text: "hello" }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30, cachedContentTokenCount: 40 } }); };
    const rec = []; ledger.setPool({ query: async (sql, p) => { rec.push(p); return { rows: [] }; } });
    const out = await ledger.runWithContext({ ownerId: "acme", jobId: "j1", stage: "captions" }, () => ai.chat({ models: ["google:gemini-x"], system: "SYS", messages: say("hi"), maxTokens: 50, json: true }));
    assert.equal(out, "hello");
    assert.equal(seen.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent");
    assert.equal(seen.init.headers["x-goog-api-key"], "gkey");
    assert.deepEqual(seen.body.systemInstruction, { parts: [{ text: "SYS" }] });
    assert.equal(seen.body.generationConfig.maxOutputTokens, 50); assert.equal(seen.body.generationConfig.responseMimeType, "application/json");
    assert.deepEqual(seen.body.contents, [{ role: "user", parts: [{ text: "hi" }] }]);
    await new Promise((r) => setTimeout(r, 10));
    // owner, job, stage, provider, model, kind, input, output (candidates + thinking), cached
    assert.deepEqual(rec[0].slice(0, 9), ["acme", "j1", "captions", "google", "gemini-x", "text", 100, 50, 40]);
    assert.equal(rec[0][11], true);
  });

  test("uploading a video, waiting until it is ready, and then watching it by file URI", async () => {
    process.env.GOOGLE_API_KEY = "gkey";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-")); const f = path.join(dir, "v.mp4"); fs.writeFileSync(f, Buffer.alloc(2048, 1));
    const calls = []; let polls = 0;
    global.fetch = async (url, init = {}) => {
      calls.push([String(url), init.method || "GET", init.headers]);
      if (String(url).endsWith("/upload/v1beta/files")) return { ...reply(200, {}), headers: new Map([["x-goog-upload-url", "https://up.example/session1"]]) };
      if (String(url) === "https://up.example/session1") return reply(200, { file: { name: "files/abc", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc", state: "PROCESSING", mimeType: "video/mp4" } });
      if (String(url).endsWith("/v1beta/files/abc")) { polls++; return reply(200, { name: "files/abc", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc", state: polls < 2 ? "PROCESSING" : "ACTIVE", mimeType: "video/mp4" }); }
      const body = JSON.parse(init.body);
      assert.deepEqual(body.contents[0].parts[1], { fileData: { fileUri: "https://generativelanguage.googleapis.com/v1beta/files/abc", mimeType: "video/mp4" } });
      return reply(200, { candidates: [{ content: { parts: [{ text: "watched" }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 5 } });
    };
    try {
      const uri = await google.upload(f, { pollMs: 1 });
      assert.equal(uri, "https://generativelanguage.googleapis.com/v1beta/files/abc");
      const start = calls[0]; assert.equal(start[2]["X-Goog-Upload-Command"], "start"); assert.equal(start[2]["X-Goog-Upload-Header-Content-Length"], "2048");
      assert.equal(calls[1][2]["X-Goog-Upload-Command"], "upload, finalize");
      assert.equal(polls, 2, "it waited for ACTIVE");
      assert.equal(ai.uploadProvider(), "google");
      const out = await ai.chat({ models: ["google:gemini-x"], messages: [{ role: "user", content: [{ type: "text", text: "what happens?" }, { type: "media", url: uri }] }] });
      assert.equal(out, "watched");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("errors are told apart: a bad key and a missing model do not retry, a 503 does", async () => {
    process.env.GOOGLE_API_KEY = "gkey";
    for (const [status, body, code, retryable] of [[403, { error: { message: "API key not valid", status: "PERMISSION_DENIED" } }, "bad_key", false], [404, { error: { message: "models/x is not found" } }, "no_model", false], [503, { error: { message: "overloaded" } }, undefined, true]]) {
      global.fetch = async () => reply(status, body);
      const e = await quiet(() => ai.chat({ models: ["google:x"], messages: say("hi"), retries: 0 })).catch((x) => x);
      assert.ok(e instanceof ai.AiError, `HTTP ${status}`); assert.equal(e.code, code); assert.equal(e.retryable, retryable);
      ai.resetModelHealth();
    }
  });
});

describe("Anthropic Claude (direct)", () => {
  test("request shape with a cacheable system prompt, and usage including cache reads", async () => {
    process.env.ANTHROPIC_API_KEY = "akey"; let seen;
    global.fetch = async (url, init) => { seen = { url: String(url), init, body: JSON.parse(init.body) }; return reply(200, { content: [{ type: "text", text: "joke" }], usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } }); };
    const rec = []; ledger.setPool({ query: async (sql, p) => { rec.push(p); return { rows: [] }; } });
    const out = await ledger.runWithContext({ ownerId: "o" }, () => ai.chat({ models: ["anthropic:claude-fable-5-1"], system: "long audience profile", messages: say("write"), maxTokens: 300 }));
    assert.equal(out, "joke"); assert.equal(seen.url, "https://api.anthropic.com/v1/messages");
    assert.equal(seen.init.headers["x-api-key"], "akey"); assert.equal(seen.init.headers["anthropic-version"], "2023-06-01");
    assert.deepEqual(seen.body.system, [{ type: "text", text: "long audience profile", cache_control: { type: "ephemeral" } }]);
    assert.equal(seen.body.model, "claude-fable-5-1"); assert.equal(seen.body.max_tokens, 300);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(rec[0].slice(3, 9), ["anthropic", "claude-fable-5-1", "text", 910, 7, 900]);
  });
  test("an account out of credit is reported as such and falls through to the next model", async () => {
    process.env.ANTHROPIC_API_KEY = "akey"; process.env.OPENAI_API_KEY = "okey";
    global.fetch = async (url) => String(url).includes("anthropic")
      ? reply(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } })
      : reply(200, { choices: [{ message: { content: "from gpt" } }], usage: { prompt_tokens: 5, completion_tokens: 3 } });
    const used = [];
    const out = await quiet(() => ai.chat({ models: ["anthropic:claude-x", "openai:gpt-x"], messages: say("hi"), retries: 0, onModel: (m) => used.push(m) }));
    assert.equal(out, "from gpt"); assert.deepEqual(used, ["openai:gpt-x"]);
    global.fetch = async () => reply(400, { type: "error", error: { message: "Your credit balance is too low" } });
    const e = await quiet(() => ai.chat({ models: ["anthropic:claude-x"], messages: say("hi"), retries: 0 })).catch((x) => x);
    assert.equal(e.code, "out_of_credit"); assert.match(ai.friendlyMessage(e), /run out of credit/);
  });
});

describe("OpenAI GPT (direct)", () => {
  test("request shape and usage with cached tokens", async () => {
    process.env.OPENAI_API_KEY = "okey"; let seen;
    global.fetch = async (url, init) => { seen = { url: String(url), init, body: JSON.parse(init.body) }; return reply(200, { choices: [{ message: { content: "gpt says" } }], usage: { prompt_tokens: 50, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 20 } } }); };
    const rec = []; ledger.setPool({ query: async (sql, p) => { rec.push(p); return { rows: [] }; } });
    const out = await ledger.runWithContext({ ownerId: "o" }, () => ai.chat({ models: ["openai:gpt-x"], system: "SYS", messages: say("hi"), maxTokens: 77 }));
    assert.equal(out, "gpt says"); assert.equal(seen.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(seen.init.headers.Authorization, "Bearer okey");
    assert.deepEqual(seen.body.messages, [{ role: "system", content: "SYS" }, { role: "user", content: "hi" }]); assert.equal(seen.body.max_completion_tokens, 77);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(rec[0].slice(3, 9), ["openai", "gpt-x", "text", 50, 9, 20]);
  });
});

describe("the chain", () => {
  test("a model that cannot read the uploaded video is left out, so a mixed chain is safe", async () => {
    process.env.GOOGLE_API_KEY = "g"; process.env.ANTHROPIC_API_KEY = "a"; process.env.KIE_API_KEY = "k";
    const hits = [];
    global.fetch = async (url, init) => { hits.push(String(url)); return reply(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] }); };
    const googleVideo = "https://generativelanguage.googleapis.com/v1beta/files/zzz";
    await ai.chat({ models: ["anthropic:claude-x", "kie:gemini-3-6-flash", "google:gemini-x"], messages: [{ role: "user", content: [{ type: "text", text: "t" }, { type: "media", url: googleVideo }] }] });
    assert.equal(hits.length, 1); assert.match(hits[0], /generativelanguage/, "only Google can read a Google-hosted video");
    // a kie.ai-hosted video goes only to kie.ai models
    hits.length = 0; global.fetch = async (url) => { hits.push(String(url)); return reply(200, { choices: [{ message: { content: "ok" } }] }); };
    await ai.chat({ models: ["google:gemini-x", "kie:gemini-3-6-flash"], messages: [{ role: "user", content: [{ type: "media", url: "https://tempfile.example/v.mp4" }] }] });
    assert.match(hits[0], /api\.kie\.ai\/gemini-3-6-flash-openai/);
  });
  test("with no provider set up it says so plainly; a broken first model falls to the next", async () => {
    const e = await ai.chat({ models: ["google:x"], messages: say("hi") }).catch((x) => x);
    assert.equal(e.code, "no_provider"); assert.match(ai.friendlyMessage(e), /isn't set up/);
    process.env.GOOGLE_API_KEY = "g"; process.env.OPENAI_API_KEY = "o";
    global.fetch = async (url) => (String(url).includes("google") ? reply(404, { error: { message: "not found" } }) : reply(200, { choices: [{ message: { content: "gpt" } }] }));
    const used = [];
    assert.equal(await quiet(() => ai.chat({ models: ["google:missing", "openai:gpt-x"], messages: say("hi"), retries: 0, onModel: (m) => used.push(m) })), "gpt");
    assert.deepEqual(used, ["openai:gpt-x"]);
  });
  test("a failed call is recorded too (with no tokens), so reliability can be measured", async () => {
    process.env.OPENAI_API_KEY = "o"; const rec = [];
    ledger.setPool({ query: async (sql, p) => { rec.push(p); return { rows: [] }; } });
    global.fetch = async () => reply(500, { error: { message: "boom" } });
    await quiet(() => ledger.runWithContext({ ownerId: "o" }, () => ai.chat({ models: ["openai:gpt-x"], messages: say("hi"), retries: 0 }))).catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(rec.length, 1); assert.equal(rec[0][11], false); assert.match(rec[0][12], /boom|500/);
  });
});

describe("the model check", () => {
  test("reports which configured names exist at each provider and which are missing", async () => {
    process.env.GOOGLE_API_KEY = "g"; process.env.OPENAI_API_KEY = "o";
    process.env.MEME_BUILDER_VIDEO_MODELS = "google:gemini-real,google:gemini-gone"; process.env.MEME_BUILDER_TEXT_MODELS = "openai:gpt-real";
    global.fetch = async (url) => (String(url).includes("generativelanguage") ? reply(200, { models: [{ name: "models/gemini-real" }, { name: "models/other" }] }) : reply(200, { data: [{ id: "gpt-real" }] }));
    const rep = await ai.checkModels();
    const g = rep.find((r) => r.provider === "google"), o = rep.find((r) => r.provider === "openai");
    assert.deepEqual(g.ok, ["gemini-real"]); assert.deepEqual(g.missing, ["gemini-gone"]);
    assert.deepEqual(o.ok, ["gpt-real"]); assert.deepEqual(o.missing, []);
  });
});

describe("the ledger", () => {
  test("cost is filled in only when a price is configured, and cached input is cheaper", () => {
    assert.equal(ledger.costOf("google", "m", { input: 1000, output: 1000 }), null, "no price, no cost");
    process.env.MODEL_PRICES_JSON = JSON.stringify({ "google:m": { input: 2, output: 10, cached_input: 0.5 } }); ledger.resetPrices();
    // 600 fresh input @2 + 400 cached @0.5 + 1000 output @10, per million
    assert.ok(Math.abs(ledger.costOf("google", "m", { input: 1000, cached: 400, output: 1000 }) - (600 * 2 + 400 * 0.5 + 1000 * 10) / 1e6) < 1e-12);
    assert.equal(ledger.costOf("google", "other", { input: 1, output: 1 }), null);
  });
  test("the ledger never throws into the caller, even when the database is down", async () => {
    ledger.setPool({ query: async () => { throw new Error("db down"); } });
    await quiet(async () => { await ledger.record({ provider: "g", model: "m", usage: {}, ok: true }); });
  });
});
