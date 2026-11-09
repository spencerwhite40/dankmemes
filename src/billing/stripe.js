"use strict";
// A small Stripe client with no SDK: form-encoded calls to the REST API, and webhook signature checking.
const crypto = require("node:crypto");
const { HttpError } = require("../errors");

const API = "https://api.stripe.com/v1";
const secretKey = () => process.env.STRIPE_SECRET_KEY || "";
const enabled = () => !!secretKey();

/** Stripe wants nested values as a[b][0]=c. */
function encode(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (item && typeof item === "object" ? encode(item, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`)));
    else if (typeof v === "object") encode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

async function call(method, path, params) {
  if (!enabled()) throw new HttpError(503, "Billing isn't set up yet.", "billing_off");
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${secretKey()}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: method === "GET" ? undefined : encode(params).join("&"),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) {
    console.error("[stripe]", method, path, res.status, json && json.error ? json.error.message : text.slice(0, 200));
    throw new HttpError(502, "The payment provider didn't accept that. Try again in a moment.", "billing_error");
  }
  return json;
}

/**
 * Checks the Stripe-Signature header against the raw request body and returns the parsed event.
 * The header looks like t=1700000000,v1=<hex>; the signed text is `${t}.${body}`, signed with the webhook secret (HMAC-SHA256).
 * Events older than the tolerance are refused so a captured request can't be replayed later.
 */
function verifyWebhook(rawBody, header, secret, { now = Date.now(), toleranceSec = 300 } = {}) {
  if (!secret) throw new HttpError(503, "Webhook secret isn't set.", "billing_off");
  const parts = String(header || "").split(",").map((p) => p.trim().split("="));
  const t = (parts.find((p) => p[0] === "t") || [])[1];
  const sigs = parts.filter((p) => p[0] === "v1").map((p) => p[1]);
  if (!t || !sigs.length) throw new HttpError(400, "Missing signature.", "bad_signature");
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""));
  const want = crypto.createHmac("sha256", secret).update(`${t}.`).update(body).digest();
  const ok = sigs.some((s) => { const got = Buffer.from(s, "hex"); return got.length === want.length && crypto.timingSafeEqual(got, want); });
  if (!ok) throw new HttpError(400, "Bad signature.", "bad_signature");
  if (Math.abs(now / 1000 - Number(t)) > toleranceSec) throw new HttpError(400, "Signature too old.", "bad_signature");
  try { return JSON.parse(body.toString("utf8")); } catch { throw new HttpError(400, "Bad body.", "bad_body"); }
}

/** For tests and tooling: sign a body the way Stripe does. */
function signPayload(body, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

module.exports = { enabled, call, encode, verifyWebhook, signPayload };
