"use strict";
// Meme Builder: one Express app (API + the web page) and, unless MEME_BUILDER_RUNNER=off, the job runner in the same process.
// For more speed, run the runner on its own machine instead: set MEME_BUILDER_RUNNER=off on the web app and run `npm run worker` there.
const path = require("node:path");
const express = require("express");

const { makePool } = require("./db");
const { migrate } = require("./migrate");
const { requireUser, registerAuthRoutes } = require("./auth");
const { registerAccountRoutes } = require("./account-routes");
const { registerMemeBuilderRoutes } = require("./routes");
const { startMemeBuilderWorker } = require("./worker");
const { asyncRoute } = require("./async-route");
const { buildV1 } = require("./v1");
const { registerBillingWebhook, registerBillingRoutes } = require("./billing/routes");

function buildApp(pool) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);          // behind Render/Fly's proxy, so req.ip is the visitor (login rate limits depend on it)
  registerBillingWebhook(app, { pool });   // before the JSON parser: the signature is over the raw bytes
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));
  const needUser = requireUser(pool);
  registerAuthRoutes(app, { pool, asyncRoute });
  registerAccountRoutes(app, { pool, asyncRoute, requireUser: needUser });
  registerBillingRoutes(app, { pool, asyncRoute, requireUser: needUser });
  registerMemeBuilderRoutes(app, { asyncRoute, pool, requireAdmin: needUser });
  app.use("/v1", buildV1(pool));            // the public API (API-key auth); see docs/api.md

  app.use(express.static(path.join(__dirname, "..", "public")));
  // JSON errors for the API, so the page can show a plain message.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error("[server]", err && err.stack || err);
    res.status(err && err.status ? err.status : 500).json({ error: (err && err.message) || "Something went wrong." });
  });
  return app;
}

async function main() {
  const pool = makePool();
  await migrate(pool);
  require("./lib/ai").ledger.setPool(pool);
  const app = buildApp(pool);
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Meme Builder listening on :${port}`));
  startMemeBuilderWorker(pool);
  require("./retention").startRetention(pool);
}

module.exports = { buildApp };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
