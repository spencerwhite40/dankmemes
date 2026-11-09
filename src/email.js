"use strict";
// Sending email. One small interface, three real backends, picked by what is configured:
//   RESEND_API_KEY            -> Resend       (EMAIL_FROM must be an address on a domain verified there)
//   POSTMARK_SERVER_TOKEN     -> Postmark     (EMAIL_FROM must be a verified sender)
//   EMAIL_PROVIDER=memory     -> kept in memory (tests)
//   nothing                   -> not configured: nothing is sent, and email verification is not required
// EMAIL_PROVIDER=resend|postmark|memory|none forces one. Keys are typed into the host's settings, never committed.
const outbox = [];   // the "memory" provider's sent mail (tests read this)

const appName = () => process.env.APP_NAME || "Meme Builder";
function provider() {
  const forced = (process.env.EMAIL_PROVIDER || "").toLowerCase();
  if (["resend", "postmark", "memory", "none"].includes(forced)) return forced;
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.POSTMARK_SERVER_TOKEN) return "postmark";
  return "none";
}
const configured = () => provider() !== "none";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function post(url, headers, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`email provider answered ${res.status}: ${text.slice(0, 200)}`);
  }
}

/** Sends one message. Throws if the provider refuses it; resolves quietly when email isn't configured. */
async function send({ to, subject, text, html }) {
  const p = provider();
  const from = process.env.EMAIL_FROM || "";
  if (p === "none") {
    // In development, show the message (it holds the sign-in link). Never in production: logs would hold live tokens.
    if (process.env.NODE_ENV !== "production") console.log(`[email] (not configured, not sent) to ${to}: ${subject}\n${text}`);
    return { sent: false };
  }
  if (p === "memory") { outbox.push({ to, subject, text, html, from }); return { sent: true }; }
  if (!from) throw new Error("EMAIL_FROM is not set");
  if (p === "resend") await post("https://api.resend.com/emails", { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, { from, to: [to], subject, text, html });
  else await post("https://api.postmarkapp.com/email", { "X-Postmark-Server-Token": process.env.POSTMARK_SERVER_TOKEN, Accept: "application/json" }, { From: from, To: to, Subject: subject, TextBody: text, HtmlBody: html, MessageStream: process.env.POSTMARK_STREAM || "outbound" });
  return { sent: true };
}

const wrap = (inner) => `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#161616;max-width:520px">${inner}<p style="color:#6b6b6b;font-size:13px">${esc(appName())}</p></div>`;
const button = (link, label) => `<p><a href="${esc(link)}" style="display:inline-block;background:#111;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600">${esc(label)}</a></p><p style="color:#6b6b6b;font-size:13px">Or paste this into your browser:<br>${esc(link)}</p>`;

function verificationMessage({ name, link }) {
  const hi = name ? `Hi ${name},` : "Hi,";
  return {
    subject: `Confirm your email for ${appName()}`,
    text: `${hi}\n\nConfirm your email address to start making clips:\n${link}\n\nThe link works for 3 days. If you didn't create an account, you can ignore this email.\n\n${appName()}`,
    html: wrap(`<p>${esc(hi)}</p><p>Confirm your email address to start making clips.</p>${button(link, "Confirm my email")}<p>The link works for 3 days. If you didn't create an account, you can ignore this email.</p>`),
  };
}
function resetMessage({ name, link }) {
  const hi = name ? `Hi ${name},` : "Hi,";
  return {
    subject: `Reset your ${appName()} password`,
    text: `${hi}\n\nSomeone asked to reset the password for this account. To choose a new one:\n${link}\n\nThe link works for 1 hour and only once. If it wasn't you, ignore this email: your password has not changed.\n\n${appName()}`,
    html: wrap(`<p>${esc(hi)}</p><p>Someone asked to reset the password for this account.</p>${button(link, "Choose a new password")}<p>The link works for 1 hour and only once. If it wasn't you, ignore this email: your password has not changed.</p>`),
  };
}

module.exports = { send, configured, provider, outbox, verificationMessage, resetMessage, appName, esc };
