"use strict";
// Which Stripe price is which. The plan and pack numbers come from src/plans.js; the Stripe price ids come from the environment,
// so nothing about money is hard-coded here: STRIPE_PRICE_CREATOR_MONTHLY, STRIPE_PRICE_CREATOR_ANNUAL, ..., STRIPE_PRICE_PACK_SMALL, STRIPE_PRICE_PACK_LARGE.
const { PLANS, PACKS, PERIODS, paidPlanNames } = require("../plans");
const stripe = require("./stripe");

const planEnv = (plan, period) => `STRIPE_PRICE_${plan.toUpperCase()}_${period.toUpperCase()}`;
const packEnv = (pack) => `STRIPE_PRICE_PACK_${pack.toUpperCase()}`;
const planPriceId = (plan, period) => process.env[planEnv(plan, period)] || "";
const packPriceId = (pack) => process.env[packEnv(pack)] || "";

/** What a Stripe price id means here: {kind:"plan", plan, period} or {kind:"pack", pack}, else null. */
function lookupPrice(priceId) {
  if (!priceId) return null;
  for (const plan of paidPlanNames()) for (const period of PERIODS) if (planPriceId(plan, period) === priceId) return { kind: "plan", plan, period };
  for (const pack of Object.keys(PACKS)) if (packPriceId(pack) === priceId) return { kind: "pack", pack };
  return null;
}

/** Everything the page needs to draw the pricing: what's for sale and whether each item is wired to Stripe. */
function publicCatalog() {
  return {
    enabled: stripe.enabled(),
    plans: paidPlanNames().map((name) => ({
      name, label: PLANS[name].label, minutes: PLANS[name].monthlyMinutes,
      price_monthly: PLANS[name].priceMonthly, price_annual: PLANS[name].priceAnnual,
      available: { monthly: !!planPriceId(name, "monthly"), annual: !!planPriceId(name, "annual") },
    })),
    packs: Object.entries(PACKS).map(([key, p]) => ({ key, label: p.label, minutes: p.minutes, price: p.price, available: !!packPriceId(key) })),
  };
}

/** The env var names that must hold Stripe price ids (used by docs and a startup note). */
function requiredPriceVars() {
  return [...paidPlanNames().flatMap((p) => PERIODS.map((per) => planEnv(p, per))), ...Object.keys(PACKS).map(packEnv)];
}

module.exports = { planPriceId, packPriceId, lookupPrice, publicCatalog, requiredPriceVars, planEnv, packEnv };
