"use strict";
// Google Gemini, called directly. Watches video (via the Files API) and writes text.
//   GOOGLE_API_KEY (or GEMINI_API_KEY)     GOOGLE_API_BASE  default https://generativelanguage.googleapis.com
const fs = require("node:fs");
const path = require("node:path");
const { AiError } = require("../errors");
const { keyFor } = require("../models");

const base = () => process.env.GOOGLE_API_BASE || "https://generativelanguage.googleapis.com";
const headers = (extra) => ({ "x-goog-api-key": keyFor("google"), ...extra });
const needKey = () => { if (!keyFor("google")) throw new AiError("google: GOOGLE_API_KEY is not set on this server.", { code: "no_key" }); };

const MIME = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska", ".m4v": "video/mp4", ".avi": "video/x-msvideo" };
const mimeByUri = new Map();   // set when a file is uploaded, so a later request can name the type

/** Is this URL one of Google's uploaded files (the only video source Gemini reads directly)? */
const canReadMedia = (url) => String(url).startsWith(`${base()}/v1beta/files/`);

function classify(status, json, raw, model) {
  const msg = (json && json.error && json.error.message) || String(raw).slice(0, 200);
  const reason = json && json.error && json.error.status;
  if (status === 401 || status === 403 || /API key (not valid|expired)|PERMISSION_DENIED/i.test(msg)) return new AiError(`google: ${model}: the API key was rejected (${msg.slice(0, 100)})`, { status, code: "bad_key" });
  if (status === 429 && /quota|billing|exhausted/i.test(msg) && reason === "RESOURCE_EXHAUSTED" && /per day|billing|free/i.test(msg)) return new AiError(`google: ${model}: out of quota (${msg.slice(0, 100)})`, { status, code: "out_of_credit" });
  if (status === 404) return new AiError(`google: model "${model}" was not found (${msg.slice(0, 100)})`, { status, code: "no_model" });
  if (status >= 500 || status === 429) return new AiError(`google: ${model}: HTTP ${status} ${msg.slice(0, 160)}`, { status, retryable: true });
  return new AiError(`google: ${model}: HTTP ${status} ${msg.slice(0, 200)}`, { status });
}

function toParts(content) {
  if (typeof content === "string") return [{ text: content }];
  return content.map((p) => (p.type === "media" ? { fileData: { fileUri: p.url, mimeType: mimeByUri.get(p.url) || "video/mp4" } } : { text: p.text }));
}

/** One generateContent call. Returns { text, usage: { input, output, cached } }. */
async function call(model, { messages, system, maxTokens, timeoutMs, json }) {
  needKey();
  const body = {
    contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: toParts(m.content) })),
    generationConfig: { maxOutputTokens: maxTokens, ...(json ? { responseMimeType: "application/json" } : {}) },
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  };
  let res;
  try {
    res = await fetch(`${base()}/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) { throw new AiError(`google: ${model}: network error: ${e.message}`, { retryable: true }); }
  const raw = await res.text();
  let j = null; try { j = JSON.parse(raw); } catch { /* not json */ }
  if (!res.ok || !j) throw classify(res.status, j, raw, model);
  if (j.promptFeedback && j.promptFeedback.blockReason) throw new AiError(`google: ${model}: the request was blocked (${j.promptFeedback.blockReason})`, { code: "blocked" });
  const cand = j.candidates && j.candidates[0];
  const text = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("") : "";
  const u = j.usageMetadata || {};
  const usage = { input: u.promptTokenCount || 0, output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), cached: u.cachedContentTokenCount || 0 };
  if (!text) throw new AiError(`google: ${model}: empty response (${(cand && cand.finishReason) || "no candidates"})`, { retryable: true });
  return { text, usage };
}

/** Upload a video to Google's Files API (kept 48 hours) and wait until it is ready. Returns the file's URI. */
async function upload(filePath, { displayName, timeoutMs = 3 * 60 * 1000, pollMs = 1500 } = {}) {
  needKey();
  const { size } = await fs.promises.stat(filePath);
  const mime = MIME[path.extname(filePath).toLowerCase()] || "video/mp4";
  const signal = () => AbortSignal.timeout(timeoutMs);
  let start;
  try {
    start = await fetch(`${base()}/upload/v1beta/files`, {
      method: "POST", signal: signal(),
      headers: headers({ "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start", "X-Goog-Upload-Header-Content-Length": String(size), "X-Goog-Upload-Header-Content-Type": mime, "Content-Type": "application/json" }),
      body: JSON.stringify({ file: { display_name: displayName || path.basename(filePath) } }),
    });
  } catch (e) { throw new AiError(`upload: ${e.name === "TimeoutError" ? "no answer from Google" : `network error: ${e.message}`}`, { retryable: true }); }
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!start.ok || !uploadUrl) { const raw = await start.text(); let j = null; try { j = JSON.parse(raw); } catch { /* not json */ } throw classify(start.status, j, raw, "file upload"); }
  let fin;
  try {
    fin = await fetch(uploadUrl, { method: "POST", signal: signal(), headers: { "Content-Length": String(size), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }, body: await fs.promises.readFile(filePath) });
  } catch (e) { throw new AiError(`upload: ${e.name === "TimeoutError" ? "no answer from Google" : `network error: ${e.message}`}`, { retryable: true }); }
  const raw = await fin.text(); let j = null; try { j = JSON.parse(raw); } catch { /* not json */ }
  if (!fin.ok || !j || !j.file) throw classify(fin.status, j, raw, "file upload");
  let file = j.file;
  const deadline = Date.now() + timeoutMs;
  while (file.state === "PROCESSING") {
    if (Date.now() > deadline) throw new AiError("upload: Google is still processing the video after 3 minutes", { retryable: true });
    await new Promise((r) => setTimeout(r, pollMs));
    const r = await fetch(`${base()}/v1beta/${file.name}`, { headers: headers(), signal: signal() });
    file = (await r.json().catch(() => ({}))) || file;
    if (!file.state) throw new AiError("upload: could not read the video's processing state", { retryable: true });
  }
  if (file.state === "FAILED") throw new AiError("upload: Google could not process this video", { code: "bad_video" });
  mimeByUri.set(file.uri, file.mimeType || mime);
  return file.uri;
}

/** Model ids this key can use (for the model check). */
async function listModels() {
  needKey();
  const out = []; let pageToken = "";
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${base()}/v1beta/models?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ""}`, { headers: headers(), signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new AiError(`google: could not list models (HTTP ${r.status})`, { status: r.status });
    out.push(...(j.models || []).map((m) => String(m.name).replace(/^models\//, "")));
    pageToken = j.nextPageToken; if (!pageToken) break;
  }
  return out;
}

module.exports = { call, upload, listModels, canReadMedia, classify };
