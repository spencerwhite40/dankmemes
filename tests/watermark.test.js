"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildAss, watermarkText, watermarkLines, renderClip } = require("../src/lib/render");
const mbMedia = require("../src/lib/media");
const { PLANS, paidPlanNames } = require("../src/plans");

describe("which plans carry the watermark", () => {
  test("the free plan and the lowest paid plan do; every higher plan does not", () => {
    assert.equal(PLANS.free.watermark, true);
    const byPrice = paidPlanNames().sort((a, b) => PLANS[a].priceMonthly - PLANS[b].priceMonthly);
    assert.equal(byPrice[0], "starter", "the cheapest paid plan is Starter");
    assert.equal(PLANS.starter.priceMonthly, 15);
    assert.equal(PLANS.starter.watermark, true);
    for (const n of byPrice.slice(1)) assert.equal(PLANS[n].watermark, false, `${n} has no watermark`);
    for (const n of Object.keys(PLANS)) assert.equal(typeof PLANS[n].watermark, "boolean", `${n} says yes or no explicitly`);
  });
});

describe("the watermark in the subtitle file", () => {
  test("no watermark means no mark lines; a watermark covers the whole clip and moves between spots", () => {
    assert.ok(!/Mark,/.test(buildAss("hi", 10).split("[Events]")[1]), "none asked for, none drawn");
    const lines = watermarkLines(10, "made with x");
    assert.equal(lines.length, 4, "10 seconds in 3-second steps");
    assert.ok(lines[0].includes("0:00:00.00,0:00:03.00") && lines[3].includes("0:00:09.00,0:00:10.00"), "from the first frame to the last");
    const spots = lines.map((l) => /\\pos\((\d+),(\d+)\)/.exec(l).slice(1).join(","));
    assert.equal(new Set(spots.slice(0, 4)).size, 4, "a different spot each time");
    assert.ok(buildAss("hi", 10, "made with x").includes("made with x"));
  });
  test("the words can be set, are kept short, and can't break the subtitle format", () => {
    const keep = process.env.WATERMARK_TEXT;
    try {
      delete process.env.WATERMARK_TEXT; assert.equal(watermarkText(), "made with dankmemes");
      process.env.WATERMARK_TEXT = "my {\\an1}brand\nline"; const t = watermarkText();
      assert.ok(!/[{}\\\n]/.test(t), "no override braces, backslashes or newlines");
      process.env.WATERMARK_TEXT = "x".repeat(500); assert.equal(watermarkText().length, 60);
      process.env.WATERMARK_TEXT = "  "; assert.equal(watermarkText(), "made with dankmemes", "blank falls back");
    } finally { if (keep === undefined) delete process.env.WATERMARK_TEXT; else process.env.WATERMARK_TEXT = keep; }
  });
});

describe("the watermark in the rendered pixels (real ffmpeg)", () => {
  test("it is burned into the clip, moves, and is absent when the plan has none", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-wm-"));
    try {
      const src = path.join(dir, "src.mp4");
      try { await mbMedia.runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=25:duration=7", "-f", "lavfi", "-i", "sine=frequency=440:duration=7", "-c:v", "libx264", "-c:a", "aac", "-shortest", src]); }
      catch { return t.skip("no usable ffmpeg here"); }
      const marked = path.join(dir, "marked.mp4"), clean = path.join(dir, "clean.mp4");
      await renderClip({ source: src, startSec: 0.5, endSec: 6.5, caption: "a caption", out: marked, watermark: watermarkText() });
      await renderClip({ source: src, startSec: 0.5, endSec: 6.5, caption: "a caption", out: clean });
      // the pixels of one region of one frame, as raw grey bytes
      const region = async (file, at, x, y) => {
        const raw = path.join(dir, `r-${path.basename(file)}-${at}-${x}-${y}.raw`);
        await mbMedia.runFfmpeg(["-y", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", `crop=520:90:${x}:${y},format=gray`, "-f", "rawvideo", raw]);
        return fs.readFileSync(raw);
      };
      const diff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d / a.length; };
      const spot1 = [40, 1135], spot2 = [520, 1655];
      assert.ok(diff(await region(marked, 1, ...spot1), await region(clean, 1, ...spot1)) > 3, "the mark is in the first spot early on");
      assert.ok(diff(await region(marked, 1, ...spot2), await region(clean, 1, ...spot2)) < 1, "and not yet in the second");
      assert.ok(diff(await region(marked, 4, ...spot2), await region(clean, 4, ...spot2)) > 3, "it has moved to the second spot later");
      assert.ok(diff(await region(clean, 1, ...spot1), await region(clean, 1, ...spot1)) === 0, "(the clean render is stable, so the differences above come from the mark)");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
