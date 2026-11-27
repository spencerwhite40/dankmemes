"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const DB = process.env.DATABASE_URL_TEST;
describe("the public pages: landing, studio and prices (real database)", { skip: !DB && "DATABASE_URL_TEST is not set" }, () => {
  const { Pool } = require("pg");
  const { PLANS } = require("../src/plans");
  const { migrate } = require("../src/migrate");
  const { buildApp } = require("../src/server");
  let pool, server, base;
  before(async () => {
    pool = new Pool({ connectionString: DB, ssl: /\/tmp\/|localhost|127\.0\.0\.1/.test(DB) ? false : { rejectUnauthorized: false } });
    await migrate(pool);
    await new Promise((r) => { server = http.createServer(buildApp(pool)).listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { server && server.close(); await pool.end(); });

  test("/ is the landing page, and it forwards email and checkout links on to the studio", async () => {
    const r = await fetch(`${base}/`); assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /<title>[^<]*dankmemes/i); assert.match(html, /\/landing\.js/);
    assert.match(html, /verify\|reset\|billing/, "the redirect for /?verify=, /?reset= and /?billing= is there");
  });
  test("/app is the studio page", async () => {
    const r = await fetch(`${base}/app`); assert.equal(r.status, 200); const html = await r.text();
    assert.match(html, /id="maker"/); assert.match(html, /\/app\.js/);
  });
  test("/api/pricing lists every plan with the numbers from plans.js, and needs no sign-in", async () => {
    const r = await fetch(`${base}/api/pricing`); assert.equal(r.status, 200);
    const { plans } = await r.json();
    assert.deepEqual(plans.map((p) => p.name), Object.keys(PLANS));
    for (const p of plans) {
      const src = PLANS[p.name];
      assert.equal(p.minutes, src.monthlyMinutes); assert.equal(p.price_monthly, src.priceMonthly); assert.equal(p.max_video_minutes, src.maxVideoMinutes);
      assert.equal(p.watermark, !!src.watermark); assert.equal(p.api_access, !!src.apiAccess);
      assert.ok(!("stripe_price" in p) && !JSON.stringify(p).includes("price_1"), "no Stripe ids leak");
    }
  });
  test("fonts are served with a long cache, and every id the studio script looks up exists in the page", async () => {
    const font = fs.readdirSync(path.join(__dirname, "..", "public", "fonts")).find((f) => f.endsWith(".woff2"));
    const r = await fetch(`${base}/fonts/${font}`); assert.equal(r.status, 200); assert.match(r.headers.get("cache-control") || "", /max-age=31536000/);
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "app.html"), "utf8");
    const js = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
    const ids = new Set([...js.matchAll(/\$\("([\w-]+)"\)/g)].map((m) => m[1]));
    const dynamic = new Set(["aud-add"]);   // made by the script itself
    const missing = [...ids].filter((id) => !dynamic.has(id) && !html.includes(`id="${id}"`));
    assert.deepEqual(missing, [], "ids the script uses but the page lacks");
  });
});
