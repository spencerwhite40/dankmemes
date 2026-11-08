"use strict";
// OpenAI GPT, called directly (Chat Completions). Text only here.
//   OPENAI_API_KEY     OPENAI_API_BASE  default https://api.openai.com
const { AiError } = require("../errors");
const { keyFor } = require("../models");

const base = () => process.env.OPENAI_API_BASE || "https://api.openai.com";
const headers = (extra) => ({ Authorization: `Bearer ${keyFor("openai")}`, ...extra });
const needKey = () => { if (!keyFor("openai")) throw new AiError("openai: OPENAI_API_KEY is not set on this server.", { code: "no_key" }); };
const canReadMedia = () => false;

function classify(status, json, raw, model) {
  const e = (json && json.error) || {};
  const msg = e.message || String(raw).slice(0, 200);
  if (status === 401) return new AiError(`openai: ${model}: the API key was rejected (${msg.slice(0, 100)})`, { status, code: "bad_key" });
  if (e.code === "insufficient_quota" || /exceeded your current quota|billing/i.test(msg)) return new AiError(`openai: ${model}: the account is out of credit (${msg.slice(0, 100)})`, { status, code: "out_of_credit" });
  if (status === 404 || e.code === "model_not_found") return new AiError(`openai: model "${model}" was not found (${msg.slice(0, 100)})`, { status, code: "no_model" });
  if (status >= 500 || status === 429) return new AiError(`openai: ${model}: HTTP ${status} ${msg.slice(0, 160)}`, { status, retryable: true });
  return new AiError(`openai: ${model}: HTTP ${status} ${msg.slice(0, 200)}`, { status });
}

const textOf = (content) => (typeof content === "string" ? content : content.filter((p) => p.type === "text").map((p) => p.text).join("\n"));

async function call(model, { messages, system, maxTokens, timeoutMs }) {
  needKey();
  const msgs = messages.map((m) => ({ role: m.role, content: textOf(m.content) }));
  if (system) msgs.unshift({ role: "system", content: system });
  let res;
  try {
    res = await fetch(`${base()}/v1/chat/completions`, { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify({ model, messages: msgs, max_completion_tokens: maxTokens }), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) { throw new AiError(`openai: ${model}: network error: ${e.message}`, { retryable: true }); }
  const raw = await res.text();
  let j = null; try { j = JSON.parse(raw); } catch { /* not json */ }
  if (!res.ok || !j) throw classify(res.status, j, raw, model);
  const choice = j.choices && j.choices[0];
  const text = choice && choice.message && choice.message.content;
  const u = j.usage || {};
  // completion_tokens already includes reasoning tokens.
  const usage = { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cached: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0 };
  if (!text) throw new AiError(`openai: ${model}: empty response (${(choice && choice.finish_reason) || "no choices"})`, { retryable: true });
  return { text, usage };
}

async function listModels() {
  needKey();
  const r = await fetch(`${base()}/v1/models`, { headers: headers(), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new AiError(`openai: could not list models (HTTP ${r.status})`, { status: r.status });
  return (j.data || []).map((m) => m.id);
}

module.exports = { call, listModels, canReadMedia, classify };
