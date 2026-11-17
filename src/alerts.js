"use strict";
// A message to you when something important breaks. Off until ALERT_WEBHOOK_URL is set; then each alert is POSTed there as JSON
// {"text": "...", "content": "..."}, which Slack (text) and Discord (content) incoming webhooks both accept. Needs no account in the app itself.
// The same kind of alert is sent at most once every 10 minutes, so a broken thing is one message, not a flood. Never throws.
const WINDOW_MS = 10 * 60 * 1000;
const lastSent = new Map();

const configured = () => !!process.env.ALERT_WEBHOOK_URL;
function reset() { lastSent.clear(); }

/** kind: a short stable label ("out_of_credit:google"); message: what happened. Returns true if a message was sent. */
async function alert(kind, message, { windowMs = WINDOW_MS, now = Date.now() } = {}) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return false;
  if (now - (lastSent.get(kind) || 0) < windowMs) return false;
  lastSent.set(kind, now);
  const text = `[${process.env.APP_NAME || "Meme Builder"}${process.env.NODE_ENV ? ` ${process.env.NODE_ENV}` : ""}] ${kind}: ${String(message || "").slice(0, 500)}`;
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch { return false; }
}

/** Last-resort handlers: something nobody caught. Logs it, tells you, and (for a crash) lets the process exit so the host restarts it. */
function watchProcess(name) {
  process.on("unhandledRejection", (reason) => { console.error(`[${name}] unhandled rejection:`, reason && reason.stack || reason); alert(`${name}:unhandled_rejection`, reason && reason.message || String(reason)); });
  process.on("uncaughtException", (err) => {
    console.error(`[${name}] uncaught exception:`, err && err.stack || err);
    alert(`${name}:crash`, err && err.message || String(err)).finally(() => process.exit(1));
    setTimeout(() => process.exit(1), 6000).unref();
  });
}

module.exports = { alert, configured, reset, watchProcess, WINDOW_MS };
