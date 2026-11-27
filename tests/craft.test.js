"use strict";
// The meme craft: audience-neutral rules, per-audience spice and overused topics, situation banks for custom
// audiences, spare clips through the check, the caption-card layout, and upright sizes for rotated phone videos.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const personas = require("../src/lib/personas");
const { writeCaptions, regenerateCaption, STYLE_RULES, SCORE_RULE } = require("../src/lib/captions");
const { spareCount, rankVerified } = require("../src/lib/pipeline");
const render = require("../src/lib/render");
const media = require("../src/lib/media");

const custom = {
  name: "Night-shift nurses", summary: "We are night-shift nurses.", daily_life: "12s, three in a row.",
  vocabulary: ["charting", "PRN", "the 3am admit"], pain_points: ["the 0645 admit"], joys: ["a quiet unit"], hot_buttons: [], in_jokes: [],
  humor_style: "dark and dry", authority_figures: [], never_say: [], example_captions: ["When the doc says 'just one more thing' at 0650"],
};
const moments = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}`, kind: "reaction", startSec: i * 20, endSec: i * 20 + 8, transcript: "no way", emotion: "disbelief", delivery: "flat", reaction_use: "being lied to", words: "neutral" }));

describe("the craft rules are written for every audience, not just truckers", () => {
  test("the shared rules name the craft and carry no trucking", () => {
    for (const rule of ["SETUP", "PUNCHLINE", "RELATABLE", "SPECIFIC", "INSTANT", "never explain the joke"]) assert.match(STYLE_RULES, new RegExp(rule, "i"));
    assert.doesNotMatch(STYLE_RULES + SCORE_RULE + personas.SPICE_RULE, /broker|dispatch|sleeper|trucker|ELD/i);
    assert.match(SCORE_RULE, /ALL FOUR/);
  });
  test("a custom audience's prompt has its own spice and no other audience's overused topics", async () => {
    const prompts = [];
    const chat = async ({ messages }) => { prompts.push(messages[0].content); return [{ id: "m1", usable: true, best: "x", score: 6 }]; };
    await writeCaptions({ ...custom, spice_notes: "bodily fluids at 4am", overused_topics: ["call lights"] }, moments(1), { chat });
    assert.match(prompts[0], /For us, that means: bodily fluids at 4am/);
    assert.match(prompts[0], /most overused topics for us are: call lights/);
    assert.doesNotMatch(prompts[0], /broker|14-hour|sleeper/i);
    prompts.length = 0;
    await writeCaptions(custom, moments(1), { chat });
    assert.doesNotMatch(prompts[0], /overused topics/, "an audience with none listed gets no such line");
    let regen = "";
    await regenerateCaption({ ...custom, overused_topics: ["call lights"] }, moments(1)[0], { chat: async ({ messages }) => { regen = messages[0].content; return { caption: "ok" }; } });
    assert.match(regen, /call lights/);
  });
  test("the built-in truckers keep their own overused topics and spice", () => {
    const t = personas.getPreset("truckers");
    assert.match(personas.overusedRule(t), /14-hour clock/);
    assert.match(personas.spiceRule(t), /sleeper-berth/);
  });
});

describe("custom audiences get a situation bank", () => {
  test("normalizeBank keeps only well-formed entries and clamps spice", () => {
    const bank = personas.normalizeBank({ situation_bank: [
      { domain: "Charting", situations: [{ t: "Charting a fall at 0640", s: 0 }, { t: "", s: 0 }, "Plain string situation", { t: "Raunchy one", s: 7 }] },
      { domain: "", situations: [{ t: "no domain" }] },
      { domain: "Empty", situations: [] },
    ] });
    assert.deepEqual(bank, [{ domain: "Charting", situations: [{ t: "Charting a fall at 0640", s: 0 }, { t: "Plain string situation", s: 0 }, { t: "Raunchy one", s: 0 }] }]);
    assert.deepEqual(personas.normalizeBank("nonsense"), []);
  });
  test("expandPersona builds the persona, then its bank in a second call; a failed bank never fails the audience", async () => {
    const calls = [];
    const chat = async ({ messages }) => {
      calls.push(messages[0].content);
      if (calls.length === 1) return { ...custom, name: "ignored" };
      return { situation_bank: [{ domain: "Handoff", situations: [{ t: "Report from day shift that starts with 'so...'", s: 0 }] }] };
    };
    const p = await personas.expandPersona({ name: "Night nurses", notes: "nurses on nights, dark humor" }, { chat });
    assert.equal(calls.length, 2);
    assert.match(calls[0], /overused_topics/, "the persona is asked for its overused topics");
    assert.match(calls[0], /spice_notes/);
    assert.match(calls[1], /SITUATION BANK/);
    assert.equal(p.name, "Night nurses");
    assert.equal(p.situation_bank[0].domain, "Handoff");
    assert.equal(personas.pickSeeds(p, 1)[0].length, 3, "the writer now gets starting points for this audience");
    let n = 0;
    const flaky = async () => { n += 1; if (n === 2) throw new Error("502"); return { ...custom }; };
    const orig = console.error; console.error = () => {};
    try { const q = await personas.expandPersona({ name: "Nurses", notes: "nurses on nights" }, { chat: flaky }); assert.equal(q.situation_bank, undefined); }
    finally { console.error = orig; }
  });
});

describe("an older custom audience gets its bank on its first run", () => {
  const { ensureSituationBank } = require("../src/lib/pipeline");
  const bank = [{ domain: "Handoff", situations: [{ t: "Report that starts with 'so...'", s: 0 }] }];
  test("built, used for this run and saved for the next", async () => {
    const saved = [];
    const pool = { query: async (_sql, params) => { saved.push(params); return { rows: [{ id: params[0], name: params[1], data: JSON.parse(params[2]) }] }; } };
    const p = { ...custom, id: "night-nurses", preset: false };
    await ensureSituationBank(pool, p, "user-1", console, { build: async () => bank });
    assert.deepEqual(p.situation_bank, bank);
    assert.equal(saved.length, 1);
    assert.equal(saved[0][0], "night-nurses"); assert.equal(saved[0][4], "user-1", "saved to its own owner");
    assert.deepEqual(JSON.parse(saved[0][2]).situation_bank, bank); assert.equal(JSON.parse(saved[0][2]).preset, undefined);
  });
  test("built-ins and audiences that have one are left alone; a failure never stops the run", async () => {
    let built = 0;
    const build = async () => { built += 1; return bank; };
    await ensureSituationBank({}, { ...personas.getPreset("truckers"), preset: true }, "u", console, { build });
    await ensureSituationBank({}, { ...custom, situation_bank: bank }, "u", console, { build });
    assert.equal(built, 0);
    await ensureSituationBank({}, { ...custom }, "u", { warn() {} }, { build: async () => { throw new Error("502"); } });
  });
});

describe("the check replaces dropped clips instead of losing them", () => {
  test("spares: a quarter more, between 3 and 10", () => {
    assert.equal(spareCount(12), 3); assert.equal(spareCount(30), 8); assert.equal(spareCount(60), 10); assert.equal(spareCount(2), 3);
  });
  test("checked clips rank by fit; unchecked ones follow in the writer's order", () => {
    const c = (id, score, fit, writerScore) => ({ id, score, fit, writerScore });
    const out = rankVerified([c("a", 8), c("b", 5, 5, 9), c("c", 9, 9, 6), c("d", 9, 9, 7), c("e", 6)]);
    assert.deepEqual(out.map((x) => x.id), ["d", "c", "b", "a", "e"]);
  });
});

describe("the caption card", () => {
  test("landscape video: a white card directly on top of the video, the pair a little above the middle", () => {
    const l = render.captionLayout({ srcW: 1920, srcH: 1080, caption: "Me when the group chat goes quiet after my joke" });
    assert.equal(l.mode, "card");
    assert.equal(l.videoY, l.cardY + l.cardH, "no gap between card and video");
    assert.equal(l.videoH, 608);
    const middle = l.cardY + (l.cardH + l.videoH) / 2;
    assert.ok(middle < 960 && middle > 700, `group centre ${middle} sits a little above the middle`);
    assert.ok(l.cardY >= 150, "clear of the app's header");
  });
  test("long captions shrink the text to stay within four lines; short ones stay big", () => {
    assert.equal(render.captionLayout({ srcW: 16, srcH: 9, caption: "Me" }).fontSize, 76);
    const long = render.captionLayout({ srcW: 16, srcH: 9, caption: "When the landlord says the rent is only going up a little and it's the third time this year" });
    assert.ok(long.lines <= 4 && long.fontSize < 76);
  });
  test("phone videos fill the frame with the caption on boxes near the top", () => {
    const l = render.captionLayout({ srcW: 1080, srcH: 1920, caption: "POV: quick question" });
    assert.equal(l.mode, "overlay");
    assert.match(render.buildAss("POV: quick question", 5, null, l), /Style: Cap,Liberation Sans,64,&H00101010,&H00101010,&H00FFFFFF,&H00000000,-1,0,0,0,100,100,0,0,3,/);
  });
  test("wrapping is balanced: no orphaned last word", () => {
    const lines = render.wrapCaption("When the dock says fifteen minutes and it is hour six", 21).split("\n");
    assert.ok(Math.min(...lines.map((x) => x.length)) >= 10, lines.join(" | "));
  });
  test("rotated phone videos report their upright size", () => {
    const banner = "  Duration: 00:00:10.00, start: 0\n  Stream #0:0: Video: h264, yuv420p, 1920x1080, 30 fps\n    Side data:\n      displaymatrix: rotation of -90.00 degrees\n  Stream #0:1: Audio: aac";
    const p = media.parseProbe(banner);
    assert.equal(p.width, 1080); assert.equal(p.height, 1920);
  });
  test("real ffmpeg: the card is white where the layout says and the video sits under it", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-card-"));
    try {
      const src = path.join(dir, "src.mp4");
      try { await media.runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=red:size=1280x720:rate=25:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-c:a", "aac", "-shortest", src]); }
      catch { return t.skip("no usable ffmpeg here"); }
      const out = path.join(dir, "clip.mp4");
      await render.renderClip({ source: src, startSec: 0.5, endSec: 2.5, caption: "Me", out });
      const info = await media.probe(out);
      assert.equal(info.width, 1080); assert.equal(info.height, 1920);
      const l = render.captionLayout({ srcW: 1280, srcH: 720, caption: "Me" });
      // Average brightness (Y) and redness (V) of a small patch, read with ffmpeg's own signalstats.
      const patch = async (x, y) => {
        const r = await media.run(media.ffmpegBin(), ["-v", "error", "-ss", "1", "-i", out, "-frames:v", "1", "-vf", `crop=8:8:${x}:${y},signalstats,metadata=print:file=-`, "-f", "null", "-"]);
        const get = (k) => Number(new RegExp(`signalstats\\.${k}=([\\d.]+)`).exec(r.stdout)[1]);
        return { y: get("YAVG"), v: get("VAVG") };
      };
      const card = await patch(20, l.cardY + 10);
      const video = await patch(540, l.videoY + l.videoH / 2);
      assert.ok(card.y > 220, `card is white, got Y ${card.y}`);
      assert.ok(video.v > 200 && video.y < 120, `video is red under the card, got ${JSON.stringify(video)}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
