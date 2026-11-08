"use strict";
// Meme Builder: one Express app (API + the simple web page) and, unless RUNNER=off, the job runner in the same process.
// For more speed, run the runner on its own machine instead: set MEME_BUILDER_RUNNER=off on the web app and run `npm run worker` there.
const path = require("node:path");
const express = require("express");

const { makePool } = require("./db");
const { migrate } = require("./migrate");
const { requireLogin, registerAuthRoutes } = require("./auth");
const { registerMemeBuilderRoutes } = require("./routes");
const { startMemeBuilderWorker } = require("./worker");
const { asyncRoute } = require("./async-route");


function buildApp(pool) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));
  registerAuthRoutes(app);
  registerMemeBuilderRoutes(app, { asyncRoute, pool, requireAdmin: requireLogin });

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
  const app = buildApp(pool);
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Meme Builder listening on :${port}${process.env.APP_PASSWORD ? "" : " (NO PASSWORD SET: anyone who can reach this can use it)"}`));
  startMemeBuilderWorker(pool);
}

module.exports = { buildApp };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
