"use strict";
// The one door to AI models. Everything else in the app calls chat / chatJSON / uploadFile here and never knows which provider answered.
//
//  - Models are named "provider:model" (see models.js). A chain is tried in order; a model that just failed is skipped for a few minutes.
//  - A temporary failure (5xx, rate limit, network) is retried with backoff, then the next model takes over. A permanent one
//    (bad key, out of credit, unknown model) moves straight to the next model.
//  - Models that can't read the video that was uploaded are left out of that call, so a video chain can mix providers safely.
//  - Every call is written to the usage ledger against the account and run that caused it.
const { AiError } = require("./errors");
const models = require("./models");
const ledger = require("./ledger");
const { extractJSON, salvageArray } = require("./json");

const providers = {
  google: require("./providers/google"),
  anthropic: require("./providers/anthropic"),
  openai: require("./providers/openai"),
  kie: require("./providers/kie"),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mediaUrls = (messages) => messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === "media").map((p) => p.url) : []));

// A model that just failed all its attempts is skipped for a few minutes, so one outage costs the first
// request a delay, not every request after it. If every model is marked down we try them anyway.
const DOWN_MS = 3 * 60 * 1000;
const downUntil = new Map();
// A provider whose prepaid balance is empty fails every request the same way, so it is set aside as a whole for a few
// minutes (and said so in the log, once per window). It comes back by itself once it has been topped up.
const FUNDING_DOWN_MS = 5 * 60 * 1000;
const unfunded = new Map();
const providerDown = (provider) => (unfunded.get(provider) || 0) > Date.now();
const isDown = (m) => (downUntil.get(m) || 0) > Date.now() || providerDown(models.parseModelId(m).provider);
function resetModelHealth() { downUntil.clear(); unfunded.clear(); }

/** The models from a chain that can actually be used for this request. */
function usable(chain, urls) {
  return chain.filter((id) => {
    const { provider } = models.parseModelId(id);
    if (!models.configured(provider)) return false;
    return urls.every((u) => providers[provider].canReadMedia(u));
  });
}

/**
 * One chat call with retry + model fallback.
 * messages: [{ role, content }] where content is a string or parts [{ type:'text', text } | { type:'media', url }].
 * Models earlier in the chain get 2 attempts (so a down model is given up on quickly); the last gets the full retries.
 * onModel(model) is told which model actually answered, so callers can say when a backup was used.
 * json: ask providers that support it for a JSON-only reply.
 */
async function chat({ messages, system, models: chain, maxTokens = 4096, retries = 2, timeoutMs = 300000, onModel, json = false }) {
  const urls = mediaUrls(messages);
  const ctx = ledger.getContext();
  const dflt = urls.length ? models.videoModels() : models.textModels();
  // An account on the standard tier gets the cheaper models; an explicit chain (a test, a one-off) is used as given.
  const want = chain || (ctx && ctx.tier === "standard" ? models.standardOnly(dflt) : dflt);
  const candidates = usable(want, urls);
  if (!candidates.length) {
    throw new AiError(urls.length
      ? "No AI model is set up that can watch this video. Set GOOGLE_API_KEY (or KIE_API_KEY) on the server."
      : "No AI model is set up. Set GOOGLE_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY (or KIE_API_KEY) on the server.", { code: "no_provider" });
  }
  const live = candidates.filter((m) => !isDown(m));
  const order = live.length ? live : candidates;
  let lastErr;
  for (const [mi, id] of order.entries()) {
    const { provider, model } = models.parseModelId(id);
    const attempts = mi === order.length - 1 ? retries + 1 : Math.min(2, retries + 1);
    let transientFailure = false;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const t0 = Date.now();
      try {
        const out = await providers[provider].call(model, { messages, system, maxTokens, timeoutMs, json });
        downUntil.delete(id);
        ledger.record({ provider, model, kind: urls.length ? "video" : "text", usage: out.usage, latencyMs: Date.now() - t0, ok: true });
        if (onModel) { try { onModel(id); } catch { /* informational */ } }
        return out.text;
      } catch (err) {
        lastErr = err;
        ledger.record({ provider, model, kind: urls.length ? "video" : "text", usage: {}, latencyMs: Date.now() - t0, ok: false, error: err && err.message });
        if (err instanceof AiError && err.code === "out_of_credit") {
          if (!providerDown(provider)) console.error(`[funding] ${provider} is out of credit. Top it up (or raise its auto-reload). Using the next provider meanwhile.`);
          unfunded.set(provider, Date.now() + FUNDING_DOWN_MS);
        }
        if (!(err instanceof AiError) || !err.retryable) break;   // permanent for this model -> next model
        transientFailure = true;
        if (attempt < attempts - 1) await sleep(2000 * 2 ** attempt);
      }
    }
    if (transientFailure) downUntil.set(id, Date.now() + DOWN_MS);
  }
  throw lastErr || new AiError("chat failed");
}

/** chat() then parse JSON out of the reply; one re-ask on parse failure. */
async function chatJSON(args) {
  const first = await chat({ ...args, json: true });
  try { return extractJSON(first); } catch {
    const again = await chat({
      ...args, json: true,
      messages: [
        ...args.messages,
        { role: "assistant", content: first },
        { role: "user", content: "That was not valid JSON. Reply again with ONLY the JSON, no commentary, no code fences." },
      ],
    });
    try { return extractJSON(again); } catch (e) {
      // An unreadable reply twice in a row is the AI service misbehaving: let the runner retry the whole run on its own.
      throw new AiError(`unreadable reply from the AI service: ${e.message}`, { retryable: true });
    }
  }
}

/** Which provider holds uploaded videos: MEME_BUILDER_UPLOAD_PROVIDER, else Google when it is set up, else kie.ai. */
function uploadProvider() {
  const want = (process.env.MEME_BUILDER_UPLOAD_PROVIDER || "").toLowerCase();
  if ((want === "google" || want === "kie") && models.configured(want)) return want;
  if (models.configured("google")) return "google";
  return "kie";
}

/** Upload a small analysis copy where the video model can read it. Returns a URL to put in a { type:'media' } part. Retries stalls and 5xx. */
async function uploadFile(filePath, opts = {}) {
  const provider = uploadProvider();
  const attempts = opts.attempts || 3;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await providers[provider].upload(filePath, { ...opts, attempts: 1 }); }
    catch (err) {
      lastErr = err;
      if (!(err instanceof AiError) || !err.retryable) break;
      if (i < attempts - 1) await sleep(2000 * 2 ** i);
    }
  }
  throw lastErr;
}

/** Plain-language message for a user when an AI call fails (the raw upstream text stays in server logs). */
function friendlyMessage(err) {
  if (err instanceof AiError) {
    if (err.code === "no_provider" || err.code === "no_key" || /_API_KEY is not set/.test(err.message)) return "The AI service isn't set up on this server (an API key is missing).";
    if (err.code === "out_of_credit") return "The AI account has run out of credit. The site owner needs to top it up.";
    if (err.code === "bad_key") return "The AI service rejected the server's API key. The site owner needs to check it.";
    if (/^upload/.test(err.message)) return "The server couldn't send your video to the AI service in time. Press Retry; if it keeps happening, the AI service may be unreachable right now.";
    return "The AI service is busy or unavailable right now. Give it a minute and try again.";
  }
  return (err && err.message) || "Something went wrong.";
}

/** For `npm run models:check`: for each configured provider, which of the configured model names exist. */
async function checkModels() {
  const wanted = new Map();
  for (const id of [...models.videoModels(), ...models.textModels()]) wanted.set(id, true);
  const report = [];
  for (const provider of models.configuredProviders()) {
    if (!providers[provider].listModels) { report.push({ provider, note: "no model list available for this provider" }); continue; }
    try {
      const available = await providers[provider].listModels();
      const mine = [...wanted.keys()].map(models.parseModelId).filter((m) => m.provider === provider).map((m) => m.model);
      report.push({ provider, available: available.length, ok: mine.filter((m) => available.includes(m)), missing: mine.filter((m) => !available.includes(m)), sample: available.slice(0, 40) });
    } catch (e) { report.push({ provider, error: e.message }); }
  }
  return report;
}

module.exports = {
  chat, chatJSON, extractJSON, salvageArray, uploadFile, uploadProvider, AiError, KieError: AiError,
  videoModels: models.videoModels, textModels: models.textModels, friendlyMessage, resetModelHealth, checkModels, ledger, models,
};
