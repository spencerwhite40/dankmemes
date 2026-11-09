"use strict";
// Billing endpoints. The webhook needs the exact bytes Stripe sent, so it is registered before the JSON parser.
const express = require("express");
const { HttpError } = require("../errors");
const stripe = require("./stripe");
const catalog = require("./catalog");
const service = require("./service");

function registerBillingWebhook(app, { pool }) {
  app.post("/billing/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    let event;
    try { event = stripe.verifyWebhook(req.body, req.get("stripe-signature"), process.env.STRIPE_WEBHOOK_SECRET); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    try {
      const out = await service.applyEvent(pool, event);
      res.json({ received: true, ...out });
    } catch (e) {
      console.error("[billing] event failed", event.id, event.type, e && e.message);
      res.status(500).json({ error: "failed, please retry" });   // Stripe retries on any non-2xx
    }
  });
}

function registerBillingRoutes(app, { pool, asyncRoute, requireUser }) {
  const handle = (fn) => asyncRoute(async (req, res, next) => {
    try { await fn(req, res, next); } catch (e) { if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, code: e.code }); throw e; }
  });

  app.get("/api/billing", requireUser, handle(async (req, res) => {
    res.json({ ...catalog.publicCatalog(), current: await service.billingState(pool, req.user.id) });
  }));
  app.post("/billing/checkout", requireUser, handle(async (req, res) => {
    if (!stripe.enabled()) throw new HttpError(503, "Billing isn't set up yet.", "billing_off");
    const b = req.body || {};
    res.json(await service.startCheckout(pool, req.user, req, { plan: b.plan, period: b.period, pack: b.pack }));
  }));
  app.post("/billing/offer/accept", requireUser, handle(async (req, res) => { res.json(await service.acceptOffer(pool, req.user)); }));
  app.post("/billing/cancel", requireUser, handle(async (req, res) => {
    if (!stripe.enabled()) throw new HttpError(503, "Billing isn't set up yet.", "billing_off");
    res.json(await service.cancelSubscription(pool, req.user));
  }));
  app.post("/billing/resume", requireUser, handle(async (req, res) => {
    if (!stripe.enabled()) throw new HttpError(503, "Billing isn't set up yet.", "billing_off");
    res.json(await service.resumeSubscription(pool, req.user));
  }));
  app.post("/billing/portal", requireUser, handle(async (req, res) => {
    if (!stripe.enabled()) throw new HttpError(503, "Billing isn't set up yet.", "billing_off");
    res.json(await service.openPortal(pool, req.user, req));
  }));
}

module.exports = { registerBillingWebhook, registerBillingRoutes };
