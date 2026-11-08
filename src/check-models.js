"use strict";
// npm run models:check: asks each provider (with your keys) whether the model names the app is set to use actually exist.
const ai = require("./lib/ai");

(async () => {
  const providers = ai.models.configuredProviders();
  if (!providers.length) { console.log("No AI provider keys are set. Set GOOGLE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY and/or KIE_API_KEY."); process.exit(1); }
  console.log("Video models:", ai.videoModels().join(", ") || "(none)");
  console.log("Text models: ", ai.textModels().join(", ") || "(none)\n");
  let bad = false;
  for (const r of await ai.checkModels()) {
    if (r.error) { bad = true; console.log(`\n${r.provider}: could not check: ${r.error}`); continue; }
    if (r.note) { console.log(`\n${r.provider}: ${r.note}`); continue; }
    console.log(`\n${r.provider}: ${r.available} models available`);
    r.ok.forEach((m) => console.log(`  OK       ${m}`));
    r.missing.forEach((m) => { bad = true; console.log(`  MISSING  ${m}`); });
    if (r.missing.length) console.log(`  some available names: ${r.sample.filter((s) => /gemini|claude|gpt|o\d/.test(s)).slice(0, 25).join(", ")}`);
  }
  if (bad) console.log("\nFix missing names with MEME_BUILDER_VIDEO_MODELS / MEME_BUILDER_TEXT_MODELS (or GOOGLE_FLASH_MODEL, GOOGLE_PRO_MODEL, ANTHROPIC_WRITER_MODEL, OPENAI_MODEL).");
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
