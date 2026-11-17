"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");

const { renderConcurrency } = require("../src/lib/pipeline");

describe("how many clips render at once", () => {
  const withEnv = (v, fn) => { const keep = process.env.RENDER_CONCURRENCY; if (v === undefined) delete process.env.RENDER_CONCURRENCY; else process.env.RENDER_CONCURRENCY = v; try { return fn(); } finally { if (keep === undefined) delete process.env.RENDER_CONCURRENCY; else process.env.RENDER_CONCURRENCY = keep; } };
  test("the default follows the machine: parallel only with 4 or more cores", () => {
    const real = os.cpus;
    try {
      for (const [cores, want] of [[1, 1], [2, 1], [3, 1], [4, 2], [8, 2], [16, 2]]) { os.cpus = () => new Array(cores).fill({}); assert.equal(withEnv(undefined, renderConcurrency), want, `${cores} cores`); }
    } finally { os.cpus = real; }
  });
  test("RENDER_CONCURRENCY overrides it, within 1 to 8; nonsense is ignored", () => {
    const real = os.cpus; os.cpus = () => new Array(2).fill({});
    try {
      assert.equal(withEnv("3", renderConcurrency), 3); assert.equal(withEnv("1", renderConcurrency), 1); assert.equal(withEnv("99", renderConcurrency), 8);
      assert.equal(withEnv("2.7", renderConcurrency), 2); assert.equal(withEnv("0", renderConcurrency), 1, "0 falls back to the default"); assert.equal(withEnv("abc", renderConcurrency), 1); assert.equal(withEnv("-4", renderConcurrency), 1);
    } finally { os.cpus = real; }
  });
});
