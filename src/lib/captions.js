"use strict";

// Meme Builder step 2: given the persona and the watched moments, write the
// caption for each moment and score it. Direction is moment -> situation (find
// the situation this clip is perfect for), far more reliable than
// situation -> clip search.
//
// Two kinds of moment get two kinds of caption:
//   reaction: the caption is the SITUATION, the clip is the punchline
//             ("When the broker offers 20% under spot rate")
//   bit:      a longer take. The caption is the HOOK, it frames what the take
//             is about or what's at stake, without giving away the payoff.

const { chatJSON, textModels } = require("./ai");
const { personaToPrompt, pickSeeds, SPICE_RULE } = require("./personas");

// Small batches: smaller replies are far more reliable than one huge JSON answer.
const CHUNK = 5;

/** Models occasionally leak stray CJK characters into English text; strip them and tidy spacing. */
function cleanCaption(s) {
  return String(s).replace(/[　-鿿가-힯＀-￯]/g, "").replace(/\s{2,}/g, " ").trim();
}

const seconds = (m) => Math.max(1, Math.round(m.endSec - m.startSec));

function describeMoment(m) {
  return `[${m.id}] ${m.kind === "bit" ? "BIT" : "REACTION"}, about ${seconds(m)}s. says: "${m.transcript}"` +
    (m.context ? ` | context: ${m.context}` : "") +
    ` | FEELING: ${m.emotion}${m.dynamic && m.dynamic !== "other" ? ` (${m.dynamic})` : ""}${m.intensity ? `, intensity ${m.intensity}/10` : ""}` +
    ` | delivery: ${m.delivery} | words: ${m.words === "topic" ? "about their own topic (the caption must not clash with them)" : "neutral, fit any topic"}` +
    ` | works as reaction to: ${m.reaction_use}`;
}

const STYLE_RULES =
  `HOW THESE MEMES WORK: the caption is a situation from OUR lives and the clip is the reaction. The clip is about something else entirely; ` +
  `what has to match is the FEELING and the social dynamic (condescension, a dodge, getting caught, losing patience, quiet defeat...), not the topic.\n` +
  `- Start from the clip's FEELING and dynamic. Ask: what recurring situation in our world produces exactly this feeling?\n` +
  `- Cast the speaker as someone in our world (the broker talking down to us, the dispatcher dodging, us finally snapping). ` +
  `Choose the role the tone really fits: a condescending voice is the broker, an exasperated one is us.\n` +
  `- Be SPECIFIC: one insider detail (a number, a term, a time, a place) makes people say "that's us". Generic captions get nothing.\n` +
  `  Format reference: "When the broker offers 20% under spot rate" + a clip of someone saying "woah woah buddy, you have no idea what you're talking about".\n` +
  `- A BIT caption is a HOOK for a longer take: say what it is about or what's at stake (a question, a "POV:", a confession), ` +
  `without giving away the payoff. The viewer should want to watch to the end.\n` +
  `- The spoken words must not fight the caption. If the words are about their own topic and clash with any situation of ours, mark it unusable, ` +
  `unless the caption can use those very words as a line said in our world.\n` +
  `- Do not force a match. If no situation of ours really produces this feeling, mark it unusable.\n` +
  `- Short: under 100 characters, readable in two seconds. No hashtags, no emojis unless truly natural. Don't explain the joke.\n` +
  `- Never copy the example captions: they show voice and format only. Vary the caption format across the batch (not every caption starts with "When").\n` +
  `- Use our vocabulary naturally; avoid anything on the NEVER SAY list.\n`;

/**
 * Captions all moments CHUNK at a time, then ranks the lot.
 * If one batch fails after its retries, the others still count: a run with most moments captioned is far
 * better than no run. Only when EVERY batch fails does it throw.
 * onChunk(done, total) is called as each batch finishes (a "still alive" signal for the page).
 * stats (optional object) is filled with { batches, failed } so the page can say when part of the video lost its captions.
 * onModel(model) is told which model answered each batch (so the page can say when a backup wrote them).
 */
async function writeCaptions(persona, moments, { taste = "", candidates = 3, onChunk, onModel, chat, stats } = {}) {
  const seedState = {};
  const usedCaptions = [];
  const chunks = [];
  for (let i = 0; i < moments.length; i += CHUNK) chunks.push(moments.slice(i, i + CHUNK));
  const results = [];
  const failed = [];
  let lastErr = null;
  const attempt = async (c, label) => {
    try {
      const got = await writeChunk(persona, c, { taste, candidates, chat, onModel, seedState, used: usedCaptions });
      results.push(...got);
      for (const g of got) if (g.best) usedCaptions.push(g.best);
      return true;
    } catch (err) {
      lastErr = err;
      console.error(`[meme-builder] caption batch ${label} failed:`, err && err.message);
      return false;
    }
  };
  for (const [i, c] of chunks.entries()) {
    if (!(await attempt(c, `${i + 1}/${chunks.length}`))) failed.push(c);
    if (onChunk) { try { await onChunk(i + 1, chunks.length); } catch { /* progress is best effort */ } }
  }
  // A lost batch is a lost slice of the video: try each failed one once more before giving up on it.
  let stillFailed = 0;
  for (const c of failed) { if (!(await attempt(c, "retry"))) stillFailed += 1; }
  if (stats) { stats.batches = chunks.length; stats.failed = stillFailed; }
  if (chunks.length && stillFailed === chunks.length) throw lastErr;
  return results.sort((a, b) => (b.score || 0) - (a.score || 0));
}

async function writeChunk(persona, moments, { taste, candidates, chat = chatJSON, onModel, seedState = {}, used = [] }) {
  if (!moments.length) return [];
  const seeds = pickSeeds(persona, moments.length, { state: seedState });
  const clipLines = moments.map((m, i) => describeMoment(m) + (seeds[i].length ? `\n   BASE YOUR CAPTIONS ON ONE of these situations from our world, adapted so it fits this clip's feeling (switch to one of your own only if none of the three can work at all): ${seeds[i].map((x, k) => `${String.fromCharCode(97 + k)}) ${x}`).join("  ")}` : ""));
  const usedPart = used.length ? `Already used in this video (do NOT reuse the same topic, scene, number or joke structure):\n${used.slice(-40).map((c) => `- ${c}`).join("\n")}\n\n` : "";
  const task =
    `Below are clips from a video. For EACH one, write ${candidates} candidate captions for OUR audience.\n\n` +
    `Rules:\n${STYLE_RULES}` +
    `- ${SPICE_RULE}\n` +
    `- The most overused topics are the 14-hour clock/ELD, blind-side backing, detention and the lowball broker. Skip them unless the clip's feeling demands exactly that and nothing above already used it.\n` +
    `- Then pick the single best caption per clip and score how funny it'd be to our audience 1-10. Score HARSHLY and use the whole range: ` +
    `most clips should land 4-6, 7 means you'd genuinely send it to a friend in the group chat, 9-10 is rare. A mediocre-but-usable pairing is a 5, not a 7.\n\n` +
    usedPart +
    `CLIPS:\n${clipLines.join("\n")}\n\n` +
    `Reply with ONLY a JSON array, one item per clip: ` +
    `{ "id": "m1", "usable": true, "candidates": ["...", "...", "..."], "best": "...", "score": 1-10, "why": "one short sentence: which situation of ours this feeling matches" }`;

  const ask = () => chat({
    models: textModels(),
    system: personaToPrompt(persona, { rotate: true }) + (taste || ""),
    maxTokens: 6000,
    onModel,
    messages: [{ role: "user", content: task }],
  });
  // A reply that parses but yields nothing usable is retried once: it is usually a one-off bad answer.
  let kept = parseCaptionReply(await ask(), moments);
  if (!kept.length) {
    console.error(`[meme-builder] caption batch of ${moments.length} came back with nothing usable, asking once more`);
    kept = parseCaptionReply(await ask(), moments);
  }
  return kept;
}

/**
 * Turn the model's reply into ranked captions, forgivingly: a wrapped array, odd ids ("M1", "[m1]"),
 * a missing "best" (first candidate), and "usable": false (kept, but scored low so it is only used if
 * nothing better exists). Throws only when the reply isn't a list at all.
 */
function parseCaptionReply(out, moments) {
  let list = out;
  if (!Array.isArray(list) && list && typeof list === "object") {
    list = list.clips || list.captions || list.results || list.items || Object.values(list).find(Array.isArray);
  }
  if (!Array.isArray(list)) throw new Error("captions did not return an array");
  const byId = new Map(moments.map((m) => [m.id, m]));
  const result = [];
  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    const id = String(c.id ?? "").replace(/[\[\]\s]/g, "").toLowerCase();
    const moment = byId.get(id);
    if (!moment) continue;
    const text = cleanCaption(c.best || (Array.isArray(c.candidates) && c.candidates.find((x) => typeof x === "string" && x.trim())) || "");
    if (!text) continue;
    const unusable = c.usable === false || c.usable === "false";
    const score = Number(c.score);
    const cands = [text, ...(Array.isArray(c.candidates) ? c.candidates : [])].filter((x) => typeof x === "string").map(cleanCaption).filter(Boolean);
    result.push({ ...c, id, best: text, candidates: [...new Set(cands)].slice(0, 3), score: unusable ? Math.min(Number.isFinite(score) ? score : 3, 3) : (Number.isFinite(score) ? score : 5), moment });
  }
  return result;
}

/**
 * One fresh caption for a clip that already exists (the "New caption" button).
 * `avoid` lists captions already tried so the new one takes a different angle.
 */
async function regenerateCaption(persona, moment, { taste = "", avoid = [], chat = chatJSON, onModel } = {}) {
  const tried = avoid.filter(Boolean).map((c) => `- ${c}`).join("\n");
  const [seeds] = pickSeeds(persona, 1);
  const task =
    `Write ONE new caption for this clip, for OUR audience.\n\nRules:\n${STYLE_RULES}\n- ${SPICE_RULE}\n` +
    `CLIP:\n${describeMoment(moment)}\n` +
    (seeds.length ? `Starting points from our world (ideas only): ${seeds.join("  |  ")}\n` : "") + "\n" +
    (tried ? `Captions already tried (take a clearly DIFFERENT angle, do not reword these):\n${tried}\n\n` : "") +
    `Reply with ONLY JSON: { "caption": "..." }`;
  const out = await chat({
    models: textModels(),
    system: personaToPrompt(persona) + (taste || ""),
    maxTokens: 400,
    onModel,
    messages: [{ role: "user", content: task }],
  });
  const raw = out && (out.caption || out.best || (Array.isArray(out) && out[0] && (out[0].caption || out[0].best)));
  const caption = cleanCaption(raw || "");
  if (!caption) throw new Error("The AI didn't return a caption.");
  return caption.slice(0, 200);
}

/**
 * Quality bar, not a quota: every clip scoring >= minScore, best first, no
 * overlapping clips, capped at maxClips. If nothing clears the bar, return the
 * best few flagged lowConfidence so the admin never gets an empty result.
 */
function selectClips(ranked, { minScore = 1, maxClips = 30, minClips = 5 } = {}) {
  const overlaps = (picked, c) => picked.some((k) => c.moment.startSec < k.moment.endSec && k.moment.startSec < c.moment.endSec);
  const picked = [];
  for (const c of ranked) {
    if ((c.score || 0) < minScore) continue;
    if (!overlaps(picked, c)) picked.push(c);
    if (picked.length >= maxClips) break;
  }
  let lowConfidence = false;
  if (picked.length < minClips) {
    lowConfidence = true;
    for (const c of ranked) {
      if (picked.length >= minClips) break;
      if (!picked.includes(c) && !overlaps(picked, c)) picked.push(c);
    }
  }
  return { picked, lowConfidence };
}

module.exports = { parseCaptionReply, writeCaptions, regenerateCaption, selectClips, cleanCaption, describeMoment, CHUNK };
