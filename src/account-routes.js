"use strict";
// A signed-in user's own API keys. Plans without API access can't make them.
const keys = require("./lib/keys");
const accounts = require("./accounts");
const { HttpError } = require("./errors");

const MAX_KEYS = 5;

function registerAccountRoutes(app, { pool, asyncRoute, requireUser }) {
  const handle = (fn) => asyncRoute(async (req, res, next) => {
    try { await fn(req, res, next); } catch (e) { if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, code: e.code }); throw e; }
  });

  app.get("/account/keys", requireUser, handle(async (req, res) => {
    res.json({ keys: await keys.listKeys(pool, req.user.id) });
  }));

  app.post("/account/keys", requireUser, handle(async (req, res) => {
    const plan = await accounts.planFor(pool, req.user.id);
    if (!plan.apiAccess) throw new HttpError(403, `The ${plan.label} plan doesn't include API access. Move to a paid plan to create API keys.`, "api_not_in_plan");
    const name = typeof (req.body || {}).name === "string" ? req.body.name.trim().slice(0, 80) : "";
    if (!name) throw new HttpError(400, "Give the key a name.", "bad_name");
    const existing = (await keys.listKeys(pool, req.user.id)).filter((k) => !k.revoked_at);
    if (existing.length >= MAX_KEYS) throw new HttpError(400, `You can have ${MAX_KEYS} active keys. Revoke one first.`, "too_many_keys");
    const made = await keys.createKey(pool, { ownerId: req.user.id, name, rateLimitPerMin: plan.ratePerMin });
    // The key and webhook secret are returned this once and can't be looked up again.
    res.status(201).json({ key: made.key, webhook_secret: made.webhook_secret, record: made.record });
  }));

  app.delete("/account/keys/:id", requireUser, handle(async (req, res) => {
    const ok = await keys.revokeKey(pool, req.params.id, req.user.id);
    if (!ok) throw new HttpError(404, "not found", "not_found");
    res.json({ ok: true });
  }));
}

module.exports = { registerAccountRoutes };
