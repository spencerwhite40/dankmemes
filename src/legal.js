"use strict";
// The legal pages: /terms, /privacy, /refunds, /copyright. Templates live in legal/*.html with {{PLACEHOLDERS}}
// that are filled from the environment. These are DRAFTS: until LEGAL_REVIEWED=yes every page carries a visible
// "draft" banner, so they can't go out unreviewed by accident. See docs/legal.md.
const fs = require("node:fs");
const path = require("node:path");
const { esc, appName } = require("./email");

const PAGES = { terms: "Terms of Service", privacy: "Privacy Policy", refunds: "Refund Policy", copyright: "Copyright and Takedown Policy" };
const UPDATED = "November 9, 2026";

// what each placeholder is filled from, and what shows when it isn't set (obviously a placeholder, so it can't be missed)
const FIELDS = {
  COMPANY: ["COMPANY_NAME", "[Company name]"],
  COMPANY_ADDRESS: ["COMPANY_ADDRESS", "[Company mailing address]"],
  SUPPORT_EMAIL: ["SUPPORT_EMAIL", "[support email]"],
  COPYRIGHT_EMAIL: ["COPYRIGHT_EMAIL", "[copyright agent email]"],
  JURISDICTION: ["LEGAL_JURISDICTION", "[State/country whose law applies]"],
};
const values = () => ({
  APP_NAME: appName(), UPDATED,
  ...Object.fromEntries(Object.entries(FIELDS).map(([k, [env, fallback]]) => [k, process.env[env] || fallback])),
});
/** Environment variables that still need a value before these pages are fit to publish. */
const missing = () => Object.values(FIELDS).filter(([env]) => !process.env[env]).map(([env]) => env);
const reviewed = () => (process.env.LEGAL_REVIEWED || "").toLowerCase() === "yes";

const template = (name) => fs.readFileSync(path.join(__dirname, "..", "legal", `${name}.html`), "utf8");

function render(name) {
  if (!PAGES[name]) return null;
  const v = values();
  const body = template(name).replace(/\{\{([A-Z_]+)\}\}/g, (_m, k) => (k in v ? esc(v[k]) : ""));
  const draft = reviewed() ? "" : `<p class="draft-banner"><strong>Draft.</strong> This page has not been reviewed by a lawyer yet and is not final.</p>`;
  const nav = Object.entries(PAGES).map(([k, t]) => `<a href="/${k}">${esc(t)}</a>`).join(" · ");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(PAGES[name])} - ${esc(v.APP_NAME)}</title><link rel="stylesheet" href="/styles.css"></head>
<body><header class="top"><h1><a href="/" style="color:inherit;text-decoration:none">${esc(v.APP_NAME)}</a></h1></header>
<main class="legal">${draft}<h2>${esc(PAGES[name])}</h2><p class="muted">Last updated ${esc(UPDATED)}</p>${body}
<hr><p class="muted">${nav}</p></main></body></html>`;
}

function registerLegalRoutes(app) {
  for (const name of Object.keys(PAGES)) app.get(`/${name}`, (_req, res) => res.type("html").send(render(name)));
}

module.exports = { registerLegalRoutes, render, missing, reviewed, PAGES, FIELDS };
