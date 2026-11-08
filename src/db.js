"use strict";
// One shared Postgres pool. DATABASE_URL is the production database; tests and local runs use DATABASE_URL_TEST
// when it is set, so a local run can never touch production by accident.
const { Pool } = require("pg");

function makePool() {
  const url = process.env.NODE_ENV === "production" ? process.env.DATABASE_URL : (process.env.DATABASE_URL_TEST || process.env.DATABASE_URL);
  if (!url) throw new Error("DATABASE_URL is not set.");
  return new Pool({ connectionString: url, max: 8, ssl: /sslmode=disable|localhost|127\.0\.0\.1|%2F|\/tmp\//.test(url) ? false : { rejectUnauthorized: false } });
}

module.exports = { makePool };
