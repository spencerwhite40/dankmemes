"use strict";
// Download my data, delete my account. Deleting is open to a locked account too (leaving must always be possible).
const accounts = require("./accounts");
const stripe = require("./billing/stripe");
const rights = require("./data-rights");
const { createLimiter } = require("./ratelimit");
const { HttpError } = require("./errors");

function registerDataRoutes(app, { pool, asyncRoute, requireUser, requireActive }) {
  const handle = (fn) => asyncRoute(async (req, res, next) => {
    try { await fn(req, res, next); } catch (e) { if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, code: e.code }); throw e; }
  });
  const hourly = () => createLimiter({ windowMs: 60 * 60 * 1000 });
  const exportLimit = hourly(), deleteLimit = hourly();

  app.get("/account/export", requireActive, handle(async (req, res) => {
    if (!exportLimit.check(req.user.id, 5).ok) throw new HttpError(429, "That's enough downloads for now. Try again in a while.", "rate_limited");
    const data = await rights.exportAccount(pool, req.user.id);
    res.set("Content-Disposition", 'attachment; filename="my-data.json"').type("application/json").send(JSON.stringify(data, null, 2));
  }));

  app.post("/account/delete", requireUser, handle(async (req, res) => {
    const b = req.body || {};
    if (!deleteLimit.check(req.user.id, 5).ok) throw new HttpError(429, "Too many attempts. Try again in an hour.", "rate_limited");
    if (b.confirm !== "DELETE") throw new HttpError(400, 'Type DELETE to confirm.', "not_confirmed");
    const { rows } = await pool.query("select password_hash, stripe_subscription_id from users where id = $1", [req.user.id]);
    const u = rows[0];
    if (!u || !(await accounts.verifyPassword(String(b.password || ""), u.password_hash))) throw new HttpError(403, "That password isn't right.", "bad_password");
    // A live subscription is ended first, so nobody is charged again for an account that no longer exists.
    if (u.stripe_subscription_id) {
      if (!stripe.enabled()) throw new HttpError(409, "This account has a subscription that can't be cancelled from here right now. Contact support.", "cannot_cancel");
      await stripe.call("DELETE", `/subscriptions/${encodeURIComponent(u.stripe_subscription_id)}`);
    }
    const out = await rights.deleteAccount(pool, req.user.id);
    res.set("Set-Cookie", "mb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    res.json({ ok: true, ...out });
  }));
}

module.exports = { registerDataRoutes };
