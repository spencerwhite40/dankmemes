"use strict";
// Signing up, signing in, and knowing who is making a request. A session is a random token in an HttpOnly cookie.
const accounts = require("./accounts");
const { createLimiter } = require("./ratelimit");
const { HttpError } = require("./errors");

const COOKIE = "mb_session";
const MAX_AGE_SEC = accounts.SESSION_DAYS * 24 * 3600;

const readCookie = (req) => {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || "");
  return m ? decodeURIComponent(m[1]) : "";
};
const setCookie = (res, token) => {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${token ? MAX_AGE_SEC : 0}${secure}`);
};

/** Middleware: the signed-in user is req.user, or the request is refused with 401. */
function requireUser(pool) {
  return async (req, res, next) => {
    try {
      const user = await accounts.userForSession(pool, readCookie(req));
      if (!user) return res.status(401).json({ error: "Please sign in.", code: "signed_out" });
      req.user = accounts.userOut(user);
      next();
    } catch (e) { next(e); }
  };
}

function registerAuthRoutes(app, { pool, asyncRoute }) {
  // Slows password guessing: 8 tries per email+address per 15 minutes, and 30 sign-ups an hour per address.
  const loginLimiter = createLimiter({ windowMs: 15 * 60 * 1000 });
  const signupLimiter = createLimiter({ windowMs: 60 * 60 * 1000 });
  const handle = (fn) => asyncRoute(async (req, res, next) => {
    try { await fn(req, res, next); } catch (e) { if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, code: e.code }); throw e; }
  });

  app.post("/auth/signup", handle(async (req, res) => {
    const gate = signupLimiter.check(`ip:${req.ip}`, 30);
    if (!gate.ok) throw new HttpError(429, "Too many sign-ups from here. Try again later.", "rate_limited");
    const b = req.body || {};
    const user = await accounts.signup(pool, { email: b.email, password: b.password, name: b.name });
    setCookie(res, await accounts.createSession(pool, user.id, req.headers["user-agent"]));
    res.status(201).json({ user: accounts.userOut(user) });
  }));

  app.post("/auth/login", handle(async (req, res) => {
    const b = req.body || {};
    const id = `${req.ip}|${accounts.normEmail(b.email)}`;
    const gate = loginLimiter.check(id, 8);
    if (!gate.ok) { res.set("Retry-After", String(gate.retryAfterSec)); throw new HttpError(429, "Too many attempts. Wait a few minutes and try again.", "rate_limited"); }
    const user = await accounts.authenticate(pool, b.email, b.password);
    if (!user) throw new HttpError(401, "That email and password don't match.", "bad_login");
    loginLimiter.reset(id);
    setCookie(res, await accounts.createSession(pool, user.id, req.headers["user-agent"]));
    res.json({ user: accounts.userOut(user) });
  }));

  app.post("/auth/logout", asyncRoute(async (req, res) => {
    await accounts.endSession(pool, readCookie(req));
    setCookie(res, "");
    res.json({ ok: true });
  }));

  // Always answers 200 so the page can decide what to show; signedIn says whether there is a session.
  app.get("/api/me", asyncRoute(async (req, res) => {
    const user = await accounts.userForSession(pool, readCookie(req));
    if (!user) return res.json({ signedIn: false, signupsOpen: (process.env.SIGNUPS || "open").toLowerCase() !== "closed" });
    res.json({ signedIn: true, user: accounts.userOut(user), ...(await accounts.usageSnapshot(pool, user.id)) });
  }));
}

module.exports = { requireUser, registerAuthRoutes, readCookie };
