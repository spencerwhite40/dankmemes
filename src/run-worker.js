"use strict";
// Runner only, no web server: this is what runs on the faster machine (Fly). Same code, same database, same storage.
const { makePool } = require("./db");
const { migrate } = require("./migrate");
const { startMemeBuilderWorker, secondsEnv } = require("./worker");

(async () => {
  require("./alerts").watchProcess("worker");
  const pool = makePool();
  await migrate(pool);
  require("./lib/ai").ledger.setPool(pool);
  // A machine started for a run looks straight away and then every couple of seconds; once it has had nothing to do
  // for WORKER_IDLE_EXIT_SECONDS it exits, and Fly stops the machine until the web app starts it for the next run.
  startMemeBuilderWorker(pool, {
    bootDelayMs: 0,
    idlePollMs: secondsEnv("WORKER_IDLE_POLL_SECONDS") || undefined,
    exitWhenIdleMs: secondsEnv("WORKER_IDLE_EXIT_SECONDS"),
    onIdleExit: () => pool.end().catch(() => {}).finally(() => process.exit(0)),
  });
  require("./retention").startRetention(pool);
  console.log("dankmemes runner started (no web server)");
})().catch((e) => { console.error(e); process.exit(1); });
