"use strict";
// Starting a payment, cancelling, opening the customer portal, and turning Stripe's events into plan changes.
const { PLANS, PACKS, PERIODS, DEFAULT_PLAN, paidPlanNames } = require("../plans");
const { HttpError } = require("../errors");
const stripe = require("./stripe");
const catalog = require("./catalog");
const packs = require("./packs");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE = new Set(["active", "trialing", "past_due"]);        // a subscription in these states keeps its plan
const ENDED = new Set(["canceled", "unpaid", "incomplete_expired"]);
const OFFER_COOLDOWN_DAYS = 180;                                 // the stay-another-month offer can be taken once per this long

const appUrl = (req) => (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");

async function userRow(pool, id) {
  const { rows } = await pool.query("select * from users where id = $1", [id]);
  return rows[0] || null;
}
const hasLiveSubscription = (u) => !!u.stripe_subscription_id && u.plan_status !== "canceled";
/** A subscriber: on a paid plan, not locked, and not past due or on the way out. Only subscribers may buy packs. */
const isSubscriber = (u) => !!u && u.plan !== DEFAULT_PLAN && !u.locked_at && (!u.plan_status || u.plan_status === "active");

// ── Starting a payment ─────────────────────────────────────────────────────────────────────────────────────
async function startCheckout(pool, user, req, { plan, period, pack }) {
  const u = await userRow(pool, user.id);
  if (!u) throw new HttpError(401, "Please sign in.", "signed_out");
  const base = appUrl(req);
  const common = {
    success_url: `${base}/?billing=success`, cancel_url: `${base}/?billing=cancelled`,
    client_reference_id: u.id,
    ...(u.stripe_customer_id ? { customer: u.stripe_customer_id } : { customer_email: u.email }),
  };
  if (pack) {
    if (!PACKS[pack]) throw new HttpError(400, "No such pack.", "bad_pack");
    if (!isSubscriber(u)) throw new HttpError(403, "Top-up packs are for subscribers. Subscribe to a plan first.", "subscribers_only");
    const price = catalog.packPriceId(pack);
    if (!price) throw new HttpError(503, "That pack isn't on sale yet.", "not_configured");
    const s = await stripe.call("POST", "/checkout/sessions", { ...common, mode: "payment", line_items: [{ price, quantity: 1 }], metadata: { user_id: u.id, pack } });
    return { url: s.url };
  }
  if (!paidPlanNames().includes(plan)) throw new HttpError(400, "Choose a paid plan.", "bad_plan");
  if (!PERIODS.includes(period)) throw new HttpError(400, "Choose monthly or annual.", "bad_period");
  if (hasLiveSubscription(u)) throw new HttpError(409, "You already have a subscription. Use Manage billing to change it.", "already_subscribed");
  const price = catalog.planPriceId(plan, period);
  if (!price) throw new HttpError(503, "That plan isn't on sale yet.", "not_configured");
  const meta = { user_id: u.id, plan, period };
  const s = await stripe.call("POST", "/checkout/sessions", { ...common, mode: "subscription", line_items: [{ price, quantity: 1 }], allow_promotion_codes: true, metadata: meta, subscription_data: { metadata: meta } });
  return { url: s.url };
}

async function openPortal(pool, user, req) {
  const u = await userRow(pool, user.id);
  if (!u || !u.stripe_customer_id) throw new HttpError(409, "There's no billing history on this account yet.", "no_customer");
  const s = await stripe.call("POST", "/billing_portal/sessions", { customer: u.stripe_customer_id, return_url: `${appUrl(req)}/` });
  return { url: s.url };
}

// ── Cancelling, and the offer to stay ────────────────────────────────────────────────────────────────────
const toDate = (sec) => (Number(sec) > 0 ? new Date(Number(sec) * 1000) : null);
/** Newer API versions keep the period end on the subscription item, older ones on the subscription. */
const periodEnd = (sub) => toDate(sub.current_period_end || (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end));

/**
 * The free pack offered to someone about to cancel: only a monthly subscriber in good standing, whose plan has an offer,
 * with none pending, and not more than once every OFFER_COOLDOWN_DAYS. (An annual subscriber has nothing to "stay one more month" for.)
 * Returns the pack key or null.
 */
function offerFor(u) {
  if (!isSubscriber(u) || !u.stripe_subscription_id || u.billing_period !== "monthly") return null;
  const key = PLANS[u.plan] && PLANS[u.plan].retentionPack;
  if (!key || !PACKS[key] || u.retention_offer_pack) return null;
  if (u.retention_offer_used_at && Date.now() - new Date(u.retention_offer_used_at).getTime() < OFFER_COOLDOWN_DAYS * 86400000) return null;
  return key;
}

/** "Stay": the pack is promised now and added when the next monthly payment goes through, so staying is what earns it. */
async function acceptOffer(pool, user) {
  const u = await userRow(pool, user.id);
  const key = u && offerFor(u);
  if (!key) throw new HttpError(409, "There's no offer available on this account right now.", "no_offer");
  const { rowCount } = await pool.query("update users set retention_offer_pack = $2, retention_offer_used_at = now() where id = $1 and retention_offer_pack is null", [u.id, key]);
  if (!rowCount) throw new HttpError(409, "There's no offer available on this account right now.", "no_offer");
  return { pack: key, label: PACKS[key].label, minutes: PACKS[key].minutes };
}

/** Stop renewing: the plan stays until the period already paid for ends, then the account locks. */
async function cancelSubscription(pool, user) {
  const u = await userRow(pool, user.id);
  if (!u || !u.stripe_subscription_id) throw new HttpError(409, "There's no subscription to cancel on this account.", "no_subscription");
  if (u.plan_status === "canceling") return { ends_at: u.plan_renews_at };
  const sub = await stripe.call("POST", `/subscriptions/${encodeURIComponent(u.stripe_subscription_id)}`, { cancel_at_period_end: true });
  const ends = periodEnd(sub) || u.plan_renews_at;
  await pool.query("update users set plan_status = 'canceling', plan_renews_at = $2, retention_offer_pack = null where id = $1", [u.id, ends]);
  return { ends_at: ends };
}

/** Changed their mind before the period ended. */
async function resumeSubscription(pool, user) {
  const u = await userRow(pool, user.id);
  if (!u || !u.stripe_subscription_id || u.plan_status !== "canceling") throw new HttpError(409, "This subscription isn't set to end.", "not_canceling");
  await stripe.call("POST", `/subscriptions/${encodeURIComponent(u.stripe_subscription_id)}`, { cancel_at_period_end: false });
  await pool.query("update users set plan_status = 'active' where id = $1", [u.id]);
  return { ok: true };
}

// ── Stripe events ──────────────────────────────────────────────────────────────────────────────────────────
async function findUser(pool, { userId, customer, subscription }) {
  if (userId && UUID_RE.test(userId)) { const u = await userRow(pool, userId); if (u) return u; }
  if (subscription) { const { rows } = await pool.query("select * from users where stripe_subscription_id = $1", [subscription]); if (rows[0]) return rows[0]; }
  if (customer) { const { rows } = await pool.query("select * from users where stripe_customer_id = $1", [customer]); if (rows[0]) return rows[0]; }
  return null;
}

async function onCheckoutCompleted(pool, s) {
  const u = await findUser(pool, { userId: s.client_reference_id || (s.metadata && s.metadata.user_id), customer: s.customer });
  if (!u) { console.warn("[billing] checkout for an unknown account", s.id); return; }
  if (s.customer && !u.stripe_customer_id) await pool.query("update users set stripe_customer_id = $2 where id = $1 and stripe_customer_id is null", [u.id, s.customer]);
  if (s.mode === "payment") {
    if (s.payment_status !== "paid") return;
    await packs.grant(pool, u.id, s.metadata && s.metadata.pack, s.id);
    return;
  }
  if (s.mode === "subscription") {
    const plan = s.metadata && s.metadata.plan, period = s.metadata && s.metadata.period;
    if (!paidPlanNames().includes(plan) || !PERIODS.includes(period)) { console.warn("[billing] subscription checkout without a known plan", s.id); return; }
    // A new subscription also unlocks an account whose earlier one ended: everything it had is still there.
    await pool.query(
      "update users set plan = $2, billing_period = $3, stripe_subscription_id = $4, plan_status = 'active', locked_at = null where id = $1",
      [u.id, plan, period, s.subscription || null],
    );
  }
}

async function onSubscriptionChanged(pool, sub) {
  const u = await findUser(pool, { userId: sub.metadata && sub.metadata.user_id, customer: sub.customer, subscription: sub.id });
  if (!u) return;
  if (u.stripe_subscription_id && u.stripe_subscription_id !== sub.id) return;   // an older subscription: the current one wins
  if (ENDED.has(sub.status)) return endSubscription(pool, u.id, sub.status === "canceled" ? "canceled" : sub.status);
  if (!LIVE.has(sub.status)) return;                                              // incomplete: nothing is paid yet
  const price = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price;
  const found = catalog.lookupPrice(price && price.id);
  const plan = found && found.kind === "plan" ? found.plan : (sub.metadata && sub.metadata.plan);
  const period = found && found.kind === "plan" ? found.period : (sub.metadata && sub.metadata.period);
  if (!paidPlanNames().includes(plan)) return;
  const status = sub.cancel_at_period_end ? "canceling" : sub.status;
  await pool.query(
    `update users set plan = $2, billing_period = $3, stripe_subscription_id = $4, plan_status = $5, plan_renews_at = $6,
            stripe_customer_id = coalesce(stripe_customer_id, $7), locked_at = null,
            retention_offer_pack = case when $5 = 'canceling' then null else retention_offer_pack end
      where id = $1`,
    [u.id, plan, PERIODS.includes(period) ? period : u.billing_period, sub.id, status, periodEnd(sub), sub.customer || null],
  );
}

/**
 * The subscription is over. A paid account goes to the free plan AND is locked: its runs, clips, keys and top-up minutes are kept
 * untouched but cannot be reached until a subscription starts again.
 */
async function endSubscription(pool, userId, status) {
  await pool.query(
    `update users set locked_at = case when plan <> 'free' then coalesce(locked_at, now()) else locked_at end,
            plan = $2, billing_period = null, stripe_subscription_id = null, plan_status = $3, plan_renews_at = null, retention_offer_pack = null
      where id = $1`,
    [userId, DEFAULT_PLAN, status],
  );
}

async function onSubscriptionDeleted(pool, sub) {
  const u = await findUser(pool, { customer: sub.customer, subscription: sub.id });
  if (!u || u.stripe_subscription_id !== sub.id) return;                          // not the subscription this account is on
  await endSubscription(pool, u.id, "canceled");
}

async function onPaymentFailed(pool, invoice) {
  const sub = invoice.subscription || (invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription);
  if (!sub) return;
  await pool.query("update users set plan_status = 'past_due' where stripe_subscription_id = $1 and plan_status <> 'canceled'", [sub]);
}

/** A monthly renewal went through: if the account took the stay-another-month offer, the pack it was promised is added now. */
async function onInvoicePaid(pool, invoice) {
  const sub = invoice.subscription || (invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription);
  if (!sub || invoice.billing_reason !== "subscription_cycle") return;
  const { rows } = await pool.query("select id, retention_offer_pack from users where stripe_subscription_id = $1 and plan_status = 'active' and retention_offer_pack is not null", [sub]);
  const u = rows[0];
  if (!u) return;
  await packs.grant(pool, u.id, u.retention_offer_pack, `retention:${invoice.id}`);
  await pool.query("update users set retention_offer_pack = null where id = $1 and retention_offer_pack = $2", [u.id, u.retention_offer_pack]);
}

/** Handles one verified event once. A second delivery of the same id does nothing; a failure is un-recorded so Stripe's retry runs again. */
async function applyEvent(pool, event) {
  if (!event || !event.id || !event.type) return { handled: false, reason: "malformed" };
  const ins = await pool.query("insert into stripe_events (id, type) values ($1, $2) on conflict (id) do nothing", [event.id, event.type]);
  if (ins.rowCount === 0) return { handled: false, reason: "duplicate" };
  try {
    const obj = event.data && event.data.object;
    switch (event.type) {
      case "checkout.session.completed": case "checkout.session.async_payment_succeeded": await onCheckoutCompleted(pool, obj); break;
      case "customer.subscription.created": case "customer.subscription.updated": await onSubscriptionChanged(pool, obj); break;
      case "customer.subscription.deleted": await onSubscriptionDeleted(pool, obj); break;
      case "invoice.payment_failed": await onPaymentFailed(pool, obj); break;
      case "invoice.paid": await onInvoicePaid(pool, obj); break;
      default: return { handled: false, reason: "ignored" };
    }
    return { handled: true };
  } catch (e) {
    await pool.query("delete from stripe_events where id = $1", [event.id]).catch(() => {});
    throw e;
  }
}

/** The account's billing state for the page. */
async function billingState(pool, userId) {
  const u = await userRow(pool, userId);
  const offerKey = offerFor(u);
  const pending = u.retention_offer_pack && PACKS[u.retention_offer_pack];
  const state = {
    period: u.billing_period || null, status: u.plan_status || null, renews_at: u.plan_renews_at || null,
    can_manage: !!u.stripe_customer_id, can_buy_packs: isSubscriber(u),
    pack_minutes: Math.round((await packs.remaining(pool, userId)) * 10) / 10,
    offer: offerKey ? { pack: offerKey, label: PACKS[offerKey].label, minutes: PACKS[offerKey].minutes } : null,
    offer_pending: pending ? { label: pending.label, minutes: pending.minutes } : null,
    locked: !!u.locked_at,
  };
  if (u.locked_at) {
    const runs = (await pool.query("select count(*)::int as n from meme_builder_jobs where owner_id = $1", [userId])).rows[0].n;
    state.saved = { pack_minutes: Math.round((await packs.saved(pool, userId)) * 10) / 10, runs };
  }
  return state;
}

module.exports = { startCheckout, openPortal, acceptOffer, cancelSubscription, resumeSubscription, applyEvent, billingState, hasLiveSubscription, isSubscriber, offerFor, OFFER_COOLDOWN_DAYS };
