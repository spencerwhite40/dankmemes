"use strict";
// dankmemes: one Express app (API + the web page) and, unless MEME_BUILDER_RUNNER=off, the job runner in the same process.
// For more speed, run the runner on its own machine instead: set MEME_BUILDER_RUNNER=off on the web app and run `npm run worker` there.
const path = require("node:path");
const express = require("express");

const { makePool } = require("./db");
const { migrate } = require("./migrate");
const { requireUser, requireActiveUser, registerAuthRoutes } = require("./auth");
const { registerAccountRoutes } = require("./account-routes");
const { registerMemeBuilderRoutes } = require("./routes");
const { startMemeBuilderWorker } = require("./worker");
const { asyncRoute } = require("./async-route");
const { buildV1 } = require("./v1");
const { registerBillingWebhook, registerBillingRoutes } = require("./billing/routes");
const { registerDataRoutes } = require("./data-routes");
const legal = require("./legal");
const mail = require("./email");
const alerts = require("./alerts");
const { PLANS } = require("./plans");

const PUBLIC = path.join(__dirname, "..", "public");
const fs = require("node:fs");
const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const siteBase = (req) => (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
/** The landing page, with its share-preview links made absolute (link previews ignore a relative og:image). */
let landingHtml = null;
function landingPage(req) {
  if (!landingHtml) landingHtml = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  const base = escAttr(siteBase(req));
  return landingHtml
    .replace('content="/og.png"', `content="${base}/og.png"`)
    .replace('<meta name="twitter:card"', `<meta property="og:url" content="${base}/">\n  <link rel="canonical" href="${base}/">\n  <meta name="twitter:card"`);
}
/** Headers every response gets: no MIME sniffing, no framing by other sites, a modest referrer, HTTPS-only once served over HTTPS. */
function securityHeaders(req, res, next) {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "SAMEORIGIN");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (req.secure && process.env.NODE_ENV === "production") res.set("Strict-Transport-Security", "max-age=15552000");
  next();
}
const ROBOTS = "User-agent: *\nDisallow: /app\nDisallow: /api/\nDisallow: /v1/\nDisallow: /billing/\n";
const NOT_FOUND = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found · dankmemes</title><meta name="robots" content="noindex"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/styles.css"></head>
<body><header class="bar"><div class="wrap"><a class="logo" href="/" aria-label="dankmemes home"><span class="d">dank</span><span class="m">memes</span></a></div></header>
<main class="wrap main" style="padding:80px 0;text-align:center"><h1>404, <span class="tag">nothing here</span></h1>
<p class="muted">That page got deleted, or it never existed.</p><p><a class="btn" href="/">Back to the start</a></p></main></body></html>`;
/** Every plan's headline numbers, for the price cards on the landing page (src/plans.js is the only source). */
const publicPricing = () => ({
  plans: Object.entries(PLANS).map(([name, p]) => ({
    name, label: p.label, minutes: p.monthlyMinutes, price_monthly: p.priceMonthly, price_annual: p.priceAnnual,
    max_video_minutes: p.maxVideoMinutes, clips_per_run: p.clipsPerRun, retention_days: p.retentionDays,
    concurrent_runs: p.concurrentRuns, watermark: !!p.watermark, api_access: !!p.apiAccess,
  })),
});

function buildApp(pool) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);          // behind Render/Fly's proxy, so req.ip is the visitor (login rate limits depend on it)
  app.use(securityHeaders);
  registerBillingWebhook(app, { pool });   // before the JSON parser: the signature is over the raw bytes
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/pricing", (_req, res) => res.json(publicPricing()));   // the landing page's price cards; no sign-in
  app.get("/", (req, res) => res.type("html").set("Cache-Control", "no-cache").send(landingPage(req)));
  app.get("/app", (_req, res) => res.sendFile(path.join(PUBLIC, "app.html")));
  app.get("/robots.txt", (_req, res) => res.type("text/plain").send(ROBOTS));
  const needUser = requireUser(pool);              // signed in (a locked account may still reach billing)
  const needActive = requireActiveUser(pool);      // signed in and not locked: for media, runs, keys
  registerAuthRoutes(app, { pool, asyncRoute });
  registerAccountRoutes(app, { pool, asyncRoute, requireUser: needActive });
  registerBillingRoutes(app, { pool, asyncRoute, requireUser: needUser });
  registerDataRoutes(app, { pool, asyncRoute, requireUser: needUser, requireActive: needActive });
  registerMemeBuilderRoutes(app, { asyncRoute, pool, requireAdmin: needActive });
  app.use("/v1", buildV1(pool));            // the public API (API-key auth); see docs/api.md

  legal.registerLegalRoutes(app);           // /terms /privacy /refunds /copyright
  app.use("/fonts", express.static(path.join(PUBLIC, "fonts"), { maxAge: "365d", immutable: true }));
  app.use(express.static(PUBLIC, { index: false }));
  // A branded page for any other address someone opens in a browser; API callers still get JSON.
  app.use((req, res, next) => {
    if (req.method !== "GET" || /^\/(api|v1|billing)\//.test(req.path) || !req.accepts("html")) return next();
    res.status(404).type("html").send(NOT_FOUND);
  });
  // JSON errors for the API, so the page can show a plain message.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error("[server]", err && err.stack || err);
    res.status(err && err.status ? err.status : 500).json({ error: (err && err.message) || "Something went wrong." });
  });
  return app;
}

async function main() {
  alerts.watchProcess("web");
  const pool = makePool();
  await migrate(pool);
  require("./lib/ai").ledger.setPool(pool);
  // Things that must be settled before real customers arrive; said loudly in production, never fatal.
  if (process.env.NODE_ENV === "production") {
    if (!mail.configured()) console.warn("[setup] No email provider (RESEND_API_KEY or POSTMARK_SERVER_TOKEN): email verification and password reset are OFF.");
    if (mail.configured() && !process.env.EMAIL_FROM) console.warn("[setup] EMAIL_FROM is not set: no email can be sent.");
    if (!process.env.APP_URL) console.warn("[setup] APP_URL is not set: links in emails and Stripe redirects will use the request's host.");
    if (legal.missing().length) console.warn(`[setup] Legal pages still have placeholders. Set: ${legal.missing().join(", ")}`);
    if (!legal.reviewed()) console.warn("[setup] Legal pages are drafts (shown with a banner). Set LEGAL_REVIEWED=yes once a lawyer has reviewed them.");
  }
  const app = buildApp(pool);
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`dankmemes listening on :${port}`));
  startMemeBuilderWorker(pool);
  // Starts a Fly processing machine for each waiting run (src/lib/scaler.js); off unless FLY_API_TOKEN and FLY_WORKER_APP are set.
  const scaler = require("./lib/scaler");
  scaler.startScaler(pool);
  if (process.env.NODE_ENV === "production" && (process.env.MEME_BUILDER_RUNNER || "").toLowerCase() === "off" && !scaler.configured()) {
    console.warn("[setup] Runs are processed elsewhere but FLY_API_TOKEN / FLY_WORKER_APP are not set: keep the processing machine always on (no WORKER_IDLE_EXIT_SECONDS), or runs will wait.");
  }
  require("./retention").startRetention(pool);
}

module.exports = { buildApp };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
