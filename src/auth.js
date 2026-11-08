"use strict";
// The simplest thing that keeps strangers out of a tool that spends money: one shared password (APP_PASSWORD)
// and a signed cookie. Replace with real accounts when this becomes a multi-user product.
const crypto = require("node:crypto");

const COOKIE = "mb_session";
const MAX_AGE_SEC = 30 * 24 * 3600;
const secret = () => process.env.SESSION_SECRET || process.env.APP_PASSWORD || "dev-secret";
const sign = (v) => crypto.createHmac("sha256", secret()).update(v).digest("hex");

function makeToken(now = Date.now()) {
  const exp = String(Math.floor(now / 1000) + MAX_AGE_SEC);
  return `${exp}.${sign(exp)}`;
}
function validToken(token, now = Date.now()) {
  const [exp, mac] = String(token || "").split(".");
  if (!exp || !mac || !/^\d+$/.test(exp)) return false;
  const want = sign(exp);
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return false;
  return Number(exp) * 1000 > now;
}
const readCookie = (req) => {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || "");
  return m ? decodeURIComponent(m[1]) : "";
};
const authEnabled = () => !!process.env.APP_PASSWORD;

/** Middleware: lets the request through when no password is configured (local dev) or the cookie is valid. */
function requireLogin(req, res, next) {
  if (!authEnabled() || validToken(readCookie(req))) return next();
  return res.status(401).json({ error: "Please sign in." });
}

function registerAuthRoutes(app) {
  app.post("/login", (req, res) => {
    const given = String((req.body && req.body.password) || "");
    const want = process.env.APP_PASSWORD || "";
    const a = Buffer.from(given), b = Buffer.from(want);
    if (!authEnabled() || (a.length === b.length && crypto.timingSafeEqual(a, b))) {
      const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
      res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(makeToken())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SEC}${secure}`);
      return res.json({ ok: true });
    }
    return res.status(401).json({ error: "That's not the password." });
  });
  app.post("/logout", (_req, res) => {
    res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });
  app.get("/api/me", (req, res) => res.json({ signedIn: !authEnabled() || validToken(readCookie(req)), authEnabled: authEnabled() }));
}

module.exports = { requireLogin, registerAuthRoutes, makeToken, validToken };
