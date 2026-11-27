"use strict";

// Meme Builder — audience personas.
//
// A persona is a deep, structured description of an audience (vocabulary,
// pain points, in-jokes, how they are funny, the caption formats that work).
// Built-in presets ship in ./presets (read-only). Custom ones live in
// meme_builder_personas and can be created from rough notes (the model
// expands them) or imported as ready JSON. personaToPrompt() turns one into
// the system prompt the caption writer uses; tasteToPrompt() appends the
// admin's own thumbs up/down history for that audience.

const { chatJSON } = require("./ai");

const PRESETS = [require("./presets/truckers.json")];
// "Owner-operators" was merged into "Truckers" (most owner-operators drive their own truck). Runs and clips saved under the old id still resolve.
const PRESET_ALIASES = { "owner-operators": "truckers" };
const PRESET_IDS = new Set([...PRESETS.map((p) => p.id), ...Object.keys(PRESET_ALIASES)]);

const PERSONA_FIELDS = {
  name: "short display name, e.g. \"Over-the-road trucker\"",
  summary: "one paragraph: who they are, in the first person plural (\"we\")",
  daily_life: "what a normal day/week looks like, concrete details",
  vocabulary: "array of insider terms/slang they use naturally",
  pain_points: "array of specific recurring frustrations",
  joys: "array of things that make them happy / proud",
  hot_buttons: "array of topics that reliably get an emotional reaction",
  in_jokes: "array of running jokes and shared references",
  humor_style: "how this audience is funny: tone, what lands, what feels cringe",
  reaction_playbook: "array of 6-8 entries: which emotions/clip types pair with which of their situations, plus the caption formats that work",
  authority_figures: "array of people/institutions they love or resent",
  never_say: "array of things that would instantly out the writer as an outsider",
  example_captions: "array of 8-12 setup captions in their voice, in the format used for reaction memes, varied in format (not all the same opener)",
  caption_formats: "array of 7-9 strings naming a caption format with a template and a filled-in example (When..., POV..., a two-line exchange, a number-first line, a one-line label, etc.), plus one entry for hooks on longer clips",
  good_vs_bad: "array of 6-8 strings: \"BAD (why): ... | GOOD: ...\" pairs showing the difference between a generic/outsider caption and a specific insider one, including one pair about a forced clip match that should be marked unusable",
  recurring_characters: "array of 6-9 recurring figures in their world, each with the one thing they always say or do",
  pairing_rules: "array of 5-7 rules for when a clip does and does not fit a caption (match emotion first, connection must be instant, topics to skip, never copy the examples)",
  overused_topics: "array of 4-6 topics this audience's memes already beat to death (the first jokes any outsider would reach for), so the writer only uses them when nothing fresher fits",
  spice_notes: "one or two sentences: what crude or raunchy means for THIS audience (their own gross-out, innuendo and swearing territory), and anything that is off limits for them",
};

const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

function isPresetId(id) { return PRESET_IDS.has(id); }
function getPreset(id) { const real = PRESET_ALIASES[id] || id; return PRESETS.find((p) => p.id === real) || null; }
function listPresets() { return PRESETS.map((p) => ({ ...p, preset: true })); }

// Starting points are drawn mostly from clean situations, with some crude and a few raunchy ones sprinkled in (0 clean, 1 crude, 2 raunchy).
const SPICE_WEIGHTS = { 0: 8, 1: 3, 2: 1.5 };
const SPICE_RULE =
  "Let each caption be as funny and as true to our lives as the scene allows. Most should be clean. Where the scene really calls for it, go crude or raunchy " +
  "(bodily functions, gross-out, innuendo from our own world, swearing) and sprinkle that in: never make a whole batch crude, and never force it where it is not the funniest option. " +
  "Keep it suggestive, never explicit; never about minors or anyone non-consenting; never targeting a race, religion, nationality, gender or sex workers.";
/** The spice rule for one audience: the shared limits, plus what crude means in their world (spice_notes), when the audience says. */
function spiceRule(persona) {
  const notes = persona && typeof persona.spice_notes === "string" ? persona.spice_notes.trim() : "";
  return notes ? `${SPICE_RULE} For us, that means: ${notes}` : SPICE_RULE;
}
/** "Skip these unless..." for the topics this audience's memes already beat to death; empty when the audience lists none. */
function overusedRule(persona) {
  const list = Array.isArray(persona && persona.overused_topics) ? persona.overused_topics.filter((x) => typeof x === "string" && x.trim()).slice(0, 8) : [];
  return list.length ? `The most overused topics for us are: ${list.join("; ")}. Skip them unless the clip's feeling demands exactly that and nothing above already used it.` : "";
}

/**
 * Starting points for a batch: for each of `count` clips, a few situations from different areas of life, so the
 * captions stop circling the same handful of topics. `state` ({ order, next }) persists across batches of a run so
 * the areas keep rotating. `rng` is injectable for tests. Returns [] seeds per clip, or [] when the audience has no bank.
 */
function pickSeeds(persona, count, { state = {}, perClip = 3, rng = Math.random } = {}) {
  const bank = Array.isArray(persona && persona.situation_bank) ? persona.situation_bank.filter((d) => d && Array.isArray(d.situations) && d.situations.length) : [];
  if (!bank.length) return Array.from({ length: count }, () => []);
  const weights = SPICE_WEIGHTS;
  const allowed = (d) => d.situations.filter((x) => x && typeof x.t === "string" && weights[x.s || 0]);
  const domains = bank.filter((d) => allowed(d).length);
  if (!domains.length) return Array.from({ length: count }, () => []);
  const shuffle = (a) => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };
  const pickFrom = (d) => {
    const pool = allowed(d), total = pool.reduce((n, x) => n + weights[x.s || 0], 0);
    let r = rng() * total;
    for (const x of pool) { r -= weights[x.s || 0]; if (r <= 0) return x.t; }
    return pool[pool.length - 1].t;
  };
  if (!state.order || !state.order.length) { state.order = shuffle(domains.map((_, i) => i)); state.next = 0; }
  return Array.from({ length: count }, () => {
    const out = [];
    const used = new Set();
    for (let k = 0; k < perClip; k++) {
      if (state.next >= state.order.length) { state.order = shuffle(domains.map((_, i) => i)); state.next = 0; }
      let idx = state.order[state.next++];
      if (used.has(idx)) { idx = Math.floor(rng() * domains.length); }
      used.add(idx);
      out.push(pickFrom(domains[idx]));
    }
    return out;
  });
}

/** Persona ids for custom personas: slug of the name, never a preset id. */
function customPersonaId(name) {
  const base = slug(name) || "audience";
  return PRESET_IDS.has(base) ? `${base}-custom` : base;
}

/** Keep only well-formed situation-bank entries: [{ domain, situations: [{ t, s }] }], spice s in 0..2. Pure. */
function normalizeBank(raw) {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? (raw.situation_bank || raw.domains || Object.values(raw).find(Array.isArray)) : null;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const d of list) {
    if (!d || typeof d !== "object") continue;
    const domain = typeof d.domain === "string" ? d.domain.trim().slice(0, 80) : "";
    const situations = (Array.isArray(d.situations) ? d.situations : [])
      .map((x) => (typeof x === "string" ? { t: x, s: 0 } : x && typeof x === "object" ? { t: x.t || x.text || x.situation, s: Number(x.s ?? x.spice ?? 0) } : null))
      .filter((x) => x && typeof x.t === "string" && x.t.trim())
      .map((x) => ({ t: x.t.trim().slice(0, 200), s: [0, 1, 2].includes(x.s) ? x.s : 0 }));
    if (domain && situations.length) out.push({ domain, situations: situations.slice(0, 20) });
  }
  return out.slice(0, 40);
}

/**
 * The situation bank: many small, specific, recurring moments from this audience's life, grouped by area of life.
 * The caption writer is handed three of these per clip (pickSeeds), which is what keeps a run from circling the same five jokes.
 * Built-in audiences ship with one; this builds one for a custom audience. Returns [] when the model's answer is unusable.
 */
async function buildSituationBank(persona, { chat = chatJSON } = {}) {
  const about = [persona.summary, persona.daily_life, Array.isArray(persona.pain_points) ? persona.pain_points.slice(0, 12).join("; ") : "", Array.isArray(persona.vocabulary) ? `terms: ${persona.vocabulary.slice(0, 20).join(", ")}` : ""].filter(Boolean).join("\n");
  const out = await chat({
    maxTokens: 12000,
    system: "You are a comedy writer who is a member of this audience. You know the tiny, specific, recurring moments of their lives that make them say \"that's literally me\".",
    messages: [{
      role: "user",
      content:
        `Audience: ${persona.name}\n${about}\n\n` +
        "Write this audience's SITUATION BANK: 16 to 20 different areas of their life (work, money, family, the people they deal with, their tools and gear, " +
        "their downtime, their body, their running feuds...), each with 8 to 10 situations.\n" +
        "A situation is one specific, recurring moment in under 20 words, written as they'd say it, with one concrete insider detail (a number, a name, a term, a time, a place). " +
        "It must happen to most of them, often. It is a setup, not a joke: no punchline. Most are clean; mark crude ones s=1 and raunchy innuendo s=2 (never explicit). " +
        "Spread across areas: no more than a couple of situations about the same thing.\n" +
        'Reply with ONLY JSON: {"situation_bank": [{"domain": "area of life", "situations": [{"t": "the situation", "s": 0}]}]}',
    }],
  });
  return normalizeBank(out);
}

/** Ask the model to turn rough notes into the full structure. Returns the persona object (not yet saved). */
async function expandPersona({ name, notes }, { chat = chatJSON } = {}) {
  const fields = Object.entries(PERSONA_FIELDS).map(([k, v]) => `  "${k}": ${v}`).join("\n");
  const out = await chat({
    maxTokens: 12000,
    system:
      "You are an expert audience researcher and comedy writer. You build extremely detailed, insider-accurate " +
      "audience personas. Be concrete and specific (real terms, real situations, real numbers) rather than generic. " +
      "Never write anything an actual member of the group would find inaccurate or patronizing.",
    messages: [{
      role: "user",
      content:
        `Audience name: ${name}\n\nNotes from the user (may be rough or partial):\n"""\n${notes}\n"""\n\n` +
        `Expand this into a deep persona. Reply with ONLY a JSON object with exactly these keys:\n{\n${fields}\n}\n` +
        "Array fields must be arrays of strings. Prefer 10+ entries for vocabulary, pain_points and in_jokes.",
    }],
  });
  const persona = { ...out, name };
  // The situation bank is a second, separate answer (one huge answer is far less reliable). Best effort: a run builds it later if this fails.
  try { const bank = await buildSituationBank(persona, { chat }); if (bank.length) persona.situation_bank = bank; }
  catch (e) { console.error("[meme-builder] situation bank failed, a run will build it later:", e && e.message); }
  return persona;
}

/** System prompt fragment describing the audience. */
/**
 * The audience as a system prompt. With `rotate`, the long lists that anchor the writer (pain points, in-jokes, characters, example captions)
 * show a fresh random subset each time, so every batch of captions isn't pulled toward the same few jokes.
 */
function personaToPrompt(p, { rotate = false, rng = Math.random } = {}) {
  const pick = (a, n) => {
    if (!rotate || !Array.isArray(a) || a.length <= n) return a;
    const r = [...a];
    for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; }
    return r.slice(0, n);
  };
  const arr = (a) => (Array.isArray(a) ? a.map((x) => `- ${x}`).join("\n") : String(a == null ? "" : a));
  return [
    `You are an expert-level member of this audience: ${p.name}. You think, talk and joke exactly like them.`,
    `WHO WE ARE\n${p.summary}`,
    `DAILY LIFE\n${p.daily_life}`,
    `OUR VOCABULARY\n${arr(p.vocabulary)}`,
    `WHAT DRIVES US CRAZY\n${arr(pick(p.pain_points, 14))}`,
    `WHAT WE LOVE\n${arr(p.joys)}`,
    `HOT BUTTONS\n${arr(p.hot_buttons)}`,
    `IN-JOKES\n${arr(pick(p.in_jokes, 8))}`,
    `HOW WE'RE FUNNY\n${p.humor_style}`,
    p.reaction_playbook ? `REACTION-MEME PLAYBOOK (which kinds of clips work for which situations, and the caption format)\n${arr(p.reaction_playbook)}` : "",
    `PEOPLE / INSTITUTIONS WE HAVE OPINIONS ABOUT\n${arr(p.authority_figures)}`,
    `NEVER SAY (outsider tells)\n${arr(p.never_say)}`,
    p.recurring_characters ? `PEOPLE WHO SHOW UP IN OUR STORIES\n${arr(pick(p.recurring_characters, 8))}` : "",
    p.caption_formats ? `CAPTION FORMATS (vary them across a batch)\n${arr(p.caption_formats)}` : "",
    p.good_vs_bad ? `GOOD VS BAD\n${arr(p.good_vs_bad)}` : "",
    p.pairing_rules ? `WHEN A CLIP DOES AND DOES NOT FIT\n${arr(p.pairing_rules)}` : "",
    `EXAMPLES OF CAPTIONS IN OUR VOICE (voice and format only; never reuse them)\n${arr(pick(p.example_captions, 8))}`,
  ].filter(Boolean).join("\n\n");
}

/**
 * Prompt section built from rated clips: rows are { caption, transcript, rating }.
 * Latest rating per caption wins; empty string when nothing is rated yet.
 */
function tasteFromRatings(rows, { limit = 15 } = {}) {
  const latest = new Map();
  for (const r of rows || []) latest.set(r.caption, r);
  const all = [...latest.values()];
  const fmt = (r) => `- "${r.caption}"${r.transcript ? `  (clip: "${String(r.transcript).slice(0, 80)}")` : ""}`;
  const loved = all.filter((r) => r.rating > 0).slice(-limit).map(fmt);
  const hated = all.filter((r) => r.rating < 0).slice(-limit).map(fmt);
  if (!loved.length && !hated.length) return "";
  return "\n\nREAL FEEDBACK FROM OUR AUDIENCE\n" +
    (loved.length ? `Captions we LOVED (write more like these: this specificity, this voice):\n${loved.join("\n")}\n` : "") +
    (hated.length ? `Captions we HATED (avoid this kind of thing):\n${hated.join("\n")}\n` : "");
}

module.exports = { SPICE_RULE, spiceRule, overusedRule, normalizeBank, buildSituationBank, pickSeeds, PERSONA_FIELDS, listPresets, getPreset, isPresetId, customPersonaId, expandPersona, personaToPrompt, tasteFromRatings };
