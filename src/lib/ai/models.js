"use strict";
// Which providers are set up, how a model is named, and the default model chains.
//
// A model is written "provider:model", e.g. "google:gemini-3.1-pro" or "anthropic:claude-fable-5-1".
// Without a prefix it means kie.ai (how models were named before direct connections).
//
// The default NAMES below are best guesses and provider docs are inconsistent about them, so they can all be overridden
// with env settings, and `npm run models:check` asks each provider's own model list whether a name exists.

const PROVIDERS = ["google", "anthropic", "openai", "kie"];
const KEY_ENV = {
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  kie: ["KIE_API_KEY"],
};

const keyFor = (provider) => (KEY_ENV[provider] || []).map((k) => process.env[k]).find(Boolean) || "";
const configured = (provider) => !!keyFor(provider);
const configuredProviders = () => PROVIDERS.filter(configured);

function parseModelId(id) {
  const m = /^(google|anthropic|openai|kie):(.+)$/.exec(String(id));
  return m ? { provider: m[1], model: m[2] } : { provider: "kie", model: String(id) };
}

const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
const env = (name, fallback) => process.env[name] || fallback;

/** The model names behind the defaults. */
const names = () => ({
  googleFlash: env("GOOGLE_FLASH_MODEL", "gemini-3.6-flash"),
  googlePro: env("GOOGLE_PRO_MODEL", "gemini-3.1-pro"),
  claudeWriter: env("ANTHROPIC_WRITER_MODEL", "claude-fable-5-1"),
  claudeBalanced: env("ANTHROPIC_BALANCED_MODEL", "claude-sonnet-5-5"),
  openai: env("OPENAI_MODEL", "gpt-5.2"),
});

/** Models that watch video. Only Google (or kie.ai's Gemini) can: fast first, the Pro model as the fallback. */
function videoModels() {
  const override = list(process.env.MEME_BUILDER_VIDEO_MODELS);
  if (override.length) return override;
  const n = names();
  const out = [];
  if (configured("google")) out.push(`google:${n.googleFlash}`, `google:${n.googlePro}`);
  if (configured("kie")) out.push("kie:gemini-3-6-flash", "kie:gemini-3.1-pro", "kie:gemini-3-pro", "kie:gemini-3-8-flash");
  return out;
}

/** Models that write captions, best first: Claude for the humor, then Gemini Pro and GPT (different vendors, so one outage can't take them all). */
function textModels() {
  const override = list(process.env.MEME_BUILDER_TEXT_MODELS);
  if (override.length) return override;
  const n = names();
  const out = [];
  if (configured("anthropic")) out.push(`anthropic:${n.claudeWriter}`);
  if (configured("google")) out.push(`google:${n.googlePro}`);
  if (configured("openai")) out.push(`openai:${n.openai}`);
  if (configured("anthropic")) out.push(`anthropic:${n.claudeBalanced}`);
  if (configured("google")) out.push(`google:${n.googleFlash}`);
  if (configured("kie")) out.push("kie:gemini-3.1-pro", "kie:claude-sonnet-5-5", "kie:gpt-5-2", "kie:gemini-3-6-flash");
  return out;
}

/** The most expensive models (the caption writer and the Pro watcher/writer). Plans on the "standard" tier do not use them. */
function isPremium(id) {
  const n = names();
  const { provider, model } = parseModelId(id);
  if (provider === "anthropic") return model === n.claudeWriter;
  if (provider === "google") return model === n.googlePro;
  return /-pro$|^claude/.test(model);       // kie.ai's Pro and Claude models
}
const standardOnly = (chain) => { const lean = chain.filter((id) => !isPremium(id)); return lean.length ? lean : chain; };

module.exports = { isPremium, standardOnly, PROVIDERS, keyFor, configured, configuredProviders, parseModelId, videoModels, textModels, names };
