"use strict";

// Meme Builder — thin kie.ai client: chat (Gemini watches video, Claude/Gemini
// write) and temporary file hosting (Gemini can only read a video from a
// public URL, so we upload a small analysis copy and hand it that URL).
//
// Env:
//   KIE_API_KEY                  required (already used by the image pipeline)
//   KIE_API_BASE                 default https://api.kie.ai
//   KIE_UPLOAD_BASE              default https://kieai.redpandaai.co
//   MEME_BUILDER_VIDEO_MODELS    comma list, first is tried first (default gemini-3-6-flash,gemini-3-8-flash)
//   MEME_BUILDER_TEXT_MODELS     comma list (default claude-sonnet-5-5,gemini-3-6-flash)
//
// KIE reports many failures as HTTP 200 + { code, msg }, so both shapes are
// handled. 5xx / 429 / network errors retry with backoff, then fall through
// to the next model in the chain.

const fs = require("node:fs");
const path = require("node:path");

const apiBase = () => process.env.KIE_API_BASE || "https://api.kie.ai";
const uploadBase = () => process.env.KIE_UPLOAD_BASE || "https://kieai.redpandaai.co";
const list = (v, d) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : d);
// Flash watches (fast and reliable); the Pro models are slower but are good fallbacks when Flash is failing.
const videoModels = () => list(process.env.MEME_BUILDER_VIDEO_MODELS, ["gemini-3-6-flash", "gemini-3.1-pro", "gemini-3-pro", "gemini-3-8-flash"]);
// kie.ai serves the GPT and Gemini Pro models at /<model>/v1/chat/completions, and the Gemini Flash models at /<model>-openai/v1/chat/completions.
const PLAIN_PATH = /^(gpt-|gemini-[\d.]+-pro)/;

// "direct:<model>" talks to Anthropic itself with the app's ANTHROPIC_API_KEY, so a kie.ai outage doesn't take Claude away.
const DIRECT = "direct:";
// Gemini 3.1 Pro writes the captions: in a side-by-side on the same video its captions were sharper and more varied than Flash's.
// Claude (a different vendor) and GPT follow as fallbacks, then Gemini Pro 3 and Flash.
const textModels = () => list(process.env.MEME_BUILDER_TEXT_MODELS, [
  "gemini-3.1-pro",
  "claude-sonnet-5-5",
  "gpt-5-2", // kie.ai hosts it too: a different vendor, so a Claude outage doesn't touch it
  ...(process.env.ANTHROPIC_API_KEY ? [`${DIRECT}claude-sonnet-5-5`] : []),
  "claude-opus-5-5", "gemini-3-pro", "gemini-3-6-flash", "gemini-3-8-flash",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class KieError extends Error {
  constructor(msg, { status, code, retryable } = {}) {
    super(msg);
    this.name = "KieError";
    this.status = status;
    this.code = code;
    this.retryable = !!retryable;
  }
}

function authHeaders() {
  const key = process.env.KIE_API_KEY;
  if (!key) throw new KieError("KIE_API_KEY is not set on this server.");
  return { Authorization: `Bearer ${key}` };
}

/** One upload attempt, aborted if it takes longer than timeoutMs (a stalled connection must not hang a run). */
async function uploadOnce(filePath, { uploadPath, fileName, timeoutMs }) {
  const form = new FormData();
  // The analysis copy is small, so send it from memory. A file-backed Blob streamed through
  // fetch/FormData depends on the Node build's undici and is the kind of thing that can stall.
  const { size } = await fs.promises.stat(filePath);
  const blob = size <= 150 * 1024 * 1024 ? new Blob([await fs.promises.readFile(filePath)]) : await fs.openAsBlob(filePath);
  form.append("file", blob, fileName || path.basename(filePath));
  form.append("uploadPath", uploadPath);
  let res;
  try {
    res = await fetch(`${uploadBase()}/api/file-stream-upload`, { method: "POST", headers: authHeaders(), body: form, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e instanceof KieError) throw e;
    throw new KieError(`upload: ${e && e.name === "TimeoutError" ? `no answer after ${Math.round(timeoutMs / 1000)}s` : `network error: ${e.message}`}`, { retryable: true });
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new KieError(`upload: bad response (${res.status}): ${text.slice(0, 200)}`, { status: res.status, retryable: res.status >= 500 }); }
  if (!json.success || json.code !== 200) throw new KieError(`upload failed: ${json.msg || text.slice(0, 200)}`, { code: json.code, retryable: (json.code || 0) >= 500 });
  return json.data.downloadUrl;
}

/** Upload a local file to KIE's temp host (auto-deleted after ~24h). Returns a public URL. Retries stalls and 5xx. */
async function uploadFile(filePath, { uploadPath = "meme-builder", fileName, timeoutMs = 3 * 60 * 1000, attempts = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await uploadOnce(filePath, { uploadPath, fileName, timeoutMs });
    } catch (err) {
      lastErr = err;
      if (!(err instanceof KieError) || !err.retryable) break; // e.g. missing key, rejected key: retrying can't help
      if (i < attempts - 1) await sleep(2000 * 2 ** i);
    }
  }
  throw lastErr;
}

// KIE's Gemini route wants every media file as { type:'image_url', image_url:{ url } } — video included.
function toOpenAIContent(c) {
  if (typeof c === "string") return c;
  return c.map((p) => (p.type === "media" ? { type: "image_url", image_url: { url: p.url } } : p));
}
function toClaudeContent(c) {
  return typeof c === "string" ? c : c.filter((p) => p.type === "text");
}

async function callOnce(model, { messages, system, maxTokens, timeoutMs }) {
  const direct = model.startsWith(DIRECT);
  const name = direct ? model.slice(DIRECT.length) : model;
  const isClaude = name.startsWith("claude");
  if (direct && !process.env.ANTHROPIC_API_KEY) throw new KieError(`${model}: ANTHROPIC_API_KEY is not set`);
  const base = process.env.ANTHROPIC_API_BASE || "https://api.anthropic.com";
  const url = direct ? `${base}/v1/messages` : isClaude ? `${apiBase()}/claude/v1/messages` : (PLAIN_PATH.test(model) ? `${apiBase()}/${model}/v1/chat/completions` : `${apiBase()}/${model}-openai/v1/chat/completions`);
  let body;
  if (isClaude) {
    body = { model: name, max_tokens: maxTokens, stream: false, ...(system ? { system } : {}), messages: messages.map((m) => ({ role: m.role, content: toClaudeContent(m.content) })) };
  } else {
    const msgs = messages.map((m) => ({ role: m.role, content: toOpenAIContent(m.content) }));
    if (system) msgs.unshift({ role: "system", content: system });
    body = { messages: msgs, stream: false };
  }
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(direct ? { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" } : authHeaders()) }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e instanceof KieError) throw e;
    throw new KieError(`${model}: network error: ${e.message}`, { retryable: true });
  }
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* not json */ }
  if (res.status >= 500 || res.status === 429) {
    throw new KieError(`${model}: HTTP ${res.status} ${((json && json.error && json.error.message) || raw).slice(0, 160)}`, { status: res.status, retryable: true });
  }
  if (json && typeof json.code === "number" && json.code !== 200 && !json.choices && !json.content) {
    throw new KieError(`${model}: ${json.code} ${json.msg}`, { code: json.code, retryable: json.code >= 500 || json.code === 429 });
  }
  if (!res.ok || !json) throw new KieError(`${model}: HTTP ${res.status} ${raw.slice(0, 160)}`, { status: res.status });
  let text = isClaude
    ? (json.content || []).filter((p) => p.type === "text").map((p) => p.text).join("")
    : json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (typeof text === "string") text = text.replace(/<\/?escape>/g, "").trim(); // gpt models on kie wrap replies in <escape> tags
  if (!text) throw new KieError(`${model}: empty response ${raw.slice(0, 160)}`, { retryable: true });
  return text;
}

// A model that just failed all its attempts is skipped for a few minutes, so one outage costs the first
// request a delay, not every request after it. If every model is marked down we try them anyway.
const DOWN_MS = 3 * 60 * 1000;
const downUntil = new Map();
const isDown = (m) => (downUntil.get(m) || 0) > Date.now();
function resetModelHealth() { downUntil.clear(); }

/**
 * One chat call with retry + model fallback.
 * messages: [{ role, content }] where content is a string or parts
 *   [{ type:'text', text } | { type:'media', url }].
 * Models earlier in the chain get 2 attempts (so a down model is given up on quickly); the last gets the full retries.
 * onModel(model) is told which model actually answered, so callers can say when a backup was used.
 */
async function chat({ messages, system, models = textModels(), maxTokens = 4096, retries = 2, timeoutMs = 300000, onModel }) {
  const live = models.filter((m) => !isDown(m));
  const order = live.length ? live : models;
  let lastErr;
  for (const [mi, model] of order.entries()) {
    const attempts = mi === order.length - 1 ? retries + 1 : Math.min(2, retries + 1);
    let transientFailure = false;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const text = await callOnce(model, { messages, system, maxTokens, timeoutMs });
        downUntil.delete(model);
        if (onModel) { try { onModel(model); } catch { /* informational */ } }
        return text;
      } catch (err) {
        lastErr = err;
        if (!(err instanceof KieError) || !err.retryable) break; // permanent for this model -> next model
        transientFailure = true;
        if (attempt < attempts - 1) await sleep(2000 * 2 ** attempt);
      }
    }
    if (transientFailure) downUntil.set(model, Date.now() + DOWN_MS);
  }
  throw lastErr || new KieError("chat failed");
}

/**
 * The complete top-level objects of a JSON array that was cut off partway (the model hit its length limit or the
 * connection dropped). Returns [] when there is no complete item. Pure.
 */
function salvageArray(t) {
  const start = t.indexOf("[");
  if (start === -1) return [];
  const items = [];
  let depth = 0, inStr = false, esc = false, itemStart = -1;
  for (let i = start + 1; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) itemStart = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && itemStart !== -1) { try { items.push(JSON.parse(t.slice(itemStart, i + 1))); } catch { /* skip a bad item */ } itemStart = -1; }
      if (depth < 0) break;
    }
  }
  return items;
}

function extractJSON(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(t); } catch { /* fall through */ }
  const start = t.search(/[[{]/);
  if (start === -1) throw new Error("no JSON found");
  const close = t[start] === "{" ? "}" : "]";
  const end = t.lastIndexOf(close);
  if (end > start) { try { return JSON.parse(t.slice(start, end + 1)); } catch { /* cut off or malformed: try to salvage below */ } }
  if (t[start] === "[") { const items = salvageArray(t.slice(start)); if (items.length) return items; }
  throw new Error("the reply was cut off or not valid JSON");
}

/** chat() then parse JSON out of the reply; one re-ask on parse failure. */
async function chatJSON(args) {
  const first = await chat(args);
  try { return extractJSON(first); } catch {
    const again = await chat({
      ...args,
      messages: [
        ...args.messages,
        { role: "assistant", content: first },
        { role: "user", content: "That was not valid JSON. Reply again with ONLY the JSON, no commentary, no code fences." },
      ],
    });
    try { return extractJSON(again); } catch (e) {
      // An unreadable reply twice in a row is the AI service misbehaving: let the runner retry the whole run on its own.
      throw new KieError(`unreadable reply from the AI service: ${e.message}`, { retryable: true });
    }
  }
}

/** Plain-language message for an admin when an AI call fails (the raw upstream text stays in server logs). */
function friendlyMessage(err) {
  if (err instanceof KieError) {
    if (/KIE_API_KEY is not set/.test(err.message)) return "The AI service isn't configured on this server (KIE_API_KEY is missing).";
    if (/^upload/.test(err.message)) return "The server couldn't send your video to the AI service's file host (kieai.redpandaai.co) in time. Press Retry; if it keeps happening, that host may be unreachable from this server.";
    return "The AI service is busy or unavailable right now. Give it a minute and try again.";
  }
  return (err && err.message) || "Something went wrong.";
}

module.exports = { chat, chatJSON, extractJSON, salvageArray, uploadFile, KieError, videoModels, textModels, friendlyMessage, resetModelHealth };
