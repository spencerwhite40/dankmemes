"use strict";
// Applies schema.sql (idempotent). Run on boot by the server and the worker, or by hand: npm run migrate
const fs = require("node:fs");
const path = require("node:path");

async function migrate(pool) {
  const sql = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  await pool.query(sql);   // one multi-statement query: it runs as a unit on a single connection
}

module.exports = { migrate };

if (require.main === module) {
  const { makePool } = require("./db");
  const pool = makePool();
  migrate(pool).then(() => { console.log("schema ok"); return pool.end(); }).catch((e) => { console.error(e); process.exit(1); });
}
