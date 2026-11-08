"use strict";
// kie.ai, kept as a selectable provider while its credits last: chat (Gemini, Claude, GPT through one gateway) and temporary file
// hosting (Gemini there can only read a video from a public URL).
//   KIE_API_KEY     KIE_API_BASE default https://api.kie.ai     KIE_UPLOAD_BASE default https://kieai.redpandaai.co
// kie.ai reports many failures as HTTP 200 + { code, msg }, so both shapes are handled.
const fs = require("node:fs");
const path = require("node:path");
const { AiError } = require("../errors");
const { keyFor } = require("../models");

const apiBase = () => process.env.KIE_API_BASE || "https://api.kie.ai";
const uploadBase = () => process.env.KIE_UPLOAD_BASE || "https://kieai.redpandaai.co";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// kie.ai serves the GPT and Gemini Pro models at /<model>/v1/chat/completions, and the Gemini Flash models at /<model>-openai/v1/chat/completions.
const PLAIN_PATH = /^(gpt-|gemini-[\d.]+-pro)/;

function authHeaders() {
  const key = keyFor("kie");
  if (!key) throw new AiError("KIE_API_KEY is not set on this server.", { code: "no_key" });
  return { Authorization: `Bearer ${key}` };
}

const canReadMedia = (url) => /^https?:\/\//.test(String(url)) && !String(url).includes("generativelanguage.googleapis.com");

/** One upload attempt, aborted if it takes longer than timeoutMs (a stalled connection must not hang a run). */
async function uploadOnce(filePath, { uploadPath, fileName, timeoutMs }) {
  const form = new FormData();
  const { size } = await fs.promises.stat(filePath);
  const blob = size <= 150 * 1024 * 1024 ? new Blob([await fs.promises.readFile(filePath)]) : await fs.openAsBlob(filePath);
  form.append("file", blob, fileName || path.basename(filePath));
  form.append("uploadPath", uploadPath);
  let res;
  try {
    res = await fetch(`${uploadBase()}/api/file-stream-upload`, { method: "POST", headers: authHeaders(), body: form, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e instanceof AiError) throw e;
    throw new AiError(`upload: ${e && e.name === "TimeoutError" ? `no answer after ${Math.round(timeoutMs / 1000)}s` : `network error: ${e.message}`}`, { retryable: true });
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new AiError(`upload: bad response (${res.status}): ${text.slice(0, 200)}`, { status: res.status, retryable: res.status >= 500 }); }
  if (!json.success || json.code !== 200) throw new AiError(`upload failed: ${json.msg || text.slice(0, 200)}`, { code: json.code, retryable: (json.code || 0) >= 500 });
  return json.data.downloadUrl;
}

/** Upload a local file to kie.ai's temp host (auto-deleted after ~24h). Returns a public URL. Retries stalls and 5xx. */
async function upload(filePath, { uploadPath = "meme-builder", fileName, timeoutMs = 3 * 60 * 1000, attempts = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await uploadOnce(filePath, { uploadPath, fileName, timeoutMs }); }
    catch (err) {
      lastErr = err;
      if (!(err instanceof AiError) || !err.retryable) break;
      if (i < attempts - 1) await sleep(2000 * 2 ** i);
    }
  }
  throw lastErr;
}

// kie.ai's Gemini route wants every media file as { type:'image_url', image_url:{ url } }, video included.
const toOpenAIContent = (c) => (typeof c === "string" ? c : c.map((p) => (p.type === "media" ? { type: "image_url", image_url: { url: p.url } } : p)));
const toClaudeContent = (c) => (typeof c === "string" ? c : c.filter((p) => p.type === "text"));

/** One chat call; `model` is the bare kie.ai name (e.g. "gemini-3-6-flash"). Returns { text, usage }. */
async function call(model, { messages, system, maxTokens, timeoutMs }) {
  const isClaude = model.startsWith("claude");
  const url = isClaude ? `${apiBase()}/claude/v1/messages` : (PLAIN_PATH.test(model) ? `${apiBase()}/${model}/v1/chat/completions` : `${apiBase()}/${model}-openai/v1/chat/completions`);
  let body;
  if (isClaude) {
    body = { model, max_tokens: maxTokens, stream: false, ...(system ? { system } : {}), messages: messages.map((m) => ({ role: m.role, content: toClaudeContent(m.content) })) };
  } else {
    const msgs = messages.map((m) => ({ role: m.role, content: toOpenAIContent(m.content) }));
    if (system) msgs.unshift({ role: "system", content: system });
    body = { messages: msgs, stream: false };
  }
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e instanceof AiError) throw e;
    throw new AiError(`${model}: network error: ${e.message}`, { retryable: true });
  }
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* not json */ }
  if (res.status >= 500 || res.status === 429) {
    throw new AiError(`${model}: HTTP ${res.status} ${((json && json.error && json.error.message) || raw).slice(0, 160)}`, { status: res.status, retryable: true });
  }
  if (json && typeof json.code === "number" && json.code !== 200 && !json.choices && !json.content) {
    throw new AiError(`${model}: ${json.code} ${json.msg}`, { code: json.code, retryable: json.code >= 500 || json.code === 429 });
  }
  if (!res.ok || !json) throw new AiError(`${model}: HTTP ${res.status} ${raw.slice(0, 160)}`, { status: res.status });
  let text = isClaude
    ? (json.content || []).filter((p) => p.type === "text").map((p) => p.text).join("")
    : json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (typeof text === "string") text = text.replace(/<\/?escape>/g, "").trim();   // gpt models on kie wrap replies in <escape> tags
  if (!text) throw new AiError(`${model}: empty response ${raw.slice(0, 160)}`, { retryable: true });
  const u = json.usage || {};
  return { text, usage: { input: u.prompt_tokens || u.input_tokens || 0, output: u.completion_tokens || u.output_tokens || 0, cached: 0 } };
}

module.exports = { call, upload, canReadMedia };
