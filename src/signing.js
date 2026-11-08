"use strict";
// Expiring playback links, so a <video> tag can play a clip without an Authorization header and without exposing storage.
const crypto = require("node:crypto");

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s && process.env.NODE_ENV === "production") throw new Error("SESSION_SECRET is required to sign playback links.");
  return s || "dev-secret";
}
const mac = (clipId, exp) => crypto.createHmac("sha256", secret()).update(`clip:${clipId}:${exp}`).digest("hex");

/** { exp, sig } valid for ttlSec seconds. */
function signClip(clipId, { ttlSec = 3600, now = Date.now() } = {}) {
  const exp = Math.floor(now / 1000) + ttlSec;
  return { exp, sig: mac(clipId, exp) };
}

function verifyClip(clipId, exp, sig, now = Date.now()) {
  if (!/^\d+$/.test(String(exp || "")) || typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return false;
  if (Number(exp) * 1000 < now) return false;
  const want = mac(clipId, exp);
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}

module.exports = { signClip, verifyClip };
