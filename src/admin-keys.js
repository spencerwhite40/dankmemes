"use strict";
// Creating and revoking API keys. Signed-in (password) users only: an API key can't manage keys.
const keys = require("./lib/keys");

const OWNER_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function registerKeyAdminRoutes(app, { pool, asyncRoute, requireAdmin }) {
  app.get("/admin/keys", requireAdmin, asyncRoute(async (_req, res) => {
    res.json({ keys: await keys.listKeys(pool) });
  }));

  app.post("/admin/keys", requireAdmin, asyncRoute(async (req, res) => {
    const b = req.body || {};
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 80) : "";
    const ownerId = typeof b.ownerId === "string" ? b.ownerId.trim().toLowerCase() : "";
    if (!name) return res.status(400).json({ error: "Give the key a name." });
    if (!OWNER_RE.test(ownerId) || ownerId === "default") return res.status(400).json({ error: "Owner must be 1-40 characters: lowercase letters, numbers, - or _ (and not \"default\", which is the web page)." });
    const quota = b.monthlyMinutesQuota === "" || b.monthlyMinutesQuota == null ? null : Number(b.monthlyMinutesQuota);
    if (quota !== null && (!Number.isFinite(quota) || quota < 0)) return res.status(400).json({ error: "Monthly minutes must be a number, or empty for no limit." });
    const made = await keys.createKey(pool, { ownerId, name, monthlyMinutesQuota: quota });
    // The key and webhook secret are returned this once and can't be looked up again.
    res.status(201).json({ key: made.key, webhook_secret: made.webhook_secret, record: made.record });
  }));

  app.delete("/admin/keys/:id", requireAdmin, asyncRoute(async (req, res) => {
    const ok = await keys.revokeKey(pool, req.params.id);
    return ok ? res.json({ ok: true }) : res.status(404).json({ error: "not found" });
  }));
}

module.exports = { registerKeyAdminRoutes };
