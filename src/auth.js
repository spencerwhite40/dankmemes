"use strict";
// Signing up, signing in, and knowing who is making a request. A session is a random token in an HttpOnly cookie.
const accounts = require("./accounts");
const mail = require("./email");
const tokens = require("./tokens");
const stripe = require("./billing/stripe");
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

/** Like requireUser, but a locked account (its subscription ended) gets 402: its media and credits are kept, not reachable. */
function requireActiveUser(pool) {
  const base = requireUser(pool);
  return (req, res, next) => base(req, res, (err) => {
    if (err) return next(err);
    if (req.user.locked) return res.status(402).json({ error: "Your subscription has ended. Subscribe again to get your videos, clips and credits back.", code: "account_locked" });
    next();
  });
}

function registerAuthRoutes(app, { pool, asyncRoute }) {
  // Slows password guessing: 8 tries per email+address per 15 minutes, and 30 sign-ups an hour per address.
  const loginLimiter = createLimiter({ windowMs: 15 * 60 * 1000 });
  const signupLimiter = createLimiter({ windowMs: 60 * 60 * 1000 });
  const handle = (fn) => asyncRoute(async (req, res, next) => {
    try { await fn(req, res, next); } catch (e) { if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, code: e.code }); throw e; }
  });

  // ── email: confirming an address and choosing a new password ──────────────────────────────────────
  const hourly = () => createLimiter({ windowMs: 60 * 60 * 1000 });
  const forgotByIp = hourly(), forgotByEmail = hourly(), resendByUser = hourly(), resetByIp = hourly(), verifyByIp = hourly();
  const baseUrl = (req) => (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
  const logFail = (what) => (e) => console.error(`[auth] ${what} email failed:`, e && e.message);
  const sendVerification = async (user, req) => {
    const token = await tokens.create(pool, user.id, "verify");
    await mail.send({ to: user.email, ...mail.verificationMessage({ name: user.name, link: `${baseUrl(req)}/?verify=${token}` }) });
  };

  app.post("/auth/signup", handle(async (req, res) => {
    const gate = signupLimiter.check(`ip:${req.ip}`, 30);
    if (!gate.ok) throw new HttpError(429, "Too many sign-ups from here. Try again later.", "rate_limited");
    const b = req.body || {};
    if (b.accept_terms !== true) throw new HttpError(400, "Please agree to the Terms and the Privacy Policy to create an account.", "terms_required");
    const user = await accounts.signup(pool, { email: b.email, password: b.password, name: b.name, acceptedTerms: true });
    setCookie(res, await accounts.createSession(pool, user.id, req.headers["user-agent"]));
    if (mail.configured()) await sendVerification(user, req).catch(logFail("verification"));   // the account exists either way; they can ask again
    res.status(201).json({ user: accounts.userOut(user) });
  }));

  // One link type for both: confirming a new account's address, and confirming the new address of an email change.
  app.post("/auth/verify", handle(async (req, res) => {
    const gate = verifyByIp.check(`ip:${req.ip}`, 60);
    if (!gate.ok) throw new HttpError(429, "Too many attempts. Try again later.", "rate_limited");
    const token = (req.body || {}).token;
    const userId = await tokens.consume(pool, token, "verify");
    if (userId) { await accounts.markVerified(pool, userId); return res.json({ ok: true }); }
    const change = await tokens.consumeRow(pool, token, "email_change");
    if (!change) throw new HttpError(400, "This link is invalid or has expired. Sign in and ask for a new one.", "bad_token");
    try {
      await pool.query("update users set email = $2, email_verified_at = now() where id = $1", [change.userId, change.payload]);
    } catch (e) {
      if (e && e.code === "23505") throw new HttpError(409, "Someone else has taken that address in the meantime. Ask for a change to a different one.", "email_taken");
      throw e;
    }
    // Keep the payment provider's copy of the address in step, so receipts go to the right place (best effort).
    const { rows } = await pool.query("select stripe_customer_id from users where id = $1", [change.userId]);
    if (rows[0] && rows[0].stripe_customer_id && stripe.enabled()) await stripe.call("POST", `/customers/${encodeURIComponent(rows[0].stripe_customer_id)}`, { email: change.payload }).catch(logFail("stripe customer"));
    res.json({ ok: true, email_changed: true });
  }));

  // ── changing your own password or email address (you must be signed in and know your password) ──────
  const securityByUser = hourly();
  const checkPassword = async (userId, password) => {
    const { rows } = await pool.query("select password_hash from users where id = $1", [userId]);
    if (!rows[0] || !(await accounts.verifyPassword(String(password || ""), rows[0].password_hash))) throw new HttpError(403, "That password isn't right.", "bad_password");
  };

  app.post("/account/password", requireUser(pool), handle(async (req, res) => {
    if (!securityByUser.check(req.user.id, 10).ok) throw new HttpError(429, "Too many attempts. Try again in an hour.", "rate_limited");
    const b = req.body || {};
    await checkPassword(req.user.id, b.current_password);
    if (typeof b.new_password !== "string" || b.new_password.length < 10) throw new HttpError(400, "Choose a new password of at least 10 characters.", "weak_password");
    if (b.new_password.length > 200) throw new HttpError(400, "That password is too long.", "bad_password");
    if (b.new_password === b.current_password) throw new HttpError(400, "That's the same as your current password.", "same_password");
    await accounts.setPassword(pool, req.user.id, b.new_password);                // signs every device out...
    setCookie(res, await accounts.createSession(pool, req.user.id, req.headers["user-agent"]));   // ...except this one
    if (mail.configured()) mail.send({ to: req.user.email, ...mail.passwordChangedNotice({ name: req.user.name }) }).catch(logFail("password notice"));
    res.json({ ok: true });
  }));

  app.post("/account/email", requireUser(pool), handle(async (req, res) => {
    if (!securityByUser.check(req.user.id, 10).ok) throw new HttpError(429, "Too many attempts. Try again in an hour.", "rate_limited");
    const b = req.body || {};
    await checkPassword(req.user.id, b.password);
    const next = accounts.normEmail(b.new_email);
    if (!accounts.validEmail(next)) throw new HttpError(400, "Enter a valid email address.", "bad_email");
    if (next === accounts.normEmail(req.user.email)) throw new HttpError(400, "That's already your email address.", "same_email");
    if (!mail.configured()) throw new HttpError(503, "Changing your email needs email to be set up on this server. Contact support.", "email_off");
    if ((await pool.query("select 1 from users where lower(email) = $1", [next])).rowCount) throw new HttpError(409, "There's already an account with that email.", "email_taken");
    const token = await tokens.create(pool, req.user.id, "email_change", { payload: next });
    await mail.send({ to: next, ...mail.emailChangeMessage({ name: req.user.name, newEmail: next, link: `${baseUrl(req)}/?verify=${token}` }) })
      .catch((e) => { logFail("email change")(e); throw new HttpError(502, "We couldn't send the email just now. Try again in a minute.", "email_failed"); });
    mail.send({ to: req.user.email, ...mail.emailChangeNotice({ name: req.user.name, newEmail: next }) }).catch(logFail("email change notice"));
    res.json({ ok: true, pending: true, message: `We sent a confirmation link to ${next}. Your email changes when you open it.` });
  }));

  app.post("/auth/resend-verification", requireUser(pool), handle(async (req, res) => {
    if (req.user.email_verified) return res.json({ ok: true, already: true });
    if (!mail.configured()) throw new HttpError(503, "Email isn't set up on this server.", "email_off");
    const gate = resendByUser.check(req.user.id, 3);
    if (!gate.ok) { res.set("Retry-After", String(gate.retryAfterSec)); throw new HttpError(429, "That's enough emails for now. Check your inbox and spam folder, or try again in a while.", "rate_limited"); }
    await sendVerification(req.user, req).catch((e) => { logFail("verification")(e); throw new HttpError(502, "We couldn't send the email just now. Try again in a minute.", "email_failed"); });
    res.json({ ok: true });
  }));

  // Always the same answer, whether or not the address has an account, so this can't be used to find out who is registered.
  app.post("/auth/forgot", handle(async (req, res) => {
    if (!mail.configured()) throw new HttpError(503, "Password reset by email isn't set up yet. Contact support.", "email_off");
    const email = accounts.normEmail((req.body || {}).email);
    if (!email) throw new HttpError(400, "Enter your email address.", "bad_email");
    if (!forgotByIp.check(`ip:${req.ip}`, 10).ok || !forgotByEmail.check(email, 3).ok) throw new HttpError(429, "Too many requests. Try again in an hour.", "rate_limited");
    const { rows } = await pool.query("select id, email, name from users where lower(email) = $1", [email]);
    if (rows[0]) {
      const user = rows[0];
      tokens.create(pool, user.id, "reset")
        .then((token) => mail.send({ to: user.email, ...mail.resetMessage({ name: user.name, link: `${baseUrl(req)}/?reset=${token}` }) }))
        .catch(logFail("reset"));                      // not awaited: a real account and an unknown one answer equally fast
    }
    res.json({ ok: true });
  }));

  app.post("/auth/reset", handle(async (req, res) => {
    if (!resetByIp.check(`ip:${req.ip}`, 20).ok) throw new HttpError(429, "Too many attempts. Try again later.", "rate_limited");
    const b = req.body || {};
    if (typeof b.password !== "string" || b.password.length < 10) throw new HttpError(400, "Choose a password of at least 10 characters.", "weak_password");
    if (b.password.length > 200) throw new HttpError(400, "That password is too long.", "bad_password");
    const userId = await tokens.consume(pool, b.token, "reset");    // after the password check, so a typo doesn't use up the link
    if (!userId) throw new HttpError(400, "This link is invalid or has expired. Ask for a new one.", "bad_token");
    await accounts.setPassword(pool, userId, b.password);           // also signs them out everywhere
    await accounts.markVerified(pool, userId);                     // they just proved they own the inbox
    res.json({ ok: true });
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
    res.json({ signedIn: true, user: accounts.userOut(user), verification_required: accounts.verificationRequired(), ...(await accounts.usageSnapshot(pool, user.id)), billing: await require("./billing/service").billingState(pool, user.id) });
  }));
}

module.exports = { requireUser, requireActiveUser, registerAuthRoutes, readCookie };
