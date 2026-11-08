"use strict";

// Meme Builder (Content tab): pure logic + route guards. No network, no real DB.
//
// The end-to-end path (upload -> queue -> KIE -> ffmpeg -> storage -> library)
// needs live KIE and a database, so it is exercised by hand, not here.

const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { after, before, describe, test } = require("node:test");

const { extractJSON, friendlyMessage, KieError } = require("../src/lib/kie");
const { parseTime, normalizeMoments, wantedMoments, planSpans, fallbackSpans, mergeMoments, analyzeVideo, buildPrompt, ANALYSIS_VERSION } = require("../src/lib/analyze");
const { selectClips, cleanCaption } = require("../src/lib/captions");
const { wrapCaption, assText, buildAss } = require("../src/lib/render");
const { parseProbe, isPrivateIp, assertPublicUrl } = require("../src/lib/media");
const personas = require("../src/lib/personas");
const { registerMemeBuilderRoutes, parseOptions, findMoment } = require("../src/routes");
const { startMemeBuilderWorker, withTimeout } = require("../src/worker");
const kie = require("../src/lib/kie");
const mbStore = require("../src/lib/store");
const { encodePreset } = require("../src/lib/render");
const { writeCaptions, parseCaptionReply } = require("../src/lib/captions");
const mbMedia = require("../src/lib/media");
const { renderClip } = require("../src/lib/render");
const cuts = require("../src/lib/cuts");
const refine = require("../src/lib/refine");
const { asyncRoute } = require("../src/async-route");

describe("kie helpers", () => {
  test("extractJSON tolerates fences and surrounding prose", () => {
    assert.deepEqual(extractJSON("```json\n[{\"a\":1}]\n```"), [{ a: 1 }]);
    assert.deepEqual(extractJSON("Sure! Here you go: {\"a\":2} hope that helps"), { a: 2 });
    assert.throws(() => extractJSON("no json here"));
  });
  test("friendlyMessage hides upstream detail from admins", () => {
    assert.match(friendlyMessage(new KieError("gemini-3-6-flash: HTTP 502 upstream request failed")), /busy or unavailable/);
    assert.match(friendlyMessage(new KieError("KIE_API_KEY is not set on this server.")), /isn't configured/);
    assert.match(friendlyMessage(new KieError("upload: no answer after 180s", { retryable: true })), /kieai\.redpandaai\.co/);
    assert.equal(friendlyMessage(new Error("plain")), "plain");
  });
});

describe("analysis", () => {
  test("parseTime handles MM:SS, HH:MM:SS and numbers", () => {
    assert.equal(parseTime("01:30"), 90);
    assert.equal(parseTime("1:01:05"), 3665);
    assert.equal(parseTime(12.5), 12.5);
    assert.throws(() => parseTime("soon"));
  });
  test("normalizeMoments keeps the feeling, dynamic, words and intensity, and tidies bad values", () => {
    const [good, odd] = normalizeMoments([
      { start: "0:10", end: "0:18", kind: "reaction", transcript: "no way", emotion: "disbelief", dynamic: "condescension", words: "neutral", intensity: 9 },
      { start: "1:00", end: "1:10", kind: "reaction", transcript: "x", emotion: "e", dynamic: "made-up", words: "???", intensity: 99 },
    ], 300);
    assert.deepEqual([good.dynamic, good.words, good.intensity], ["condescension", "neutral", 9]);
    assert.deepEqual([odd.dynamic, odd.words, odd.intensity], ["other", "neutral", 10], "unknown dynamic, unknown words, intensity clamped");
    assert.equal(good.v, ANALYSIS_VERSION);
    assert.ok(ANALYSIS_VERSION >= 3, "analyses from before the meme-science prompt are redone");
  });
  test("planSpans: normal videos are one pass; only very long ones are cut, with overlap and no tiny tail", () => {
    assert.deepEqual(planSpans(200), [[0, 200]]);
    assert.deepEqual(planSpans(363), [[0, 363]]);
    assert.deepEqual(planSpans(1500), [[0, 1500]], "25 minutes is still one pass");
    assert.deepEqual(planSpans(1800), [[0, 630], [600, 1230], [1200, 1800]], "each piece reaches 30s into the next");
    assert.deepEqual(planSpans(1850), [[0, 630], [600, 1230], [1200, 1850]], "a 50 second tail is folded into the piece before it");
    assert.deepEqual(planSpans(null), [[0, 0]]);
  });
  test("fallbackSpans: smaller overlapping pieces for a retry, none for a short video", () => {
    assert.equal(fallbackSpans(200), null);
    assert.equal(fallbackSpans(300), null, "a 5 minute video is already short enough");
    assert.deepEqual(fallbackSpans(363), [[0, 260], [240, 363]]);
    assert.deepEqual(fallbackSpans(900).map(([a]) => a), [0, 240, 480, 720]);
    assert.deepEqual(fallbackSpans(900)[3], [720, 900]);
  });
  test("analyzeVideo honours the number of attempts", async () => {
    let calls = 0; const e = console.error; console.error = () => {};
    try { await assert.rejects(() => analyzeVideo([{ url: "u", offsetSec: 0, lengthSec: 100 }], { duration: 100, attempts: 2, chat: async () => { calls++; throw new Error("502"); } }), /502/); }
    finally { console.error = e; }
    assert.equal(calls, 2);
  });
  test("buildPrompt is generous, welcomes short reactions, and never invites making things up", () => {
    const p = buildPrompt(180);
    assert.match(p, /6 to 15 seconds/);
    assert.match(p, /reads the caption for about two seconds/);
    assert.match(p, /Only describe things that really happen/);
    assert.doesNotMatch(p, /fewer is better/i);
    assert.doesNotMatch(p, /ONLY at the part/, "the model is given just the piece, it is not told to look at part of a longer video");
  });
  test("sameQuote catches a repeated line but not two different ones", () => {
    const { sameQuote } = require("../src/lib/analyze");
    assert.equal(sameQuote("I think I'm more nervous than you are right now", "I think that I am... I think I'm more nervous than you are right now"), true);
    assert.equal(sameQuote("Have you ever felt socially awkward over your years", "Those are not my biggest strengths, right? It's like I don't think"), false);
    assert.equal(sameQuote("No way", "No way"), false, "too short to judge");
  });
  test("mergeMoments drops near-duplicates (keeping the stronger), sorts by time and renumbers", () => {
    const m = (id, s, e, strength) => ({ id, startSec: s, endSec: e, strength, kind: "reaction" });
    const out = mergeMoments([[m("m1", 170, 185, 6), m("m2", 100, 110, 9)], [m("m1", 172, 186, 8), m("m2", 300, 310, 7)]]);
    assert.deepEqual(out.map((x) => [x.id, x.startSec, x.strength]), [["m1", 100, 9], ["m2", 172, 8], ["m3", 300, 7]]);
  });
  test("analyzeVideo: each piece is watched separately and offset; a piece that keeps failing costs only itself; all failing throws", async () => {
    const reply = (n) => [{ start: "0:20", end: "0:30", kind: "reaction", transcript: ["alpha bravo charlie delta echo foxtrot", "golf hotel india juliet kilo lima", "mike november oscar papa quebec romeo", "sierra tango uniform victor whiskey xray"][n], emotion: "e", delivery: "d", reaction_use: "r", strength: 7 }];
    const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
    const segs = [0, 180, 360, 540].map((o, i) => ({ url: `http://piece/${i}`, offsetSec: o, lengthSec: 180 }));
    const chat = async ({ messages }) => {
      const url = messages[0].content[1].url;
      if (url.endsWith("/1")) throw new Error("502");        // piece 1 always fails
      return reply(Number(url.slice(-1)));
    };
    const out = await quiet(() => analyzeVideo(segs, { duration: 720, chat }));
    assert.deepEqual(out.map((x) => x.startSec), [20, 380, 560], "pieces 0, 2 and 3 survived, each moved to its place in the whole video");
    assert.ok(out.every((x) => x.v === ANALYSIS_VERSION));
    await quiet(() => assert.rejects(() => analyzeVideo(segs, { duration: 720, chat: async () => { throw new Error("502 all"); } }), /502 all/));
    // a model that loses its place and repeats an earlier line is not allowed to count twice
    const dup = await analyzeVideo(segs.slice(0, 2), { duration: 360, chat: async () => reply(1) });
    assert.equal(dup.length, 1, "the repeated quote is dropped");
  });
  test("wantedMoments scales with length, favours quality, and stays bounded", () => {
    assert.equal(wantedMoments(60), 8);
    assert.equal(wantedMoments(363), 15);
    assert.equal(wantedMoments(720), 29);   // a 12 minute video: about one per 25s
    assert.equal(wantedMoments(36000), 40); // capped, not 1440
    assert.equal(wantedMoments(null), 15);
  });
  test("normalizeMoments drops bad rows and clamps, but no longer throws away longer clips", () => {
    const out = normalizeMoments([
      { start: "00:10", end: "00:16", transcript: "ok", kind: "reaction" },
      { start: "bad", end: "00:20" },
      { start: "00:30", end: "00:30.5" },   // under 1s
      { start: "05:00", end: "05:10" },     // starts past the end
      { start: "00:50", end: "01:30" },     // a 40s bit: kept now (it used to be thrown away)
      { start: "01:35", end: "01:45", kind: "nonsense" },   // clamped to 100s; unknown kind is inferred
    ], 100);
    assert.deepEqual(out.map((m) => [m.startSec, m.endSec]), [[10, 16], [50, 90], [95, 100]]);
    assert.deepEqual(out.map((m) => m.kind), ["reaction", "bit", "reaction"]);
    assert.equal(out[0].id, "m1");
    assert.equal(out[0].context, "");
    // Only an absurd length (over the loose 150s safety cap) is refused.
    const long = normalizeMoments([{ start: "00:05", end: "04:00" }, { start: "00:05", end: "02:00" }], 1000);
    assert.deepEqual(long.map((m) => m.endSec - m.startSec), [115]);
  });
  test("the watch prompt states goals and leaves the length to the agent", () => {
    const p = require("../src/lib/analyze").buildPrompt(720);
    assert.match(p, /you decide each one/);
    assert.match(p, /"reaction"/); assert.match(p, /"bit"/);
    assert.match(p, /about 29 moments or more/, "asks for plenty, scaled to the video length");
    assert.ok(!/must be \d+-\d+ seconds/.test(p), "no rigid length rule");
  });
});

describe("clip selection", () => {
  const mk = (id, score, a, b) => ({ id, score, best: id, moment: { startSec: a, endSec: b } });
  test("keeps everything at or above the bar, best first, no overlaps", () => {
    // b overlaps a (dropped), d scores below the bar.
    const rows = [mk("a", 9, 0, 10), mk("b", 8, 5, 12), mk("c", 7, 20, 25), mk("d", 6, 30, 35)];
    const enough = selectClips(rows, { minScore: 7, maxClips: 30, minClips: 2 });
    assert.deepEqual(enough.picked.map((c) => c.id), ["a", "c"]);
    assert.equal(enough.lowConfidence, false);
    // Same input but we insist on 3: only 2 cleared the bar, so the best remaining non-overlapping one is added and flagged.
    const short = selectClips(rows, { minScore: 7, maxClips: 30, minClips: 3 });
    assert.deepEqual(short.picked.map((c) => c.id), ["a", "c", "d"]);
    assert.equal(short.lowConfidence, true);
  });
  test("flags lowConfidence and returns the best few when nothing clears the bar", () => {
    const { picked, lowConfidence } = selectClips([mk("a", 5, 0, 5), mk("b", 4, 10, 15), mk("c", 3, 20, 25), mk("d", 2, 30, 35)], { minScore: 7, minClips: 3 });
    assert.equal(lowConfidence, true);
    assert.deepEqual(picked.map((c) => c.id), ["a", "b", "c"]);
  });
  test("by default every captioned clip is kept, best first (the score is a label, not a filter)", () => {
    const rows = [["a", 6], ["b", 6], ["c", 5], ["d", 5], ["e", 5], ["f", 4], ["g", 4]].map(([id, sc], i) => mk(id, sc, i * 20, i * 20 + 5));
    const r = selectClips(rows);
    assert.deepEqual(r.picked.map((c) => c.id), ["a", "b", "c", "d", "e", "f", "g"], "nothing is thrown away");
    assert.equal(r.lowConfidence, false);
    assert.equal(selectClips(rows, { minScore: 6 }).picked.length, 5, "a minimum score can still be set; it keeps at least the best five");
  });
  test("respects maxClips and does not flag when enough clear the bar", () => {
    const rows = ["a", "b", "c", "d", "e"].map((id, i) => mk(id, 9, i * 20, i * 20 + 5));
    const { picked, lowConfidence } = selectClips(rows, { minScore: 7, maxClips: 4, minClips: 3 });
    assert.equal(picked.length, 4);
    assert.equal(lowConfidence, false);
  });
  test("cleanCaption strips stray CJK characters and tidies spacing", () => {
    assert.equal(cleanCaption("Watching three drivers grab popcorn to watch收 blindside"), "Watching three drivers grab popcorn to watch blindside");
    assert.equal(cleanCaption("  a   b  "), "a b");
  });
});

describe("rendering helpers", () => {
  test("wrapCaption wraps at word boundaries", () => {
    const out = wrapCaption("When the broker offers twenty percent under spot rate", 24);
    assert.ok(out.split("\n").every((l) => l.length <= 24));
    assert.equal(out.replace(/\n/g, " "), "When the broker offers twenty percent under spot rate");
  });
  test("assText neutralises override blocks and backslashes and uses \\N for newlines", () => {
    const t = assText("Me {\\an9} when the \\N broker calls about a really long caption that wraps");
    assert.ok(!/[{}]/.test(t));
    assert.ok(!/\\an9/.test(t));
    assert.ok(t.includes("\\N"));
  });
  test("buildAss produces a styled one-event subtitle file for the clip length", () => {
    const ass = buildAss("Hello world", 7.2);
    assert.match(ass, /PlayResX: 1080/);
    assert.match(ass, /Style: Cap,Liberation Sans,64/);
    assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:08\.00,Cap,,0,0,0,,Hello world/);
  });
});

describe("media helpers", () => {
  test("parseProbe reads duration, size and audio from the ffmpeg banner", () => {
    const banner = `Input #0, mov,mp4, from 'v.mp4':
  Duration: 00:06:03.44, start: 0.000000, bitrate: 979 kb/s
  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1920x1080 [SAR 1:1 DAR 16:9], 25 fps
  Stream #0:1[0x2](und): Audio: opus, 48000 Hz, stereo`;
    assert.deepEqual(parseProbe(banner), { duration: 363.44, width: 1920, height: 1080, hasAudio: true, hasVideo: true });
    assert.equal(parseProbe("garbage").hasVideo, false);
  });
  test("isPrivateIp blocks loopback, RFC1918, link-local and IPv6 local ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fd00::1", "fe80::1"]) {
      assert.equal(isPrivateIp(ip), true, ip);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1"]) assert.equal(isPrivateIp(ip), false, ip);
  });
  test("assertPublicUrl rejects non-http schemes, private addresses and junk", async () => {
    await assert.rejects(() => assertPublicUrl("ftp://8.8.8.8/a.mp4"), /http/);
    await assert.rejects(() => assertPublicUrl("http://127.0.0.1/a.mp4"), /private/);
    await assert.rejects(() => assertPublicUrl("http://169.254.169.254/latest/meta-data"), /private/);
    await assert.rejects(() => assertPublicUrl("not a url"), /valid URL/);
    const u = await assertPublicUrl("https://8.8.8.8/a.mp4");
    assert.equal(u.hostname, "8.8.8.8");
  });
});

const bank = [
  { domain: "Dock", situations: [{ t: "dock clean 1", s: 0 }, { t: "dock crude 1", s: 1 }, { t: "dock raunchy 1", s: 2 }] },
  { domain: "Food", situations: [{ t: "food clean 1", s: 0 }, { t: "food crude 1", s: 1 }] },
  { domain: "Road", situations: [{ t: "road clean 1", s: 0 }] },
  { domain: "Home", situations: [{ t: "home raunchy only", s: 2 }] },
];

describe("personas", () => {
  test("built-in presets are complete and carry a reaction playbook", () => {
    const list = personas.listPresets();
    assert.deepEqual(list.map((p) => p.id), ["truckers"], "owner-operators was merged into truckers");
    for (const p of list) {
      assert.equal(p.preset, true);
      assert.ok(typeof p.name === "string" && p.name.trim().length > 0, `${p.id}.name`);
      for (const k of ["summary", "daily_life", "humor_style"]) assert.ok(typeof p[k] === "string" && p[k].length > 40, `${p.id}.${k}`);
      for (const k of ["vocabulary", "pain_points", "joys", "in_jokes", "never_say", "example_captions", "reaction_playbook"]) assert.ok(Array.isArray(p[k]) && p[k].length >= 5, `${p.id}.${k}`);
    }
  });
  test("the old owner-operators id still resolves, to the merged truckers audience", () => {
    assert.equal(personas.getPreset("owner-operators").id, "truckers");
    assert.equal(personas.isPresetId("owner-operators"), true, "and cannot be shadowed by a custom audience");
    const t = personas.getPreset("truckers");
    assert.match(t.summary, /own the truck/); assert.match(t.summary, /company/);
    assert.ok(t.vocabulary.some((v) => /cost per mile/i.test(v)) && t.vocabulary.some((v) => /detention/i.test(v)), "both vocabularies are in");
  });
  test("pickSeeds: nothing without a bank; mostly clean with crude and raunchy sprinkled in", () => {
    assert.deepEqual(personas.pickSeeds({}, 2), [[], []]);
    const big = { situation_bank: Array.from({ length: 10 }, (_, d) => ({ domain: `D${d}`, situations: [
      ...Array.from({ length: 6 }, (_, i) => ({ t: `clean ${d}-${i}`, s: 0 })), ...Array.from({ length: 3 }, (_, i) => ({ t: `crude ${d}-${i}`, s: 1 })), ...Array.from({ length: 2 }, (_, i) => ({ t: `raunchy ${d}-${i}`, s: 2 })),
    ] })) };
    const drawn = personas.pickSeeds(big, 400, { perClip: 3 }).flat();
    const share = (re) => drawn.filter((t) => re.test(t)).length / drawn.length;
    assert.ok(share(/^clean/) > 0.5, `mostly clean (${share(/^clean/).toFixed(2)})`);
    assert.ok(share(/^crude/) > 0.1 && share(/^crude/) < 0.4, `some crude (${share(/^crude/).toFixed(2)})`);
    assert.ok(share(/^raunchy/) > 0.02 && share(/^raunchy/) < 0.2, `a few raunchy (${share(/^raunchy/).toFixed(2)})`);
  });
  test("personaToPrompt can rotate the anchoring lists so batches are not all pulled toward the same jokes", () => {
    const p = { ...personas.getPreset("truckers") };
    const full = personas.personaToPrompt(p);
    assert.ok(p.example_captions.length > 8 && p.in_jokes.length > 8);
    for (const ex of p.example_captions) assert.ok(full.includes(ex), "by default every example is shown");
    const shown = (prompt) => prompt.split("EXAMPLES OF CAPTIONS IN OUR VOICE")[1].split("\n").filter((l) => l.startsWith("- ")).length;
    const a = personas.personaToPrompt(p, { rotate: true, rng: () => 0.1 });
    const b = personas.personaToPrompt(p, { rotate: true, rng: () => 0.9 });
    assert.equal(shown(a), 8); assert.equal(shown(b), 8);
    assert.notEqual(a, b, "a different draw shows different examples");
    assert.match(a, /NEVER SAY/, "the rules are never rotated away");
  });
  test("pickSeeds rotates through the areas of life across batches instead of repeating one", () => {
    const state = {};
    const domainOf = (t) => t.split(" ")[0];
    const first = personas.pickSeeds({ situation_bank: bank }, 1, { state, perClip: 3 })[0].map(domainOf);
    const second = personas.pickSeeds({ situation_bank: bank }, 1, { state, perClip: 3 })[0].map(domainOf);
    assert.equal(new Set(first).size, 3, "three different areas for one clip");
    assert.notDeepEqual(first.slice().sort(), second.slice().sort(), "the next clip starts from different areas");
  });
  test("presets carry formats, good-vs-bad, characters and pairing rules, and the prompt includes them", () => {
    for (const p of personas.listPresets()) {
      for (const k of ["caption_formats", "good_vs_bad", "recurring_characters", "pairing_rules"]) assert.ok(Array.isArray(p[k]) && p[k].length >= 5, `${p.id}.${k}`);
      const prompt = personas.personaToPrompt(p);
      for (const h of ["CAPTION FORMATS", "GOOD VS BAD", "PEOPLE WHO SHOW UP", "WHEN A CLIP DOES AND DOES NOT FIT"]) assert.match(prompt, new RegExp(h), `${p.id} prompt has ${h}`);
    }
    for (const k of ["caption_formats", "good_vs_bad", "recurring_characters", "pairing_rules"]) assert.ok(personas.PERSONA_FIELDS[k], `custom audiences are asked for ${k}`);
    // a custom audience saved before these fields existed still produces a valid prompt
    const old = personas.personaToPrompt({ name: "X", summary: "s", daily_life: "d", vocabulary: [], pain_points: [], joys: [], hot_buttons: [], in_jokes: [], humor_style: "h", authority_figures: [], never_say: [], example_captions: [] });
    assert.doesNotMatch(old, /CAPTION FORMATS|GOOD VS BAD/);
  });
  test("personaToPrompt includes the playbook and the outsider-tells list", () => {
    const prompt = personas.personaToPrompt(personas.getPreset("truckers"));
    assert.match(prompt, /REACTION-MEME PLAYBOOK/);
    assert.match(prompt, /NEVER SAY/);
    assert.match(prompt, /detention/i);
  });
  test("custom ids never collide with a built-in", () => {
    assert.equal(personas.customPersonaId("Night-shift nurses!"), "night-shift-nurses");
    assert.equal(personas.customPersonaId("Truckers"), "truckers-custom");
    assert.equal(personas.customPersonaId("???"), "audience");
    assert.equal(personas.isPresetId("truckers"), true);
    assert.equal(personas.isPresetId("night-shift-nurses"), false);
  });
  test("tasteFromRatings: latest rating per caption wins; empty when nothing rated", () => {
    assert.equal(personas.tasteFromRatings([]), "");
    const out = personas.tasteFromRatings([
      { caption: "A", transcript: "t1", rating: 1 },
      { caption: "A", transcript: "t1", rating: -1 },
      { caption: "B", transcript: "", rating: 1 },
    ]);
    assert.match(out, /LOVED[\s\S]*"B"/);
    assert.match(out, /HATED[\s\S]*"A"/);
    assert.ok(!/LOVED[^]*"A"[^]*HATED/.test(out), "A was re-rated, so it must not appear as loved");
  });
});

describe("storage backend selection", () => {
  const storage = require("../src/lib/storage");
  const KEYS = ["MEME_BUILDER_STORAGE_BACKEND", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
  const saved = {};
  const set = (o) => { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, o); };
  before(() => { for (const k of KEYS) saved[k] = process.env[k]; });
  after(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const CREDS = { R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "b", R2_SECRET_ACCESS_KEY: "c" };

  test("nothing configured -> local", () => { set({}); assert.equal(storage.backendName(), "local"); });
  test("R2 credentials present and no explicit setting -> r2 automatically", () => { set(CREDS); assert.equal(storage.backendName(), "r2"); });
  test("partial credentials do not switch it to r2", () => { set({ R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "b" }); assert.equal(storage.backendName(), "local"); });
  test("an explicit MEME_BUILDER_STORAGE_BACKEND wins over the automatic choice", () => {
    set({ ...CREDS, MEME_BUILDER_STORAGE_BACKEND: "local" }); assert.equal(storage.backendName(), "local");
    set({ MEME_BUILDER_STORAGE_BACKEND: "r2" }); assert.equal(storage.backendName(), "r2");
  });
  test("junk values fall back to the automatic choice", () => {
    set({ ...CREDS, MEME_BUILDER_STORAGE_BACKEND: "s3" }); assert.equal(storage.backendName(), "r2");
    set({ MEME_BUILDER_STORAGE_BACKEND: "s3" }); assert.equal(storage.backendName(), "local");
  });
});

describe("missing stored video", () => {
  const storage = require("../src/lib/storage");
  test("isNotFound recognises a wiped local file and a missing R2 object", () => {
    assert.equal(storage.isNotFound(Object.assign(new Error("x"), { code: "ENOENT" })), true);
    assert.equal(storage.isNotFound(Object.assign(new Error("x"), { name: "NotFound" })), true);
    assert.equal(storage.isNotFound(Object.assign(new Error("x"), { name: "NoSuchKey" })), true);
    assert.equal(storage.isNotFound(Object.assign(new Error("x"), { $metadata: { httpStatusCode: 404 } })), true);
    assert.equal(storage.isNotFound(new Error("boom")), false);
    assert.equal(storage.isNotFound(null), false);
  });
  test("reading a file that is gone raises ENOENT, which the pipeline turns into a plain message", async () => {
    const err = await storage.downloadToFile("file:///nonexistent/dir/source.mp4", require("node:os").tmpdir() + "/mb-x.mp4").catch((e) => e);
    assert.equal(storage.isNotFound(err), true);
    assert.match(storage.SOURCE_GONE, /Upload the video again/);
    assert.ok(!/ENOENT|\/opt\/render/.test(storage.SOURCE_GONE), "the message must not leak paths or error codes");
  });
});

describe("a stalled step cannot hang a run", () => {
  test("uploadFile gives up on a server that accepts the connection and never answers, and retries", async () => {
    let connections = 0;
    const hung = http.createServer(() => { connections++; /* never respond */ });
    await new Promise((r) => hung.listen(0, r));
    const saved = { base: process.env.KIE_UPLOAD_BASE, key: process.env.KIE_API_KEY };
    process.env.KIE_UPLOAD_BASE = `http://127.0.0.1:${hung.address().port}`; process.env.KIE_API_KEY = "k";
    const tmp = require("node:path").join(require("node:os").tmpdir(), `mb-hang-${process.pid}.bin`);
    require("node:fs").writeFileSync(tmp, "x");
    const t0 = Date.now();
    try {
      await assert.rejects(() => kie.uploadFile(tmp, { timeoutMs: 250, attempts: 2 }), (e) => e instanceof kie.KieError && /no answer after/.test(e.message));
      assert.equal(connections, 2, "it retried once after the stall");
      assert.ok(Date.now() - t0 < 5000, "and it did not hang");
    } finally {
      if (saved.base === undefined) delete process.env.KIE_UPLOAD_BASE; else process.env.KIE_UPLOAD_BASE = saved.base;
      if (saved.key === undefined) delete process.env.KIE_API_KEY; else process.env.KIE_API_KEY = saved.key;
      require("node:fs").rmSync(tmp, { force: true }); hung.closeAllConnections && hung.closeAllConnections(); await new Promise((r) => hung.close(r));
    }
  });
  test("a missing key is not retried", async () => {
    const saved = process.env.KIE_API_KEY; delete process.env.KIE_API_KEY;
    const tmp = require("node:path").join(require("node:os").tmpdir(), `mb-nokey-${process.pid}.bin`); require("node:fs").writeFileSync(tmp, "x");
    const t0 = Date.now();
    try { await assert.rejects(() => kie.uploadFile(tmp, { attempts: 3 }), /KIE_API_KEY is not set/); assert.ok(Date.now() - t0 < 1000, "no backoff sleeps"); }
    finally { if (saved !== undefined) process.env.KIE_API_KEY = saved; require("node:fs").rmSync(tmp, { force: true }); }
  });
  test("withTimeout rejects a promise that never settles and passes through one that does", async () => {
    await assert.rejects(() => withTimeout(new Promise(() => {}), 50), /took too long/);
    assert.equal(await withTimeout(Promise.resolve(7), 1000), 7);
    await assert.rejects(() => withTimeout(Promise.reject(new Error("boom")), 1000), /boom/);
  });
});

describe("clips are saved one at a time", () => {
  test("addClip inserts a single row with the clip's fields and returns its id", async () => {
    const calls = [];
    const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: "new-id" }] }; } };
    const id = await mbStore.addClip(pool, "job-1", "truckers", 3, { caption: "When…", score: 8, why: "w", transcript: "t", emotion: "e", startSec: 10, endSec: 15, storageUri: "r2://b/k" }, "user-1");
    assert.equal(id, "new-id");
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /insert into public\.meme_builder_clips/i);
    assert.deepEqual(calls[0].params, ["job-1", "truckers", 3, "When…", 8, "w", "t", "e", 10, 15, "r2://b/k", "user-1"]);
  });
  test("clearClips deletes the job's rows and hands back their files to remove", async () => {
    const calls = [];
    const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ storage_uri: "r2://b/1" }, { storage_uri: "r2://b/2" }] }; } };
    const uris = await mbStore.clearClips(pool, "job-1");
    assert.deepEqual(uris, ["r2://b/1", "r2://b/2"]);
    assert.match(calls[0].sql, /delete from public\.meme_builder_clips where job_id = \$1/i);
  });
});

describe("hardening: one failure must not sink a run", () => {
  const persona = require("../src/lib/personas").getPreset("truckers");
  const moments = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}`, transcript: "t", emotion: "e", delivery: "d", reaction_use: "r", startSec: i * 10, endSec: i * 10 + 5 }));
  // A fake AI: answers every moment id found in the prompt, except on the calls listed in failOn.
  const fakeChat = (failOn = []) => { let call = 0; return async ({ messages }) => {
    call++; if (failOn.includes(call)) throw new kie.KieError("gemini-3-6-flash: HTTP 502 upstream request failed", { retryable: true });
    return [...messages[0].content.matchAll(/\[(m\d+)\]/g)].map((m) => ({ id: m[1], usable: true, best: `caption ${m[1]}`, score: 7, candidates: [] }));
  }; };
  const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

  test("captions: a batch that fails twice is skipped and the others still count", async () => {
    const seen = [];
    // 20 moments = 4 batches of 5. Call 2 (batch 2) fails, and so does its retry (call 5).
    const out = await quiet(() => writeCaptions(persona, moments(20), { chat: fakeChat([2, 5]), onChunk: (d, t) => seen.push([d, t]) }));
    assert.equal(out.length, 15, "batches 1, 3 and 4 survived; batch 2 was lost");
    assert.deepEqual(seen, [[1, 4], [2, 4], [3, 4], [4, 4]], "progress is reported after every batch, failed or not");
  });
  test("captions: a batch that fails once is retried and nothing is lost", async () => {
    const out = await quiet(() => writeCaptions(persona, moments(20), { chat: fakeChat([2]) }));
    assert.equal(out.length, 20);
  });
  test("captions: only when every batch fails does it throw", async () => {
    await quiet(() => assert.rejects(() => writeCaptions(persona, moments(20), { chat: fakeChat([1, 2, 3, 4, 5, 6, 7, 8]) }), /502/));
  });
  test("captions: all batches fine returns everything ranked", async () => {
    const out = await writeCaptions(persona, moments(13), { chat: fakeChat([]) });
    assert.equal(out.length, 13);
  });

  test("captions: the prompt tells the writer about each moment's kind, length and context", async () => {
    let prompt = "", system = "";
    const chat = async ({ messages, system: sys }) => { prompt = messages[0].content; system = sys; return []; };
    await writeCaptions(persona, [
      { id: "m1", kind: "bit", startSec: 10, endSec: 52, transcript: "so I sat there six hours", context: "ranting about detention at a shipper", emotion: "rage", delivery: "building", reaction_use: "waiting forever" },
      { id: "m2", kind: "reaction", startSec: 70, endSec: 74, transcript: "woah woah", context: "", emotion: "disbelief", delivery: "flat", reaction_use: "lowball" },
    ], { chat, taste: "\n\nREAL FEEDBACK" });
    assert.match(prompt, /\[m1\] BIT, about 42s/); assert.match(prompt, /context: ranting about detention/);
    assert.match(prompt, /\[m2\] REACTION, about 4s/);
    assert.match(prompt, /A BIT caption is a HOOK/);
    assert.match(prompt, /Start from the clip's FEELING/); assert.match(prompt, /Cast the speaker as someone in our world/);
    assert.match(prompt, /must not fight the caption/);
    assert.match(system, /REAL FEEDBACK/, "taste feedback still reaches the writer");
  });
  test("captions: the caller learns which model actually answered", async () => {
    const used = new Set();
    const chat = async ({ onModel, messages }) => { onModel("gemini-3-8-flash"); return [...messages[0].content.matchAll(/\[(m\d+)\]/g)].map((m) => ({ id: m[1], usable: true, best: "x", score: 7 })); };
    await writeCaptions(persona, moments(3), { chat, onModel: (m) => used.add(m) });
    assert.deepEqual([...used], ["gemini-3-8-flash"]);
  });
  test("a batch that parses but is empty is asked once more", async () => {
    let calls = 0;
    const chat = async ({ messages }) => {
      calls += 1;
      if (calls === 1) return [{ id: "m1", usable: true }]; // nothing usable
      return [...messages[0].content.matchAll(/\[(m\d+)\]/g)].map((m) => ({ id: m[1], usable: true, best: "ok", score: 7 }));
    };
    const out = await quiet(() => writeCaptions(persona, moments(2), { chat }));
    assert.equal(calls, 2); assert.equal(out.length, 2);
  });

  test("a failed caption batch is retried once and the loss is reported", async () => {
    let n = 0; const stats = {};
    const chat = async ({ messages }) => {
      n += 1;
      if (n === 1) throw new Error("502 upstream");   // first batch fails once, then works on the retry
      return [...messages[0].content.matchAll(/\[(m\d+)\]/g)].map((m) => ({ id: m[1], usable: true, best: "ok", score: 7 }));
    };
    const out = await quiet(() => writeCaptions(persona, moments(10), { chat, stats }));
    assert.equal(out.length, 10); assert.deepEqual(stats, { batches: 2, failed: 0 });
    let k = 0; const stats2 = {};
    const half = async ({ messages }) => { k += 1; if (messages[0].content.includes("[m1]")) throw new Error("502"); return [...messages[0].content.matchAll(/\[(m\d+)\]/g)].map((m) => ({ id: m[1], usable: true, best: "ok", score: 7 })); };
    const part = await quiet(() => writeCaptions(persona, moments(10), { chat: half, stats: stats2 }));
    assert.equal(part.length, 5); assert.deepEqual(stats2, { batches: 2, failed: 1 }, "reported, and the other batch still counts");
  });
  test("when kie's Claude is down, captions fall back to Anthropic directly (if the app has a key)", async () => {
    const realFetch = global.fetch; const hits = [];
    const prevKey = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    kie.resetModelHealth();
    global.fetch = async (url, init) => {
      hits.push(String(url));
      if (String(url).includes("api.kie.ai")) return { status: 500, ok: false, text: async () => "Internal error" };
      assert.equal(init.headers["x-api-key"], "sk-ant-test");
      assert.equal(JSON.parse(init.body).model, "claude-sonnet-5-5", "the direct: prefix is not sent to Anthropic");
      return { status: 200, ok: true, text: async () => JSON.stringify({ content: [{ type: "text", text: "direct answer" }] }) };
    };
    try {
      assert.ok(kie.textModels().includes("direct:claude-sonnet-5-5"));
      const used = [];
      const out = await quiet(() => kie.chat({ models: ["claude-sonnet-5-5", "direct:claude-sonnet-5-5"], messages: [{ role: "user", content: "hi" }], retries: 0, onModel: (m) => used.push(m) }));
      assert.equal(out, "direct answer"); assert.deepEqual(used, ["direct:claude-sonnet-5-5"]);
      assert.ok(hits.some((u) => u.startsWith("https://api.anthropic.com/v1/messages")));
    } finally {
      global.fetch = realFetch; kie.resetModelHealth();
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });
  test("Gemini Pro models use the plain URL, Flash keeps the -openai one, and Pro writes the captions by default", async () => {
    const realFetch = global.fetch; const urls = [];
    const prev = process.env.KIE_API_KEY; process.env.KIE_API_KEY = "k"; kie.resetModelHealth();
    global.fetch = async (url) => { urls.push(String(url)); return { status: 200, ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) }; };
    try {
      for (const m of ["gemini-3.1-pro", "gemini-3-pro", "gemini-3-6-flash"]) await kie.chat({ models: [m], messages: [{ role: "user", content: "x" }], retries: 0 });
      assert.deepEqual(urls, [
        "https://api.kie.ai/gemini-3.1-pro/v1/chat/completions",
        "https://api.kie.ai/gemini-3-pro/v1/chat/completions",
        "https://api.kie.ai/gemini-3-6-flash-openai/v1/chat/completions",
      ]);
      assert.equal(kie.textModels()[0], "gemini-3.1-pro");
      assert.equal(kie.videoModels()[0], "gemini-3-6-flash", "Flash still watches first (fast and reliable)");
      assert.ok(kie.videoModels().includes("gemini-3.1-pro"), "Pro is a fallback for watching");
    } finally { global.fetch = realFetch; kie.resetModelHealth(); if (prev === undefined) delete process.env.KIE_API_KEY; else process.env.KIE_API_KEY = prev; }
  });
  test("gpt models on kie use their own URL and the <escape> wrapper is stripped", async () => {
    const realFetch = global.fetch; let seenUrl = "";
    const prev = process.env.KIE_API_KEY; process.env.KIE_API_KEY = "k"; kie.resetModelHealth();
    global.fetch = async (url) => { seenUrl = String(url); return { status: 200, ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "<escape>{\"ok\":true}</escape>" } }] }) }; };
    try {
      const out = await kie.chatJSON({ models: ["gpt-5-2"], messages: [{ role: "user", content: "x" }], retries: 0 });
      assert.deepEqual(out, { ok: true });
      assert.match(seenUrl, /^https:\/\/api\.kie\.ai\/gpt-5-2\/v1\/chat\/completions$/);
      assert.ok(kie.textModels().includes("gpt-5-2"), "it is in the default caption chain");
    } finally { global.fetch = realFetch; kie.resetModelHealth(); if (prev === undefined) delete process.env.KIE_API_KEY; else process.env.KIE_API_KEY = prev; }
  });
  test("extractJSON salvages the complete items of a reply that was cut off", () => {
    const cut = '[{"id":"m1","best":"one, with a } brace","score":7},{"id":"m2","best":"two","score":6},{"id":"m3","best":"thr';
    const out = kie.extractJSON(cut);
    assert.deepEqual(out.map((x) => x.id), ["m1", "m2"], "the two complete items survive, the cut one is dropped");
    assert.deepEqual(kie.extractJSON('```json\n[{"a":1}]\n```'), [{ a: 1 }], "normal replies are untouched");
    assert.throws(() => kie.extractJSON('[{"id":"m1","best":"thr'), /cut off/, "nothing complete: a clear error, not 'Unexpected end of JSON input'");
    assert.throws(() => kie.extractJSON("sorry, I can't"), /no JSON/);
  });
  test("two unreadable replies in a row become a retryable error, so the run retries itself", async () => {
    const realFetch = global.fetch; const prev = process.env.KIE_API_KEY; process.env.KIE_API_KEY = "k"; kie.resetModelHealth();
    global.fetch = async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '{"a":' } }] }) });
    try {
      await assert.rejects(() => kie.chatJSON({ models: ["gemini-3-6-flash"], messages: [{ role: "user", content: "x" }], retries: 0 }), (e) => e instanceof kie.KieError && e.retryable === true);
    } finally { global.fetch = realFetch; kie.resetModelHealth(); if (prev === undefined) delete process.env.KIE_API_KEY; else process.env.KIE_API_KEY = prev; }
  });
  test("long clips use a faster encode preset", () => {
    assert.equal(encodePreset(10), "veryfast"); assert.equal(encodePreset(40), "superfast"); assert.equal(encodePreset(90), "ultrafast");
  });
  test("captions: the prompt carries starting points, what is already used, and the humor edge", async () => {
    const prompts = [];
    const p = { ...persona, situation_bank: bank };
    const chat = async ({ messages }) => { prompts.push(messages[0].content); return [...messages[0].content.matchAll(/\[(m\d+)\]/g)].map((m) => ({ id: m[1], usable: true, best: `caption for ${m[1]} ${prompts.length}`, score: 7 })); };
    await writeCaptions(p, moments(8), { chat });   // 8 moments = 2 batches of 5 and 3
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /BASE YOUR CAPTIONS ON ONE of these situations from our world/); assert.match(prompts[0], /Most should be clean/); assert.match(prompts[0], /sprinkle that in/);
    assert.doesNotMatch(prompts[0], /Already used in this video/, "nothing used yet in the first batch");
    assert.match(prompts[1], /Already used in this video/); assert.match(prompts[1], /caption for m1 1/, "the first batch's captions are passed on");
    assert.match(prompts[1], /14-hour clock\/ELD/, "the overused topics are named");
    assert.match(prompts[0], /never explicit/, "the hard limits stay");
  });
  test("regenerateCaption asks for a different angle and cleans the answer", async () => {
    let prompt = "";
    const chat = async ({ messages }) => { prompt = messages[0].content; return { caption: "  Dispatch: 'it's a quick one'  收 " }; };
    const out = await require("../src/lib/captions").regenerateCaption(persona, { id: "m1", kind: "reaction", startSec: 1, endSec: 5, transcript: "t", emotion: "e", delivery: "d", reaction_use: "r" }, { chat, avoid: ["Old caption one", "Old caption two"] });
    assert.equal(out, "Dispatch: 'it's a quick one'");
    assert.match(prompt, /clearly DIFFERENT angle/); assert.match(prompt, /Old caption one/);
    await assert.rejects(() => require("../src/lib/captions").regenerateCaption(persona, { id: "m1", startSec: 1, endSec: 5 }, { chat: async () => ({}) }), /didn't return a caption/);
  });

  // --- worker: transient AI failures retry on their own ---
  const quietLog = { log() {}, error() {}, warn() {} };
  const harness = (job, run) => {
    const sql = []; let handed = false;
    const pool = { query: async (q) => {
      sql.push(q);
      if (/skip locked/i.test(q)) { if (handed) return { rows: [] }; handed = true; return { rows: [job] }; }
      if (/set status = 'queued', stage = 'queued', stage_info = null/.test(q)) return { rows: [{ id: job.id }] };
      return { rows: [], rowCount: 0 };
    } };
    return { pool, sql, worker: startMemeBuilderWorker(pool, { log: quietLog, run, retryPauseMs: 5 }) };
  };
  const transient = () => new kie.KieError("upload: no answer after 180s", { retryable: true });

  test("worker: a transient AI failure puts the run back in the queue instead of failing it", async () => {
    const { sql, worker } = harness({ id: "j1", attempts: 1 }, async () => { throw transient(); });
    await worker.tick(); worker.stop();
    assert.ok(sql.some((q) => /set status = 'queued', stage = 'queued'/.test(q)), "requeued");
    assert.ok(!sql.some((q) => /status = 'error'/.test(q) && /finished_at/.test(q) && /error = \$2/.test(q)), "not failed");
  });
  test("worker: after the allowed attempts a transient failure fails the run with a plain message", async () => {
    const { sql, worker } = harness({ id: "j2", attempts: 3 }, async () => { throw transient(); });
    await worker.tick(); worker.stop();
    assert.ok(sql.some((q) => /error = \$2/.test(q)), "failed after the last attempt");
    assert.ok(!sql.some((q) => /set status = 'queued', stage = 'queued'/.test(q)), "not requeued again");
  });
  test("worker: a non-transient failure (not the AI being flaky) fails immediately", async () => {
    const { sql, worker } = harness({ id: "j3", attempts: 1 }, async () => { throw new Error("The uploaded video is no longer stored on the server."); });
    await worker.tick(); worker.stop();
    assert.ok(sql.some((q) => /error = \$2/.test(q)), "failed");
    assert.ok(!sql.some((q) => /set status = 'queued', stage = 'queued'/.test(q)), "not requeued");
  });
  test("worker: a run that succeeds is not touched", async () => {
    const { sql, worker } = harness({ id: "j4", attempts: 1 }, async () => {});
    await worker.tick(); worker.stop();
    assert.ok(!sql.some((q) => /error = \$2/.test(q) || /set status = 'queued', stage = 'queued'/.test(q)));
  });

  // --- the real renderer, real ffmpeg: the cheaper filter still produces a proper vertical clip ---
  test("renderClip produces a 1080x1920 vertical clip with audio from a landscape source", async (t) => {
    const os = require("node:os"), fs = require("node:fs"), path = require("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-render-"));
    try {
      const src = path.join(dir, "src.mp4");
      try {
        await mbMedia.runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=25:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-c:a", "aac", "-shortest", src]);
      } catch { return t.skip("no usable ffmpeg here"); }
      const out = path.join(dir, "clip.mp4");
      await renderClip({ source: src, startSec: 0.5, endSec: 2.5, caption: "When the dock says fifteen minutes and it is hour six", out });
      const info = await mbMedia.probe(out);
      assert.equal(info.width, 1080); assert.equal(info.height, 1920);
      assert.ok(info.hasAudio, "audio kept");
      assert.ok(info.duration > 2 && info.duration < 3.5, `about 2.5s, got ${info.duration}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("cuts land between words, not in the middle of them", () => {
  test("parseSilences reads ffmpeg's silencedetect output, including a pause that runs to the end", () => {
    const txt = "[silencedetect @ 0x1] silence_start: 1.002\n[silencedetect @ 0x1] silence_end: 1.604 | silence_duration: 0.602\n[silencedetect @ 0x1] silence_start: 3.1\n[silencedetect @ 0x1] silence_end: 3.8 | silence_duration: 0.7\n[silencedetect @ 0x1] silence_start: 9.9";
    assert.deepEqual(cuts.parseSilences(txt), [{ start: 1.002, end: 1.604 }, { start: 3.1, end: 3.8 }, { start: 9.9, end: Infinity }]);
    assert.deepEqual(cuts.parseSilences(""), []);
  });
  const SIL = [{ start: 9.5, end: 10.2 }, { start: 19.0, end: 19.6 }, { start: 30, end: 30.5 }];
  test("snapBounds starts when the pause before the line ends and ends when the next pause begins", () => {
    // The AI said 10.4-18.2: its start is a little after the speech really began, its end a little before the line finished.
    assert.deepEqual(cuts.snapBounds({ startSec: 10.4, endSec: 18.2 }, SIL, 600), { startSec: 10.05, endSec: 19.3 });
  });
  test("a punchline that runs past the AI's end is kept (up to 4s of look-ahead)", () => {
    assert.equal(cuts.snapBounds({ startSec: 10.4, endSec: 16.0 }, SIL, 600).endSec, 19.3);
    // beyond 4s ahead we do not stretch the clip, we just add room
    assert.equal(cuts.snapBounds({ startSec: 10.4, endSec: 14.0 }, SIL, 600).endSec, 15);
  });
  test("it never trims the setup: a pause that ends well after the AI's start is ignored", () => {
    const r = cuts.snapBounds({ startSec: 8.0, endSec: 12.0 }, [{ start: 8.6, end: 9.4 }], 600);
    assert.equal(r.startSec, 7.5, "no usable pause behind the start, so a little extra lead-in instead");
  });
  test("with no pauses (or no audio) it adds a little room on both sides", () => {
    assert.deepEqual(cuts.snapBounds({ startSec: 50, endSec: 58 }, [], 600), { startSec: 49.5, endSec: 59 });
  });
  test("it stays inside the video", () => {
    assert.deepEqual(cuts.snapBounds({ startSec: 0.2, endSec: 5 }, [], 5.5), { startSec: 0, endSec: 5.5 });
  });
  test("mapLimit keeps order and never runs more than `limit` at once", async () => {
    let live = 0, peak = 0;
    const out = await cuts.mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 10 * (8 - n))); live--; return n * 2; });
    assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
    assert.ok(peak <= 3 && peak >= 2, `peak ${peak}`);
  });
  test("dropOverlaps keeps the better clip of two that overlap", () => {
    const c = (id, score, a, b) => ({ id, score, moment: { startSec: a, endSec: b } });
    assert.deepEqual(cuts.dropOverlaps([c("a", 7, 0, 10), c("b", 9, 8, 20), c("c", 8, 30, 40)]).map((x) => x.id), ["b", "c"]);
  });
  test("the real pause detector finds the gaps in a synthetic recording", async (t) => {
    const os = require("node:os"), fs = require("node:fs"), path = require("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-sil-"));
    try {
      const f = path.join(dir, "a.wav");
      try {
        // a tone with two silent gaps: 1.0-1.6s and 3.1-3.8s
        await mbMedia.runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-af", "volume='if(between(t,1.0,1.6)+between(t,3.1,3.8),0,1)':eval=frame", f]);
      } catch { return t.skip("no usable ffmpeg here"); }
      const sil = await mbMedia.detectSilences(f);
      assert.equal(sil.length, 2, JSON.stringify(sil));
      assert.ok(Math.abs(sil[0].start - 1.0) < 0.15 && Math.abs(sil[0].end - 1.6) < 0.15, JSON.stringify(sil[0]));
      assert.ok(Math.abs(sil[1].start - 3.1) < 0.15 && Math.abs(sil[1].end - 3.8) < 0.15, JSON.stringify(sil[1]));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("verification: each clip is checked against an excerpt", () => {
  const mk = (id, a, b, over = {}) => ({ id, score: 8, best: `caption ${id}`, moment: { id, startSec: a, endSec: b, transcript: `line ${id}`, kind: "reaction", context: "ctx", ...over } });
  const noExcerpt = async () => {};
  const base = { sourceFile: "x", workDir: require("node:os").tmpdir(), duration: 600, makeExcerpt: noExcerpt, upload: async () => "https://f/x.mp4" };
  const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

  test("the verify prompt shows the candidate captions and asks which one the clip delivers", () => {
    const m = { transcript: "no way", kind: "reaction", context: "" };
    const p = refine.buildVerifyPrompt(m, 30, ["When the broker lowballs", "Me at hour 6", "POV: detention"]);
    assert.match(p, /A\. When the broker lowballs/); assert.match(p, /C\. POV: detention/);
    assert.match(p, /"pick"/); assert.match(p, /FEELING/);
    assert.doesNotMatch(refine.buildVerifyPrompt(m, 30, []), /"pick"/, "with no captions it only checks the cut");
  });
  test("parseVerdict reads the pick and the fit", () => {
    assert.deepEqual(refine.parseVerdict({ found: true, start: 2, end: 9, pick: "B", fit: 8 }, 30), { found: true, startSec: 2, endSec: 9, pick: 1, fit: 8 });
    assert.equal(refine.parseVerdict({ found: true, start: 2, end: 9, pick: "none", fit: 2 }, 30).pick, -1);
    assert.equal(refine.parseVerdict({ found: true, start: 2, end: 9, pick: "Z", fit: 99 }, 30).fit, 10, "clamped");
    assert.equal(refine.parseVerdict({ found: true, start: 2, end: 9, pick: "Z" }, 30).pick, undefined, "an unknown letter is ignored");
  });
  test("the clip-watching check picks the best caption, takes its fit as the score, and drops clips no caption fits", async () => {
    const clips = [
      { score: 5, best: "w1", candidates: ["w1", "w2", "w3"], moment: { id: "m1", startSec: 100, endSec: 110, transcript: "t1", kind: "reaction" } },
      { score: 9, best: "x1", candidates: ["x1", "x2", "x3"], moment: { id: "m2", startSec: 200, endSec: 206, transcript: "t2", kind: "reaction" } },
      { score: 7, best: "y1", candidates: ["y1", "y2", "y3"], moment: { id: "m3", startSec: 300, endSec: 306, transcript: "t3", kind: "reaction" } },
    ];
    const answers = { t1: { found: true, start: 8, end: 18, pick: "C", fit: 9 }, t2: { found: true, start: 8, end: 14, pick: "none", fit: 2 }, t3: { found: true, start: 8, end: 14, pick: "A", fit: 3 } };
    const out = await refine.refineMoments(clips, { ...base, chat: async ({ messages }) => answers[/what is said: "(t\d)"/.exec(messages[0].content[0].text)[1]] });
    assert.deepEqual(out.clips.map((c) => [c.best, c.score]), [["w3", 9]], "w3 was chosen and its fit replaced the writer's score");
    assert.equal(out.nofit, 2, "m2 (none) and m3 (fit 3) do not land");
  });
  test("parseVerdict accepts a sane answer, rejects nonsense, and clamps to the excerpt", () => {
    assert.deepEqual(refine.parseVerdict({ found: true, start: 4.5, end: 13 }, 30), { found: true, startSec: 4.5, endSec: 13 });
    assert.deepEqual(refine.parseVerdict({ found: true, start: "00:04", end: "00:13" }, 30), { found: true, startSec: 4, endSec: 13 });
    assert.deepEqual(refine.parseVerdict({ found: true, start: -3, end: 99 }, 30), { found: true, startSec: 0, endSec: 30 });
    assert.deepEqual(refine.parseVerdict({ found: false }, 30), { found: false });
    assert.equal(refine.parseVerdict({ found: true, start: 10, end: 10.4 }, 30), null, "under a second");
    assert.equal(refine.parseVerdict({ found: true, start: "soon", end: 5 }, 30), null);
    assert.equal(refine.parseVerdict("yes", 30), null);
    assert.equal(refine.parseVerdict(null, 30), null);
  });
  test("a found clip gets the model's exact times, offset back into the full video", async () => {
    // moment at 100-110: the excerpt starts at 92 (8s before). The model says 7.2 to 19.5 within the excerpt.
    const out = await refine.refineMoments([mk("a", 100, 110)], { ...base, chat: async () => ({ found: true, start: 7.2, end: 19.5 }) });
    assert.equal(out.clips.length, 1);
    assert.ok(Math.abs(out.clips[0].moment.startSec - 99.2) < 1e-9 && Math.abs(out.clips[0].moment.endSec - 111.5) < 1e-9);
    assert.equal(out.dropped, 0); assert.equal(out.unverified, 0);
  });
  test("a clip whose quoted line is not in the excerpt is dropped (the 'completely wack' match)", async () => {
    const answers = { "line a": { found: false }, "line b": { found: true, start: 8, end: 14 } };
    const chat = async ({ messages }) => answers[/what is said: "(line \w)"/.exec(messages[0].content[0].text)[1]];
    const out = await refine.refineMoments([mk("a", 100, 110), mk("b", 200, 206)], { ...base, chat });
    assert.deepEqual(out.clips.map((c) => c.id), ["b"]);
    assert.equal(out.dropped, 1);
  });
  test("a failed or unusable check keeps the clip's original times, it never blocks a clip", async () => {
    const answers = [() => { throw new kie.KieError("502", { retryable: true }); }, () => ({ found: true, start: 9, end: 9.2 })];
    let i = 0;
    const out = await quiet(() => refine.refineMoments([mk("a", 100, 110), mk("b", 200, 206)], { ...base, chat: async () => answers[i++ % 2]() }));
    assert.equal(out.clips.length, 2);
    assert.deepEqual(out.clips.map((c) => [c.moment.startSec, c.moment.endSec]), [[100, 110], [200, 206]]);
    assert.equal(out.unverified, 2);
  });
  test("if the check rejects every clip, the check is the suspect: originals are kept", async () => {
    const out = await refine.refineMoments([mk("a", 100, 110), mk("b", 200, 206)], { ...base, chat: async () => ({ found: false }) });
    assert.equal(out.clips.length, 2);
    assert.equal(out.dropped, 0);
  });
  test("the prompt carries the quoted line, the kind and the context, and the window is bounded by the video", async () => {
    let prompt = "";
    await refine.refineMoments([mk("a", 3, 9, { kind: "bit", context: "ranting about detention" })], { ...base, chat: async ({ messages }) => { prompt = messages[0].content[0].text; return { found: false }; } });
    assert.match(prompt, /line a/); assert.match(prompt, /longer take where the buildup matters/); assert.match(prompt, /ranting about detention/);
    assert.match(prompt, /SECONDS FROM THE START OF THIS EXCERPT/);
    assert.match(prompt, /about 19 seconds/, "excerpt runs from 0 (not -5) to 19");
  });
  test("progress is reported once per clip", async () => {
    const seen = [];
    await refine.refineMoments([mk("a", 100, 110), mk("b", 200, 206), mk("c", 300, 306)], { ...base, concurrency: 2, chat: async () => ({ found: true, start: 8, end: 14 }), onProgress: (d, t) => seen.push([d, t]) });
    assert.deepEqual(seen.map((x) => x[1]), [3, 3, 3]);
    assert.deepEqual(seen.map((x) => x[0]).sort(), [1, 2, 3]);
  });
});

describe("audio: light touch-ups only when needed", () => {
  const render = require("../src/lib/render");
  test("parseLoudnorm reads ffmpeg's measurement, and treats silence as unmeasurable", () => {
    const txt = 'noise\n{\n\t"input_i" : "-27.61",\n\t"input_tp" : "-14.54",\n\t"input_lra" : "6.20",\n\t"input_thresh" : "-38.14",\n\t"output_i" : "-16.4",\n\t"target_offset" : "0.01"\n}\n';
    assert.deepEqual(render.parseLoudnorm(txt), { i: -27.61, tp: -14.54, lra: 6.2, thresh: -38.14, offset: 0.01 });
    assert.equal(render.parseLoudnorm("no json here"), null);
    assert.ok(!Number.isFinite(render.parseLoudnorm('{"input_i":"-inf","input_tp":"-inf","input_lra":"0.00","input_thresh":"-70","target_offset":"0"}').i));
  });
  test("audioNeeds: leave fine audio alone, fix quiet/loud/uneven audio, never touch silence", () => {
    assert.equal(render.audioNeeds({ i: -16, tp: -3, lra: 6 }), false, "already at a good level");
    assert.equal(render.audioNeeds({ i: -27, tp: -12, lra: 6 }), true, "too quiet");
    assert.equal(render.audioNeeds({ i: -8, tp: -0.2, lra: 4 }), true, "too loud and peaking");
    assert.equal(render.audioNeeds({ i: -16, tp: -3, lra: 20 }), true, "very uneven");
    assert.equal(render.audioNeeds({ i: -60, tp: -50, lra: 1 }), false, "near silence: boosting would only raise noise");
    assert.equal(render.audioNeeds({ i: -Infinity, tp: -Infinity, lra: 0 }), false, "digital silence");
    assert.equal(render.audioNeeds(null), false, "no audio / could not measure");
  });
  const withAudio = async (volumeDb, fn, t) => {
    const os = require("node:os"), fs = require("node:fs"), path = require("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-audio-"));
    try {
      const src = path.join(dir, "src.mp4");
      try {
        await mbMedia.runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=6", "-f", "lavfi", "-i", "sine=frequency=300:duration=6", "-af", `volume=${volumeDb}dB`, "-c:v", "libx264", "-c:a", "aac", "-shortest", src]);
      } catch { return t.skip("no usable ffmpeg here"); }
      await fn(dir, src);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  test("a very quiet clip comes out at a normal level", async (t) => {
    await withAudio(-8, async (dir, src) => {
      const before = await render.measureLoudness(src, 0.5, 4);
      assert.ok(before.i < -26 && before.i > -34, `source is quiet (${before.i} LUFS)`);
      const out = require("node:path").join(dir, "clip.mp4");
      await renderClip({ source: src, startSec: 0.5, endSec: 4.5, caption: "Quiet audio test", out });
      const after = await render.measureLoudness(out, 0, 4);
      assert.ok(after.i > -19 && after.i < -13, `normalised to about -16 LUFS, got ${after.i}`);
      assert.ok(after.tp <= -0.9, `no clipping (true peak ${after.tp} dBTP)`);
    }, t);
  });
  test("a clip that is already at a good level gets no audio processing at all", async (t) => {
    await withAudio(6, async (dir, src) => {
      const plan = await render.audioFilter(src, 0.5, 4);
      assert.ok(plan.measured.i > -19 && plan.measured.i < -13, `source is at a fine level (${plan.measured.i} LUFS)`);
      assert.equal(plan.filter, null, "left alone");
    }, t);
  });
  test("near-silence is never boosted (that would only raise the noise)", async (t) => {
    await withAudio(-38, async (dir, src) => {
      const plan = await render.audioFilter(src, 0.5, 4);
      assert.ok(plan.measured.i < -58, `source is near silent (${plan.measured.i} LUFS)`);
      assert.equal(plan.filter, null);
    }, t);
  });
  test("the boost is capped: a very quiet (but real) clip is lifted by at most ~22 dB, as one fixed gain", async (t) => {
    await withAudio(-20, async (dir, src) => {
      const plan = await render.audioFilter(src, 0.5, 4);
      assert.ok(plan.measured.i < -38.5 && plan.measured.i > -45, `source (${plan.measured.i} LUFS)`);
      assert.ok(plan.filter && !/loudnorm/.test(plan.filter), "a fixed gain, not loudnorm (which can pump)");
      assert.ok(plan.gainDb > 0 && plan.gainDb <= 22, `gain ${plan.gainDb} dB stays within the cap`);
      assert.match(plan.filter, /volume=[\d.]+dB/);
    }, t);
  });
  test("output size: full size for normal clips, smaller for long ones", () => {
    assert.deepEqual(render.outputSize(20), { w: 1080, h: 1920 });
    assert.deepEqual(render.outputSize(90), { w: 720, h: 1280 });
  });
  test("audioStatus names what happened to a clip's audio", () => {
    assert.equal(render.audioStatus(null), "none");
    assert.equal(render.audioStatus({ measured: null, filter: null }), "none", "no audio track");
    assert.equal(render.audioStatus({ measured: { i: -Infinity }, filter: null }), "none", "digital silence");
    assert.equal(render.audioStatus({ measured: { i: -70 }, filter: null }), "none", "too faint to use");
    assert.equal(render.audioStatus({ measured: { i: -16 }, filter: null }), "ok");
    assert.equal(render.audioStatus({ measured: { i: -35 }, filter: "x", gainDb: 19 }), "boosted");
    assert.equal(render.audioStatus({ measured: { i: -8 }, filter: "x", gainDb: -8 }), "trimmed");
    assert.equal(render.audioStatus({ measured: { i: -35 }, filter: null, rejected: true }), "rejected");
  });
  test("a source quieter than the old -45 LUFS cutoff is now brought up", () => {
    assert.equal(render.audioNeeds({ i: -50, tp: -35, lra: 5 }), true);
    assert.equal(render.audioNeeds({ i: -62, tp: -50, lra: 5 }), false, "effectively silent: left alone");
  });
  test("chooseGain: lifts quiet audio, trims loud audio a little, and never asks the limiter for much", () => {
    assert.equal(render.chooseGain({ i: -30, tp: -14 }), 14, "quiet with plenty of headroom: straight to -16");
    assert.equal(render.chooseGain({ i: -45, tp: -30 }), 22, "capped at 22 dB");
    assert.equal(render.chooseGain({ i: -30, tp: -6 }), 7.5, "spiky: held back so the limiter shaves at most ~3 dB");
    assert.equal(render.chooseGain({ i: -8, tp: -0.2 }), -8, "too loud: brought down");
    assert.equal(render.chooseGain({ i: -2, tp: 0 }), -12, "trimmed by at most 12 dB");
  });
  test("audioLooksOk rejects processing that loses speech, accepts a uniform lift", () => {
    const speech = [-30, -28, -60, -29, -31, -27, -61, -30, -29, -28, -30, -62];
    assert.equal(render.audioLooksOk(speech, speech.map((x) => x + 14)), true, "a plain lift is fine");
    assert.equal(render.audioLooksOk(speech, speech.map((x, i) => (i % 3 === 0 ? -90 : x + 14))), false, "speech dropping out is not");
    assert.equal(render.audioLooksOk(speech, speech.map((x) => x - 20)), false, "speech getting much quieter is not");
    assert.equal(render.audioLooksOk([-70, -70, -70, -70, -70], [-70, -70, -70, -70, -70]), true, "nothing to lose");
    assert.equal(render.audioLooksOk([-30], [-90]), true, "too short to judge");
  });
  test("a clip with no audio track still renders", async (t) => {
    const os = require("node:os"), fs = require("node:fs"), path = require("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-noaudio-"));
    try {
      const src = path.join(dir, "v.mp4");
      try { await mbMedia.runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=4", "-c:v", "libx264", src]); } catch { return t.skip("no usable ffmpeg here"); }
      const out = path.join(dir, "o.mp4");
      await renderClip({ source: src, startSec: 0.5, endSec: 3, caption: "No audio", out });
      const info = await mbMedia.probe(out);
      assert.equal(info.width, 1080); assert.equal(info.hasAudio, false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("route option parsing", () => {
  test("parseOptions clamps and ignores blanks", () => {
    assert.deepEqual(parseOptions({}), {});
    assert.deepEqual(parseOptions({ minScore: "0", maxClips: "999" }), { minScore: 1, maxClips: 60 });
    assert.deepEqual(parseOptions({ minScore: "2" }), { minScore: 2 });
    assert.deepEqual(parseOptions({ minScore: "8", maxClips: "12" }), { minScore: 8, maxClips: 12 });
    assert.deepEqual(parseOptions({ minScore: "", maxClips: "" }), {});
  });
});

// ─── Routes: gate + validation (stub pool, no real DB) ───────────────────

describe("meme-builder routes", () => {
  const BASE = "/api";
  const ID = "00000000-0000-0000-0000-00000000aaa1";
  let server, url, allow = true;

  const emptyPool = { query: async () => ({ rows: [], rowCount: 0 }) };
  const gate = (req, res, next) => (allow ? next() : res.status(403).json({ error: "Missing permission" }));

  before(async () => {
    const app = express();
    app.use(express.json());
    registerMemeBuilderRoutes(app, { asyncRoute, pool: emptyPool, requireAdmin: gate, requirePermission: () => gate });
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((r) => server.close(r)));

  const call = async (method, path, body) => {
    const res = await fetch(url + BASE + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  test("every route is behind the admin gate", async () => {
    allow = false;
    const routes = [
      ["GET", "/personas"], ["POST", "/personas", {}], ["DELETE", "/personas/x"],
      ["GET", "/jobs"], ["POST", "/jobs", {}], ["GET", `/jobs/${ID}`], ["POST", `/jobs/${ID}/recaption`, {}],
      ["POST", `/jobs/${ID}/retry`, {}], ["DELETE", `/jobs/${ID}`], ["GET", "/library"],
      ["PATCH", `/clips/${ID}`, {}], ["POST", `/clips/${ID}/rating`, {}], ["POST", `/clips/${ID}/regenerate-caption`, {}], ["GET", "/videos"], ["DELETE", `/clips/${ID}`], ["GET", `/clips/${ID}/video`],
    ];
    for (const [m, p, b] of routes) {
      const r = await call(m, p, b);
      assert.equal(r.status, 403, `${m} ${p} must be gated`);
    }
    allow = true;
  });

  test("the jobs list says which storage backend is in use", async () => {
    const saved = process.env.MEME_BUILDER_STORAGE_BACKEND;
    process.env.MEME_BUILDER_STORAGE_BACKEND = "local";
    const local = await call("GET", "/jobs");
    process.env.MEME_BUILDER_STORAGE_BACKEND = "r2";
    const r2 = await call("GET", "/jobs");
    if (saved === undefined) delete process.env.MEME_BUILDER_STORAGE_BACKEND; else process.env.MEME_BUILDER_STORAGE_BACKEND = saved;
    assert.equal(local.status, 200); assert.equal(local.body.storage, "local");
    assert.equal(r2.body.storage, "r2");
    assert.deepEqual(r2.body.jobs, []);
  });

  test("malformed ids are rejected before touching the database", async () => {
    assert.equal((await call("GET", "/jobs/not-a-uuid")).status, 400);
    assert.equal((await call("POST", "/clips/xyz/rating", { rating: 1 })).status, 400);
    assert.equal((await call("GET", "/clips/xyz/video")).status, 400);
  });

  test("unknown ids 404 cleanly", async () => {
    assert.equal((await call("GET", `/jobs/${ID}`)).status, 404);
    assert.equal((await call("GET", `/clips/${ID}/video`)).status, 404);
    assert.equal((await call("POST", `/clips/${ID}/rating`, { rating: 1 })).status, 404);
  });

  test("rating must be -1, 0 or 1", async () => {
    assert.equal((await call("POST", `/clips/${ID}/rating`, { rating: 5 })).status, 400);
    assert.equal((await call("POST", `/clips/${ID}/rating`, { rating: "x" })).status, 400);
  });

  test("starting a job validates the audience and the link", async () => {
    assert.equal((await call("POST", "/jobs", { personaId: "nope", sourceUrl: "https://8.8.8.8/a.mp4" })).status, 400);
    const yt = await call("POST", "/jobs", { personaId: "truckers", sourceUrl: "https://www.youtube.com/watch?v=abc" });
    assert.equal(yt.status, 400);
    assert.match(yt.body.error, /YouTube/);
    assert.equal((await call("POST", "/jobs", { personaId: "truckers", sourceUrl: "http://169.254.169.254/x.mp4" })).status, 400);
    assert.equal((await call("POST", "/jobs", { personaId: "truckers" })).status, 400);
  });

  test("audiences: built-ins can't be deleted; bad bodies are rejected", async () => {
    assert.equal((await call("DELETE", "/personas/truckers")).status, 400);
    assert.equal((await call("POST", "/personas", { name: "", notes: "short" })).status, 400);
    assert.equal((await call("POST", "/personas", { name: "X", notes: "too short" })).status, 400);
    assert.equal((await call("POST", "/personas", { persona: { name: "No summary" } })).status, 400);
  });

  test("regenerate-caption: bad id is 400, unknown clip is 404", async () => {
    assert.equal((await call("POST", "/clips/xyz/regenerate-caption", {})).status, 400);
    assert.equal((await call("POST", `/clips/${ID}/regenerate-caption`, {})).status, 404);
  });

  test("findMoment: the clip's original moment is found by nearest midpoint, with a stand-in when none is close", () => {
    const analysis = [
      { id: "m1", startSec: 100, endSec: 108, kind: "reaction", transcript: "a", context: "ca", emotion: "e1", delivery: "d1", reaction_use: "r1" },
      { id: "m2", startSec: 300, endSec: 340, kind: "bit", transcript: "b", context: "cb", emotion: "e2", delivery: "d2", reaction_use: "r2" },
    ];
    // the clip's cut was refined and snapped, so it no longer matches exactly
    const near = findMoment(analysis, { start_sec: "302.5", end_sec: "345.1", transcript: "b", emotion: "e2", why: "w" });
    assert.equal(near.id, "m2"); assert.equal(near.kind, "bit"); assert.equal(near.context, "cb");
    assert.equal(near.startSec, 302.5); assert.equal(near.endSec, 345.1, "uses the clip's real times");
    const far = findMoment(analysis, { start_sec: "500", end_sec: "504", transcript: "zzz", emotion: "joy", why: "fits" });
    assert.equal(far.kind, "reaction"); assert.equal(far.transcript, "zzz"); assert.equal(far.reaction_use, "fits");
    assert.equal(findMoment(null, { start_sec: "1", end_sec: "30", transcript: "t" }).kind, "bit", "long clip with no analysis is a bit");
  });

  test("parseCaptionReply is forgiving, so a run isn't lost to an oddly shaped answer", () => {
    const ms = [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4" }];
    const out = parseCaptionReply({ clips: [
      { id: "M1", usable: true, best: "one", score: 8 },
      { id: "[m2]", usable: false, best: "two", score: 9 },       // unusable: kept but scored low
      { id: "m3", candidates: ["", "three"], score: "7" },        // no best: first candidate
      { id: "m4", usable: true },                                  // no caption at all: dropped
      { id: "m9", best: "stray" },                                 // unknown id: dropped
    ] }, ms);
    assert.deepEqual(out.map((c) => [c.id, c.best, c.score]), [["m1", "one", 8], ["m2", "two", 3], ["m3", "three", 7]]);
    assert.equal(out[0].moment, ms[0]);
    assert.throws(() => parseCaptionReply("nope", ms), /array/);
  });

  test("caption edits validate length", async () => {
    assert.equal((await call("PATCH", `/clips/${ID}`, { caption: "" })).status, 400);
    assert.equal((await call("PATCH", `/clips/${ID}`, { caption: "x".repeat(201) })).status, 400);
  });
});

// ─── Worker ──────────────────────────────────────────────────────────────

describe("meme-builder worker", () => {
  const quiet = { log() {}, error() {}, warn() {} };

  test("MEME_BUILDER_RUNNER=off never touches the database", async () => {
    process.env.MEME_BUILDER_RUNNER = "off";
    let queries = 0;
    const w = startMemeBuilderWorker({ query: async () => { queries++; return { rows: [] }; } }, { log: quiet });
    await w.tick();
    w.stop();
    delete process.env.MEME_BUILDER_RUNNER;
    assert.equal(queries, 0);
  });

  test("an idle tick re-queues stale jobs, finds nothing, and does not throw", async () => {
    const sql = [];
    const w = startMemeBuilderWorker({ query: async (q) => { sql.push(q); return { rows: [], rowCount: 0 }; } }, { log: quiet });
    await w.tick();
    w.stop();
    assert.ok(sql.some((q) => /set status = case when attempts/.test(q)), "requeueStale ran");
    assert.ok(sql.some((q) => /skip locked/i.test(q)), "claim uses SKIP LOCKED");
  });

  test("an orphaned run is noticed after 3 minutes of silence, not 10", async () => {
    const seen = [];
    await require("../src/lib/store").requeueStale({ query: async (q, params) => { seen.push(params); return { rows: [] }; } });
    assert.equal(seen[0][0], "3", "stale after 3 minutes without a heartbeat (a live run beats every 30s)");
  });

  test("queueing a job wakes the runner immediately instead of waiting for the next poll", async () => {
    const { notifyJobQueued } = require("../src/lib/queue-signal");
    let claims = 0;
    const w = startMemeBuilderWorker({ query: async (q) => { if (/skip locked/i.test(q)) claims++; return { rows: [], rowCount: 0 }; } }, { log: quiet });
    assert.equal(claims, 0, "no query at start-up: the first poll is deferred");
    notifyJobQueued();
    await new Promise((r) => setTimeout(r, 60));
    w.stop();
    assert.equal(claims, 1, "one claim attempt right after the notify");
  });

  test("after stop() a notify does nothing", async () => {
    const { notifyJobQueued } = require("../src/lib/queue-signal");
    let queries = 0;
    const w = startMemeBuilderWorker({ query: async () => { queries++; return { rows: [], rowCount: 0 }; } }, { log: quiet });
    w.stop();
    notifyJobQueued();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(queries, 0);
  });

  test("a database error during a tick is swallowed so the process stays up", async () => {
    const w = startMemeBuilderWorker({ query: async () => { throw new Error("connection reset"); } }, { log: quiet });
    await assert.doesNotReject(() => w.tick());
    w.stop();
  });
});
