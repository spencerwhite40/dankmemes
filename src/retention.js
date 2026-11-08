"use strict";
// Plans keep a run (its video and clips) for a number of days; this deletes the ones past that. Safe to run any time, and from several machines.
const store = require("./lib/store");
const storage = require("./lib/storage");
const { planNames, getPlan } = require("./plans");

/** Deletes finished runs older than each plan's retention. Returns how many runs were removed. */
async function sweep(pool, { log = console } = {}) {
  let removed = 0;
  for (const name of planNames()) {
    const days = getPlan(name).retentionDays;
    const { rows } = await pool.query(
      `select j.id from meme_builder_jobs j join users u on u.id::text = j.owner_id
        where u.plan = $1 and j.status in ('done','error') and j.created_at < now() - ($2 || ' days')::interval limit 200`,
      [name, String(days)],
    );
    for (const { id } of rows) {
      try {
        const gone = await store.deleteJob(pool, id);
        if (gone) {
          for (const uri of gone.clipUris) await storage.remove(uri).catch(() => {});
          if (gone.sourceUri) await storage.remove(gone.sourceUri).catch(() => {});
        }
        removed++;
      } catch (e) { log.error("[retention]", id, e && e.message); }
    }
  }
  if (removed) log.log(`[retention] removed ${removed} expired run${removed === 1 ? "" : "s"}`);
  return removed;
}

/** Sweeps shortly after start and then every 6 hours. Returns a stop function. */
function startRetention(pool, { log = console, firstMs = 2 * 60 * 1000, everyMs = 6 * 3600 * 1000 } = {}) {
  if ((process.env.RETENTION_SWEEP || "").toLowerCase() === "off") return () => {};
  const run = () => sweep(pool, { log }).catch((e) => log.error("[retention]", e && e.message));
  const first = setTimeout(run, firstMs), every = setInterval(run, everyMs);
  if (first.unref) first.unref(); if (every.unref) every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}

module.exports = { sweep, startRetention };
