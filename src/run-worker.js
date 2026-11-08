"use strict";
// Runner only, no web server: this is what runs on the faster machine (Fly). Same code, same database, same storage.
const { makePool } = require("./db");
const { migrate } = require("./migrate");
const { startMemeBuilderWorker } = require("./worker");

(async () => {
  const pool = makePool();
  await migrate(pool);
  require("./lib/ai").ledger.setPool(pool);
  startMemeBuilderWorker(pool);
  require("./retention").startRetention(pool);
  console.log("Meme Builder runner started (no web server)");
})().catch((e) => { console.error(e); process.exit(1); });
