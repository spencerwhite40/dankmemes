"use strict";
// Running the service by hand, until there is a billing page:
//   npm run admin -- users
//   npm run admin -- set-plan someone@example.com pro
//   npm run admin -- set-password someone@example.com "a new long password"
//   npm run admin -- make-admin someone@example.com
//   npm run admin -- funding                          (provider spend, what customers are owed, suggested auto-reload settings)
//   npm run admin -- verify someone@example.com       (mark an email address as confirmed)
//   npm run admin -- takedown <run-id or clip-id>     (remove a run and its clips after a valid copyright notice)
const { makePool } = require("./db");
const { migrate } = require("./migrate");
const accounts = require("./accounts");
const { planNames } = require("./plans");

(async () => {
  const [cmd, email, arg] = process.argv.slice(2);
  const pool = makePool();
  await migrate(pool);
  const find = async () => {
    const { rows } = await pool.query("select * from users where lower(email) = $1", [accounts.normEmail(email)]);
    if (!rows[0]) { console.error(`No user with email ${email}`); process.exit(1); }
    return rows[0];
  };
  if (cmd === "users") {
    const { rows } = await pool.query("select email, plan, is_admin, created_at, last_login_at from users order by created_at");
    console.table(rows.map((r) => ({ email: r.email, plan: r.plan, admin: r.is_admin, joined: r.created_at.toISOString().slice(0, 10), last_login: r.last_login_at ? r.last_login_at.toISOString().slice(0, 10) : "" })));
  } else if (cmd === "set-plan") {
    const u = await find(); await accounts.setPlan(pool, u.id, arg); console.log(`${u.email} is now on the ${arg} plan`);
  } else if (cmd === "set-password") {
    const u = await find(); await accounts.setPassword(pool, u.id, arg); console.log(`Password changed for ${u.email} (signed out everywhere)`);
  } else if (cmd === "make-admin") {
    const u = await find(); await pool.query("update users set is_admin = true where id = $1", [u.id]); console.log(`${u.email} is an admin`);
  } else if (cmd === "funding") {
    const f = require("./funding"); f.print(await f.report(pool));
  } else if (cmd === "verify") {
    const u = await find(); await accounts.markVerified(pool, u.id); console.log(`${u.email} is marked as confirmed`);
  } else if (cmd === "takedown") {
    // `email` holds the id here. A clip id takes down the run it belongs to (clips are made and kept per run).
    const store = require("./lib/store");
    let job = await store.getJob(pool, email).catch(() => null);
    if (!job) { const clip = await store.getClip(pool, email).catch(() => null); job = clip && await store.getJob(pool, clip.job_id); }
    if (!job) { console.error(`No run or clip with id ${email}`); process.exit(1); }
    const owner = (await pool.query("select email from users where id::text = $1", [job.owner_id])).rows[0];
    const clips = await store.listJobClips(pool, job.id);
    console.log(`Taking down run ${job.id} ("${job.source_label}") owned by ${owner ? owner.email : job.owner_id}: ${clips.length} clip(s), captions: ${clips.map((c) => JSON.stringify(c.caption)).join(" | ")}`);
    await require("./clips").deleteRun(pool, job.owner_id, job.id);
    console.log("Removed. Tell the account holder, and keep a note of the notice (who sent it, when, which run).");
  } else {
    console.log(`Usage: npm run admin -- users | set-plan <email> <${planNames().join("|")}> | set-password <email> <password> | make-admin <email> | verify <email> | takedown <run-or-clip-id> | funding`);
  }
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
