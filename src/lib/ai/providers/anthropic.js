"use strict";
// Anthropic Claude, called directly. Text only (it can't watch video).
//   ANTHROPIC_API_KEY     ANTHROPIC_API_BASE  default https://api.anthropic.com
const { AiError } = require("../errors");
const { keyFor } = require("../models");

const base = () => process.env.ANTHROPIC_API_BASE || "https://api.anthropic.com";
const headers = (extra) => ({ "x-api-key": keyFor("anthropic"), "anthropic-version": "2023-06-01", ...extra });
const needKey = () => { if (!keyFor("anthropic")) throw new AiError("anthropic: ANTHROPIC_API_KEY is not set on this server.", { code: "no_key" }); };
const canReadMedia = () => false;

function classify(status, json, raw, model) {
  const msg = (json && json.error && json.error.message) || String(raw).slice(0, 200);
  if (status === 402) return new AiError(`anthropic: ${model}: the account is out of credit (${msg.slice(0, 100)})`, { status, code: "out_of_credit" });
  if (status === 401 || status === 403) return new AiError(`anthropic: ${model}: the API key was rejected (${msg.slice(0, 100)})`, { status, code: "bad_key" });
  if (/credit balance is too low|billing/i.test(msg)) return new AiError(`anthropic: ${model}: the account is out of credit (${msg.slice(0, 100)})`, { status, code: "out_of_credit" });
  if (status === 404 || (json && json.error && json.error.type === "not_found_error")) return new AiError(`anthropic: model "${model}" was not found (${msg.slice(0, 100)})`, { status, code: "no_model" });
  if (status >= 500 || status === 429 || status === 529) return new AiError(`anthropic: ${model}: HTTP ${status} ${msg.slice(0, 160)}`, { status, retryable: true });
  return new AiError(`anthropic: ${model}: HTTP ${status} ${msg.slice(0, 200)}`, { status });
}

const textOf = (content) => (typeof content === "string" ? content : content.filter((p) => p.type === "text").map((p) => p.text).join("\n"));

/** One Messages call. The system prompt (the long audience profile) is marked cacheable, so repeated calls with the same one are cheaper and faster. */
async function call(model, { messages, system, maxTokens, timeoutMs }) {
  needKey();
  const body = {
    model, max_tokens: maxTokens,
    ...(system ? { system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] } : {}),
    messages: messages.map((m) => ({ role: m.role, content: [{ type: "text", text: textOf(m.content) }] })),
  };
  let res;
  try {
    res = await fetch(`${base()}/v1/messages`, { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) { throw new AiError(`anthropic: ${model}: network error: ${e.message}`, { retryable: true }); }
  const raw = await res.text();
  let j = null; try { j = JSON.parse(raw); } catch { /* not json */ }
  if (!res.ok || !j) throw classify(res.status, j, raw, model);
  const text = (j.content || []).filter((p) => p.type === "text").map((p) => p.text).join("");
  const u = j.usage || {};
  // Cached reads and cache writes are input too; "cached" is the cheaper portion.
  const usage = { input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0, cached: u.cache_read_input_tokens || 0 };
  if (!text) throw new AiError(`anthropic: ${model}: empty response (${j.stop_reason || "no content"})`, { retryable: true });
  return { text, usage };
}

async function listModels() {
  needKey();
  const r = await fetch(`${base()}/v1/models?limit=200`, { headers: headers(), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new AiError(`anthropic: could not list models (HTTP ${r.status})`, { status: r.status });
  return (j.data || []).map((m) => m.id);
}

module.exports = { call, listModels, canReadMedia, classify };
