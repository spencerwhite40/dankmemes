"use strict";
// The studio: drop a video, pick who it's for, make clips, watch them arrive. Plain JS, no build step.
const $ = (id) => document.getElementById(id);
const API = "/api";
const STEPS = [
  ["fetch", "Getting the video"], ["prepare", "Preparing"], ["upload", "Uploading"], ["analyze", "Watching it"],
  ["captions", "Writing captions"], ["verify", "Checking each clip"], ["render", "Rendering clips"],
];
const stepIndex = (stage) => ({ starting: 0, fetch: 0, prepare: 1, upload: 2, analyze: 3, analyzed: 3, captions: 4, selected: 4, verify: 5, render: 6, done: 7 }[stage] ?? -1);
// Something to read while it works. One line per stage, in the brand's voice.
const QUIPS = {
  queued: "Waiting in line behind the other degenerates…",
  0: "Grabbing the tape…", 1: "Stretching the pixels…", 2: "Sending it to the robot…",
  3: "Watching the whole thing. No skipping.", 4: "Writing captions. Some of these are unhinged.",
  5: "Making sure every clip actually hits.", 6: "Burning captions into pixels…",
  error: "It tripped over something.",
};
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

let jobId = null, pollTimer = null, ticker = null, startedAt = null;
let personas = [], personaId = null, limits = null, picked = null;

async function api(path, opts = {}) {
  const res = await fetch(API + path, { credentials: "same-origin", ...opts, headers: { ...(opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) }, body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showLogin(); throw new Error("Please sign in."); }
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); kids.flat().forEach((k) => k != null && e.append(k)); return e; };
const svg = (paths, cls = "ico-sm") => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "2.2"); s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round"); s.setAttribute("aria-hidden", "true"); s.setAttribute("class", cls); s.innerHTML = paths; return s; };
const ICON = {
  up: '<path d="M7 10v12M15 5.9 14 10h5.8a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.5 22H7V10l4-8a3 3 0 0 1 4 3.9z"/>',
  down: '<path d="M17 14V2M9 18.1 10 14H4.2a2 2 0 0 1-2-2.3l1.4-8A2 2 0 0 1 5.5 2H17v12l-4 8a3 3 0 0 1-4-3.9z"/>',
  redo: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  dl: '<path d="M12 4v12M6 10l6 6 6-6M4 20h16"/>',
};
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const mb = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);
let toastTimer = null;
const note = (text) => { $("notice").textContent = text; $("notice").hidden = !text; clearTimeout(toastTimer); if (text) toastTimer = setTimeout(() => { $("notice").hidden = true; }, 9000); };

// ── sign in / create account ─────────────────────────────────────────────
let mode = "in";
function setMode(m) {
  mode = m;
  $("tab-in").classList.toggle("on", m === "in"); $("tab-up").classList.toggle("on", m === "up");
  $("tab-in").setAttribute("aria-selected", String(m === "in")); $("tab-up").setAttribute("aria-selected", String(m === "up"));
  $("auth-title").textContent = m === "in" ? "Welcome back," : "Get in here,";
  $("name").hidden = m === "in"; $("pw-hint").hidden = m === "in"; $("terms-row").hidden = m === "in"; $("forgot-link").hidden = m !== "in";
  $("forgot-form").hidden = true; $("login-form").hidden = false;
  $("auth-submit").textContent = m === "in" ? "Sign in" : "Create account";
  $("password").autocomplete = m === "in" ? "current-password" : "new-password";
  $("login-error").textContent = "";
}
$("tab-in").addEventListener("click", () => setMode("in"));
$("tab-up").addEventListener("click", () => setMode("up"));
function showLogin(signupsOpen = true) {
  $("login").hidden = false; $("app").hidden = true; $("logout").hidden = true; $("mins-pill").hidden = true; $("whoami").textContent = "";
  $("tab-up").hidden = !signupsOpen;
  if (!signupsOpen) setMode("in");
  else if (new URLSearchParams(location.search).has("signup")) setMode("up");
}
// A button shows a spinner while it works, then goes back to exactly what it showed before (icons included).
const busy = (btn, on, label) => {
  btn.disabled = on;
  if (on) { btn._was = [...btn.childNodes]; btn.replaceChildren(el("span", { className: "spin" }), label); }
  else if (btn._was) { btn.replaceChildren(...btn._was); btn._was = null; }
};
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault(); $("login-error").textContent = "";
  if (mode === "up" && !$("terms").checked) { $("login-error").textContent = "Please agree to the Terms and the Privacy Policy to create an account."; return; }
  busy($("auth-submit"), true, mode === "in" ? "Signing in…" : "Creating…");
  try {
    const res = await fetch(mode === "in" ? "/auth/login" : "/auth/signup", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: $("email").value, password: $("password").value, name: $("name").value, accept_terms: mode === "up" ? $("terms").checked : undefined }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Couldn't sign in.");
    $("password").value = "";
    if (location.search) history.replaceState(null, "", location.pathname);
    await start();
  } catch (err) { $("login-error").textContent = err.message; }
  finally { busy($("auth-submit"), false); }
});
// ── forgot password, reset link, confirm-email link ───────────────────────
async function postJson(path, body) {
  const res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "That didn't work.");
  return data;
}
$("forgot-link").addEventListener("click", () => { $("login-form").hidden = true; $("forgot-form").hidden = false; $("forgot-link").hidden = true; $("forgot-email").value = $("email").value; $("login-error").textContent = ""; $("forgot-email").focus(); });
$("forgot-back").addEventListener("click", () => setMode("in"));
$("forgot-form").addEventListener("submit", async (e) => {
  e.preventDefault(); $("login-error").textContent = "";
  try { await postJson("/auth/forgot", { email: $("forgot-email").value }); setMode("in"); note("If there's an account for that address, we've sent a link to choose a new password. It works for an hour."); }
  catch (err) { $("login-error").textContent = err.message; }
});
let resetToken = null;
$("reset-form").addEventListener("submit", async (e) => {
  e.preventDefault(); $("reset-error").textContent = "";
  try {
    await postJson("/auth/reset", { token: resetToken, password: $("new-password").value });
    $("new-password").value = ""; resetToken = null; $("reset-card").hidden = true;
    note("Your password has been changed. Sign in with the new one."); await start();
  } catch (err) { $("reset-error").textContent = err.message; }
});
// The links in our emails come back as /?verify=... or /?reset=... (the landing page forwards them here); the token is taken out of the address bar at once.
async function handleEmailLinks() {
  const q = new URLSearchParams(location.search), verify = q.get("verify"), reset = q.get("reset");
  if (!verify && !reset) return false;
  history.replaceState(null, "", location.pathname);
  if (reset) { resetToken = reset; $("reset-card").hidden = false; $("login").hidden = true; return true; }
  try { await postJson("/auth/verify", { token: verify }); note("Your email address is confirmed. Go make something stupid."); }
  catch (err) { note(err.message); }
  return false;
}
$("verify-resend").addEventListener("click", async () => {
  $("verify-msg").textContent = "";
  try { const r = await postJson("/auth/resend-verification"); $("verify-msg").textContent = r.already ? "You're already confirmed." : "Sent. Check your inbox and spam folder."; }
  catch (err) { $("verify-msg").textContent = err.message; }
});

$("logout").addEventListener("click", async () => { await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }); location.href = "/"; });
$("mins-pill").addEventListener("click", () => $("account").scrollIntoView({ behavior: "smooth", block: "start" }));

// ── your plan ───────────────────────────────────────────────────────────────
const gb = (b) => (b / 1024 ** 3 < 0.1 ? `${Math.round(b / 1024 ** 2)} MB` : `${(b / 1024 ** 3).toFixed(1)} GB`);
function meter(label, used, limit, text) {
  const pct = Math.min(100, Math.round((used / limit) * 100));
  return el("div", { className: "meter" + (pct >= 90 ? " hot" : "") }, el("span", { textContent: `${label}: ${text}` }), el("div", { className: "bar" }, el("span", { style: `width:${pct}%` })));
}
async function refreshPlan() {
  const me = await fetch("/api/me", { credentials: "same-origin" }).then((r) => r.json()).catch(() => null);
  if (!me || !me.signedIn) return;
  const { plan, usage } = me;
  limits = me.limits;
  $("plan-name").textContent = plan.label;
  $("whoami").textContent = me.user.email;
  const left = Math.max(0, limits.monthly_minutes - usage.minutes) + (usage.pack_minutes || 0);
  $("mins-text").replaceChildren(`${left} min`, el("span", { className: "opt", textContent: " left" })); $("mins-pill").hidden = false;
  $("mins-pill").classList.toggle("hot", left <= 0); $("mins-pill").title = `${usage.minutes} of ${limits.monthly_minutes} minutes used this month on ${plan.label}`;
  $("meters").replaceChildren(
    meter("Minutes this month", usage.minutes, limits.monthly_minutes, `${usage.minutes} of ${limits.monthly_minutes}`),
    meter("Storage", usage.storage_bytes, limits.storage_gb * 1024 ** 3, `${gb(usage.storage_bytes)} of ${limits.storage_gb} GB`),
    meter("Running now", usage.active_runs, limits.concurrent_runs, `${usage.active_runs} of ${limits.concurrent_runs}`),
  );
  const topUp = usage.pack_minutes > 0 ? ` Top-up minutes: ${usage.pack_minutes}.` : "";
  $("plan-note").textContent = `Videos up to ${limits.max_video_minutes} minutes and ${limits.max_upload_mb} MB. Runs and clips are kept for ${limits.retention_days} days, then deleted.${limits.api_access ? "" : " API access needs a paid plan."}${limits.watermark ? " Clips carry a watermark; Creator and above have none." : ""}${topUp}`;
  $("limits-line").textContent = `${plan.label} · up to ${limits.max_video_minutes} min · ${limits.max_upload_mb} MB`;
  $("keys-intro").textContent = limits.api_access ? "Let another app use your account through the API. A key is shown once, so copy it when it appears." : "API keys come with a paid plan.";
  $("key-form").hidden = !limits.api_access;
  if (picked) checkPicked();
}

// ── pricing and checkout (Stripe hosts the payment page) ──────────────────
let billing = null, period = "monthly";
const snap = () => JSON.stringify(billing && [billing.plan_name, billing.current && billing.current.pack_minutes]);
const money = (n) => `$${Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(2)}`;
async function pay(body, btn) {
  $("billing-error").textContent = ""; btn.disabled = true;
  try {
    try { sessionStorage.setItem("mb_pay_before", snap()); } catch { /* private mode: the page then judges by the account's state alone */ }
    const res = await fetch("/billing/checkout", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Couldn't start checkout.");
    location.href = data.url;
  } catch (err) { $("billing-error").textContent = err.message; btn.disabled = false; }
}
function renderPricing() {
  if (!billing || !billing.enabled) { $("pricing-card").hidden = true; return; }
  $("pricing-card").hidden = false;
  const cur = billing.current || {}, mineName = billing.plan_name;
  const subscribed = !!cur.status && cur.status !== "canceled";
  $("pricing-h").textContent = subscribed ? "Your subscription" : "Upgrade";
  const off = Math.round((1 - billing.plans[0].price_annual / billing.plans[0].price_monthly) * 100);
  $("per-annual").textContent = `Annual · save ${off}%`;
  $("per-monthly").classList.toggle("on", period === "monthly"); $("per-annual").classList.toggle("on", period === "annual");
  $("plans").replaceChildren(...billing.plans.map((p) => {
    const price = period === "annual" ? p.price_annual : p.price_monthly, ok = p.available[period];
    const mine = mineName === p.name && subscribed;
    const btn = el("button", { type: "button", textContent: mine ? "Your plan" : subscribed ? "Change in Manage billing" : ok ? `Choose ${p.label}` : "Not on sale yet", disabled: mine || subscribed || !ok });
    btn.addEventListener("click", () => pay({ plan: p.name, period }, btn));
    return el("div", { className: "plan" + (mine ? " mine" : "") },
      el("strong", { textContent: p.label }),
      el("span", { className: "price", textContent: `${money(price)}/mo` }),
      el("span", { className: "muted", textContent: period === "annual" ? `billed ${money(price * 12)} a year` : "billed monthly" }),
      el("span", { textContent: `${p.minutes} minutes a month` }), el("span", { className: "muted", textContent: p.watermark ? "Clips carry a watermark" : "No watermark" }), btn);
  }));
  $("packs-wrap").hidden = !cur.can_buy_packs;
  $("packs").replaceChildren(...billing.packs.map((p) => {
    const btn = el("button", { type: "button", textContent: p.available ? `Buy · ${money(p.price)}` : "Not on sale yet", disabled: !p.available });
    btn.addEventListener("click", () => pay({ pack: p.key }, btn));
    const best = p.key === billing.packs[billing.packs.length - 1].key;
    return el("div", { className: "plan" + (best ? " mine" : "") }, el("strong", { textContent: p.label }), el("span", { className: "price", textContent: money(p.price) }),
      el("span", { className: "muted", textContent: `$${(p.price / p.minutes).toFixed(2)} a minute${best ? " · best value" : ""}` }), btn);
  }));
  const bits = [];
  if (cur.status === "canceling") bits.push(`Your plan ends${cur.renews_at ? ` on ${new Date(cur.renews_at).toLocaleDateString()}` : " at the end of this period"}. After that your account is locked until you subscribe again.`);
  else if (cur.status === "past_due") bits.push("Your last payment didn't go through. Update your card in Manage billing.");
  else if (subscribed && cur.renews_at) bits.push(`Renews on ${new Date(cur.renews_at).toLocaleDateString()}.`);
  if (cur.pack_minutes > 0) bits.push(`${cur.pack_minutes} top-up minutes left.`);
  if (cur.offer_pending) bits.push(`Thanks for staying: ${cur.offer_pending.minutes} top-up minutes will be added after your next payment.`);
  if (!$("cancel-panel").hidden) bits.length = 0;
  $("billing-note").textContent = bits.join(" ");
  $("manage-billing").hidden = !cur.can_manage;
  $("cancel-btn").hidden = !(cur.status === "active" || cur.status === "past_due") || !$("cancel-panel").hidden;
  $("resume-btn").hidden = cur.status !== "canceling";
}
$("per-monthly").addEventListener("click", () => { period = "monthly"; renderPricing(); });
$("per-annual").addEventListener("click", () => { period = "annual"; renderPricing(); });
$("manage-billing").addEventListener("click", async () => {
  $("billing-error").textContent = "";
  try {
    const res = await fetch("/billing/portal", { method: "POST", credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Couldn't open billing.");
    location.href = data.url;
  } catch (err) { $("billing-error").textContent = err.message; }
});
async function loadBilling() {
  try {
    billing = await fetch("/api/billing", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null));
    if (billing) { const me = await fetch("/api/me", { credentials: "same-origin" }).then((r) => r.json()); billing.plan_name = me.plan && me.plan.name; if (me.billing) billing.current = me.billing; }
    renderPricing();
  } catch { $("pricing-card").hidden = true; }
}
// Coming back from Stripe: the plan changes when Stripe's message reaches the server, which can take a few seconds.
async function afterCheckout() {
  const q = new URLSearchParams(location.search).get("billing");
  if (!q) return;
  history.replaceState(null, "", location.pathname);
  $("pricing-card").scrollIntoView({ block: "start" });
  if (q === "cancelled") { $("billing-note").textContent = "Checkout cancelled. You haven't been charged."; return; }
  $("billing-note").textContent = "Thanks! Updating your account…";
  let before = null; try { before = sessionStorage.getItem("mb_pay_before"); sessionStorage.removeItem("mb_pay_before"); } catch { /* ignore */ }
  // Stripe's message may already have arrived, so look at once, then every 2 seconds for 20.
  for (let i = 0; i < 11; i++) {
    if (i) { await new Promise((r) => setTimeout(r, 2000)); await refreshPlan(); await loadBilling(); }
    const paidUp = before ? snap() !== before : (billing && billing.current && (billing.current.status || billing.current.pack_minutes > 0));
    if (paidUp) { $("billing-note").textContent = "All set. Your account is updated."; return; }
  }
  $("billing-note").textContent = "Your payment is being processed. Refresh in a minute if your plan hasn't changed.";
}

// ── cancelling: the offer to stay, then a plain warning ────────────────────
async function billingPost(path) {
  const res = await fetch(path, { method: "POST", credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "That didn't work.");
  return data;
}
async function afterBillingChange(msg) { await refreshPlan(); await loadBilling(); if (msg) $("billing-note").textContent = msg; }
function closeCancel() { $("cancel-panel").hidden = true; renderPricing(); }
function confirmStep() {
  const cur = billing.current || {}, when = cur.renews_at ? new Date(cur.renews_at).toLocaleDateString() : "the end of this period";
  $("cancel-text").textContent = `Cancel your subscription? You keep your plan until ${when}. After that your account is locked: you can't reach your videos, clips or top-up minutes until you subscribe again. Nothing is deleted, and it all comes back when you do.`;
  $("cancel-stay").hidden = true; $("cancel-go").textContent = "Yes, cancel my subscription";
  $("cancel-go").onclick = async () => {
    $("billing-error").textContent = "";
    try { await billingPost("/billing/cancel"); $("cancel-panel").hidden = true; await afterBillingChange(); } catch (err) { $("billing-error").textContent = err.message; }
  };
}
$("cancel-btn").addEventListener("click", () => {
  const offer = billing && billing.current && billing.current.offer;
  $("cancel-panel").hidden = false; $("cancel-btn").hidden = true; $("billing-note").textContent = "";
  if (!offer) return confirmStep();
  $("cancel-text").textContent = `Before you go: stay subscribed one more month and we'll add ${offer.minutes} top-up minutes to your account after your next payment. They never expire.`;
  $("cancel-stay").hidden = false; $("cancel-stay").textContent = `Stay and get ${offer.minutes} minutes`;
  $("cancel-stay").onclick = async () => {
    $("billing-error").textContent = "";
    try { await billingPost("/billing/offer/accept"); $("cancel-panel").hidden = true; await afterBillingChange(); } catch (err) { $("billing-error").textContent = err.message; }
  };
  $("cancel-go").textContent = "No thanks, cancel";
  $("cancel-go").onclick = confirmStep;
});
$("cancel-keep").addEventListener("click", closeCancel);
$("resume-btn").addEventListener("click", async () => {
  $("billing-error").textContent = "";
  try { await billingPost("/billing/resume"); await afterBillingChange("Welcome back. Your subscription will keep renewing."); } catch (err) { $("billing-error").textContent = err.message; }
});

// A cancelled subscription locks the account: the page shows only how to subscribe again.
function showLocked(me) {
  $("app").classList.add("locked"); $("locked-card").hidden = false;
  const saved = (me.billing && me.billing.saved) || {};
  const bits = [];
  if (saved.runs) bits.push(`${saved.runs} run${saved.runs === 1 ? "" : "s"} with their clips`);
  if (saved.pack_minutes) bits.push(`${saved.pack_minutes} top-up minutes`);
  $("locked-text").textContent = bits.length ? `Waiting for you: ${bits.join(" and ")}.` : "Subscribe to start making clips again.";
}

// ── load ────────────────────────────────────────────────────────────────
async function start() {
  const me = await fetch("/api/me", { credentials: "same-origin" }).then((r) => r.json());
  if (!me.signedIn) return showLogin(me.signupsOpen !== false);
  $("login").hidden = true; $("app").hidden = false; $("logout").hidden = false; await refreshPlan(); await loadBilling(); afterCheckout();
  const needsConfirm = me.verification_required && !me.user.email_verified;
  $("verify-banner").hidden = !needsConfirm;
  if (needsConfirm) $("verify-text").textContent = `Confirm your email address to start making clips. We sent a link to ${me.user.email}.`;
  if (me.user.locked) return showLocked(me);   // nothing else of the account is reachable until they subscribe again
  const [{ personas: list }, { videos }, { jobs }] = await Promise.all([api("/personas"), api("/videos"), api("/jobs")]);
  renderAudiences(list, store.get("mb_persona"));
  $("previous").replaceChildren(el("option", { value: "", textContent: "Pick an earlier video" }), ...videos.map((v) => el("option", { value: v.job_id, textContent: `${v.label}${v.duration ? ` · ${mmss(v.duration)}` : ""} · ${new Date(v.created_at).toLocaleDateString()}` })));
  $("reuse-wrap").hidden = videos.length === 0;
  renderRecent(jobs); loadKeys(); updateGo();
  const active = jobs.find((j) => j.status === "queued" || j.status === "running");
  if (active) open(active.id);   // come back to a run that is still going
}

function renderRecent(jobs) {
  $("recent").replaceChildren(...(jobs.length ? jobs.slice(0, 12).map((j) => {
    const live = j.status === "queued" || j.status === "running";
    return el("li", {},
      el("button", { type: "button", onclick: () => { open(j.id); $("run").scrollIntoView({ behavior: "smooth", block: "start" }); } }, el("span", { textContent: j.source_label }), el("span", { className: "st" + (live ? " live" : ""), textContent: j.status === "done" ? `${j.clip_count} clip${j.clip_count === 1 ? "" : "s"}` : live ? "cooking" : j.status })),
      live ? "" : el("button", { type: "button", className: "del", textContent: "Delete", "aria-label": `Delete ${j.source_label}`, title: "Delete this run and free its storage", onclick: async () => {
        if (!confirm(`Delete "${j.source_label}" and its ${j.clip_count} clips? This can't be undone.`)) return;
        try { await api(`/jobs/${j.id}`, { method: "DELETE" }); if (jobId === j.id) { $("run").hidden = true; $("clips-wrap").hidden = true; jobId = null; } const { jobs: next } = await api("/jobs"); renderRecent(next); refreshPlan(); }
        catch (err) { note(err.message); }
      } }));
  }) : [el("li", { className: "muted", textContent: "Nothing yet. Your clips will live here." })]));
}

// ── audiences ───────────────────────────────────────────────────────────
// A few starting points for "describe your crowd": a tap fills the form, then they edit it.
const EXAMPLES = [
  ["ER nurses on nights", "Emergency room nurses working 12-hour night shifts. Short-staffed, running on cold coffee, dealing with drunk patients at 3am, doctors who don't listen, and family members who googled it."],
  ["Warzone squad", "A group of friends who play Call of Duty Warzone every night. Trash talk, the one friend who always dies first, blaming lag, rage quits, and promising 'one more game' at 2am."],
  ["Real estate agents", "Residential real estate agents. Buyers who want a mansion on a studio budget, sellers who think their house is worth double, Zillow experts, open houses where nobody comes, waiting on commission checks."],
  ["First-year teachers", "Brand new elementary and middle school teachers. Underpaid, buying supplies with their own money, parent emails at midnight, kids who know more about TikTok than math, surviving until summer break."],
];
function renderAudiences(list, preferId) {
  personas = list;
  if (!personas.some((p) => p.id === personaId)) personaId = (personas.find((p) => p.id === preferId) || personas[0] || {}).id || null;
  const pick = (id) => { personaId = id; store.set("mb_persona", id); renderAudiences(personas); updateGo(); };
  const chips = personas.map((p) => {
    const on = p.id === personaId;
    const b = el("button", { type: "button", className: "aud", role: "radio", tabIndex: on ? 0 : -1, textContent: p.name, onclick: () => pick(p.id) });
    b.setAttribute("aria-checked", String(on)); b.dataset.id = p.id;
    return b;
  });
  chips.push(el("button", { type: "button", className: "aud add", id: "aud-add", textContent: "+ Describe your crowd", onclick: openNewAudience }));
  $("auds").replaceChildren(...chips);
  $("aud-count").textContent = personas.length ? `${personas.length} crowd${personas.length === 1 ? "" : "s"}` : "";
}
// arrow keys move between the audience chips, like any radio group
$("auds").addEventListener("keydown", (e) => {
  if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
  const radios = [...$("auds").querySelectorAll('[role="radio"]')]; if (!radios.length) return;
  const i = radios.findIndex((r) => r.getAttribute("aria-checked") === "true");
  const next = radios[(i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1) + radios.length) % radios.length];
  e.preventDefault(); next.click(); $("auds").querySelector(`[data-id="${CSS.escape(next.dataset.id)}"]`).focus();
});
function openNewAudience() {
  $("newaud").hidden = false; $("aud-error").textContent = "";
  $("aud-examples").replaceChildren(...EXAMPLES.map(([name, notes]) => el("button", { type: "button", className: "small", textContent: name, onclick: () => { $("aud-name").value = name; $("aud-notes").value = notes; $("aud-notes").focus(); } })));
  $("aud-name").focus();
}
$("aud-cancel").addEventListener("click", () => { $("newaud").hidden = true; $("aud-add").focus(); });
$("newaud").addEventListener("submit", async (e) => {
  e.preventDefault(); $("aud-error").textContent = "";
  const name = $("aud-name").value.trim(), notes = $("aud-notes").value.trim();
  if (notes.length < 20) { $("aud-error").textContent = "Give it a couple of sentences about them (20+ characters)."; return; }
  busy($("aud-save"), true, "Studying your crowd…"); $("aud-cancel").disabled = true;
  try {
    const { persona } = await api("/personas", { method: "POST", body: { name, notes } });
    const { personas: list } = await api("/personas");
    personaId = persona.id; store.set("mb_persona", persona.id);
    renderAudiences(list); $("newaud").reset(); $("newaud").hidden = true; updateGo();
    note(`${persona.name} is ready. Captions will be written in their voice.`);
  } catch (err) { $("aud-error").textContent = err.message; }
  finally { busy($("aud-save"), false); $("aud-cancel").disabled = false; }
});

// ── the video ───────────────────────────────────────────────────────────
function setFile(file) {
  if (picked && picked.url) URL.revokeObjectURL(picked.url);
  picked = null; $("picked").hidden = true; $("drop").hidden = false; $("make-error").textContent = "";
  if (file) {
    picked = { file, url: URL.createObjectURL(file), duration: null };
    $("previous").value = "";
    $("picked-name").textContent = file.name; $("picked-size").textContent = mb(file.size); $("picked-bad").textContent = "";
    const v = $("picked-video");
    v.onloadedmetadata = () => { if (!picked || picked.file !== file) return; picked.duration = v.duration; v.currentTime = Math.min(1.5, v.duration / 3 || 0); checkPicked(); };
    v.onerror = () => { if (picked && picked.file === file) { $("picked-size").textContent = `${mb(file.size)} · no preview in this browser`; } };
    v.src = picked.url;
    $("picked").hidden = false; $("drop").hidden = true;
    checkPicked();
  } else { $("file").value = ""; }
  updateGo();
}
// Say up front when the plan won't take it, rather than after the whole upload.
function checkPicked() {
  if (!picked) return;
  const bits = [mb(picked.file.size)]; if (picked.duration) bits.push(mmss(picked.duration));
  $("picked-size").textContent = bits.join(" · ");
  let bad = "";
  if (limits && picked.file.size > limits.max_upload_mb * 1024 ** 2) bad = `Too big for your plan (${limits.max_upload_mb} MB max).`;
  else if (limits && picked.duration && picked.duration > limits.max_video_minutes * 60 + 1) bad = `Too long for your plan (${limits.max_video_minutes} minutes max).`;
  else if (picked.file.type && !/^video\//.test(picked.file.type)) bad = "That doesn't look like a video file.";
  $("picked-bad").textContent = bad; picked.bad = !!bad;
  updateGo();
}
$("file").addEventListener("change", () => setFile($("file").files[0] || null));
$("picked-clear").addEventListener("click", () => { setFile(null); $("file").click(); });
$("previous").addEventListener("change", () => { if ($("previous").value) setFile(null); updateGo(); });
// drag a file anywhere onto the drop zone
["dragenter", "dragover"].forEach((ev) => $("drop").addEventListener(ev, (e) => { e.preventDefault(); $("drop").classList.add("over"); }));
["dragleave", "dragend", "drop"].forEach((ev) => $("drop").addEventListener(ev, () => $("drop").classList.remove("over")));
$("drop").addEventListener("drop", (e) => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) setFile(f); });
// a file dropped outside the zone shouldn't make the browser navigate away from the studio
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => { e.preventDefault(); if (!$("app").hidden && e.dataTransfer && e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });

function updateGo() {
  const prev = $("previous").value, aud = personas.find((p) => p.id === personaId);
  const ready = (picked && !picked.bad) || prev;
  $("make").disabled = !ready || !personaId || $("make").dataset.busy === "1";
  if ($("make").dataset.busy === "1") return;
  $("make").textContent = prev && !picked ? "Remix it" : "Make memes";
  $("make-hint").textContent = !ready ? (picked && picked.bad ? "Pick a different video." : "Pick a video to start.") : !personaId ? "Pick who it's for." : `For ${aud ? aud.name : "your crowd"}. Clips show up as they finish.`;
}

// ── make clips ──────────────────────────────────────────────────────────
$("make").addEventListener("click", async () => {
  $("make-error").textContent = "";
  const file = picked && picked.file, previous = $("previous").value;
  if (!file && !previous) { $("make-error").textContent = "Pick a video first."; return; }
  if (!personaId) { $("make-error").textContent = "Pick who it's for first."; return; }
  $("make").dataset.busy = "1"; busy($("make"), true, file ? "Uploading…" : "Starting…");
  try {
    let res;
    if (file) {
      const fd = new FormData(); fd.append("file", file); fd.append("personaId", personaId);
      res = await uploadWithProgress(fd);
    } else {
      res = await api(`/jobs/${previous}/recaption`, { method: "POST", body: { personaId } });
    }
    setFile(null); $("previous").value = "";
    open(res.job.id);
    $("run").scrollIntoView({ behavior: "smooth", block: "start" });
    api("/jobs").then(({ jobs }) => renderRecent(jobs)); refreshPlan();
  } catch (err) { $("make-error").textContent = err.message; }
  finally { delete $("make").dataset.busy; busy($("make"), false); $("upload-wrap").hidden = true; updateGo(); }
});

function uploadWithProgress(fd) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const show = (pct, label) => { $("upload-wrap").hidden = false; $("upload-bar").firstElementChild.style.width = `${pct}%`; $("upload-bar").setAttribute("aria-valuenow", String(pct)); $("upload-pct").textContent = `${pct}%`; $("upload-label").textContent = label; };
    xhr.open("POST", `${API}/jobs`); xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { const pct = Math.round((e.loaded / e.total) * 100); show(pct, pct < 100 ? "Uploading" : "Checking the video"); } };
    xhr.upload.onload = () => show(100, "Checking the video");
    xhr.onload = () => { let d = {}; try { d = JSON.parse(xhr.responseText); } catch { /* not json */ } if (xhr.status === 401) showLogin(); xhr.status >= 200 && xhr.status < 300 ? resolve(d) : reject(new Error(d.error || `Upload failed (${xhr.status}).`)); };
    xhr.onerror = () => reject(new Error("The upload was interrupted. Check your connection and try again."));
    show(0, "Uploading");
    xhr.send(fd);
  });
}
// leaving mid-upload loses it: say so
window.addEventListener("beforeunload", (e) => { if ($("make").dataset.busy === "1") { e.preventDefault(); e.returnValue = ""; } });

// ── a run ───────────────────────────────────────────────────────────────
function open(id) {
  jobId = id; clearTimeout(pollTimer); clearInterval(ticker); startedAt = null;
  $("run").hidden = false; $("clips-wrap").hidden = true; $("clips").replaceChildren(); $("retry").hidden = true; $("zip").hidden = true;
  poll();
}

async function poll() {
  const id = jobId;
  try {
    const { job, clips } = await api(`/jobs/${id}`);
    if (id !== jobId) return;
    render(job, clips);
    if (job.status === "queued" || job.status === "running") pollTimer = setTimeout(poll, 2500);
    else { clearInterval(ticker); api("/jobs").then(({ jobs }) => renderRecent(jobs)); refreshPlan(); }
  } catch (err) { $("run-status").textContent = err.message; pollTimer = setTimeout(poll, 5000); }
}

// How far along a run is, 0 to 100: the stages are weighted by how long they usually take.
function progressOf(job) {
  if (job.status === "done") return 100;
  if (job.status === "queued") return 2;
  const idx = stepIndex(job.stage), info = job.stage_info || {};
  const base = [3, 6, 10, 15, 45, 60, 80, 100];
  let pct = base[Math.max(0, idx)] || 3;
  if (idx === 5 && info.total) pct = 60 + 20 * Math.min(1, (info.done || 0) / info.total);
  if (idx === 6 && info.count) pct = 80 + 19 * Math.min(1, (info.done || 0) / info.count);
  return Math.round(pct);
}

function render(job, clips) {
  const active = job.status === "queued" || job.status === "running";
  const idx = stepIndex(job.stage), info = job.stage_info || {};
  $("run").hidden = job.status === "done";
  $("run").classList.toggle("live", active); $("run").classList.toggle("err", job.status === "error");
  $("run-title").textContent = job.status === "error" ? "That run didn't finish" : job.source_label;
  const pct = progressOf(job);
  $("run-meter").firstElementChild.style.width = `${Math.max(4, pct)}%`; $("run-meter").setAttribute("aria-valuenow", String(pct));
  $("quip").textContent = job.status === "error" ? QUIPS.error : job.status === "queued" ? QUIPS.queued : QUIPS[Math.max(0, idx)] || "";
  $("steps").replaceChildren(...STEPS.map(([, label], i) => el("li", { className: i < idx ? "done" : i === idx && active ? "now" : "", textContent: label })));
  startedAt = Date.parse(job.started_at || job.created_at);
  const tick = () => {
    const secs = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    let extra = "";
    if (job.stage === "render" && info.count != null) extra = ` · rendering clip ${Math.min((info.done || 0) + 1, info.count)} of ${info.count}`;
    if (job.stage === "verify" && info.total != null) extra = ` · checking clip ${Math.min((info.done || 0) + 1, info.total)} of ${info.total}`;
    $("run-status").textContent = job.status === "error" ? (job.error || "Something went wrong.") : job.status === "queued" ? "Waiting for its turn. You can leave this page; it keeps going." : `${mmss(secs)} elapsed${extra} · you can leave this page, it keeps going`;
  };
  tick(); clearInterval(ticker); if (active) ticker = setInterval(tick, 1000);
  const notes = [];
  if (info.noAudio) notes.push("This video has no sound track, so the clips will be silent.");
  if (info.captionBatchesFailed) notes.push("Part of the video couldn't be captioned, so you may get fewer clips.");
  $("notes").replaceChildren(...notes.map((n) => el("p", { className: "note", textContent: n })));
  $("retry").hidden = job.status !== "error";
  $("retry").onclick = async () => { try { await api(`/jobs/${job.id}/retry`, { method: "POST" }); open(job.id); } catch (e) { $("run-status").textContent = e.message; } };

  $("clips-wrap").hidden = clips.length === 0;
  $("clips-title").replaceChildren(job.status === "done" ? el("span", { className: "tag", textContent: `${clips.length} ` }) : `${clips.length} `, `clip${clips.length === 1 ? "" : "s"}${active ? " so far…" : " served"}`);
  $("zip").hidden = job.status !== "done" || clips.length < 2;
  $("zip").href = `${API}/jobs/${job.id}/clips.zip`;
  $("zip").replaceChildren(svg(ICON.dl), `Download all ${clips.length}`);
  syncClips(clips);
}

function syncClips(clips) {
  const have = new Map([...$("clips").children].map((c) => [c.dataset.id, c]));
  for (const c of clips) {
    const old = have.get(c.id);
    if (old) { old.querySelector(".cap").textContent = c.caption; old.querySelector(".up").classList.toggle("on", c.rating > 0); old.querySelector(".down").classList.toggle("on", c.rating < 0); continue; }
    $("clips").append(clipCard(c));
  }
}

function clipCard(c) {
  const card = el("article", { className: "clip" }); card.dataset.id = c.id;
  const video = el("video", { controls: true, playsInline: true, preload: "metadata", src: `${c.video_url}#t=0.8` });
  video.setAttribute("aria-label", `Clip: ${c.caption}`);
  const cap = el("p", { className: "cap", textContent: c.caption });
  const meta = el("p", { className: "meta", textContent: `${mmss(c.start_sec)}–${mmss(c.end_sec)}${c.emotion ? ` · ${c.emotion}` : ""}${c.score != null ? ` · fit ${c.score}/10` : ""}` });
  const rate = async (value) => { const next = c.rating === value ? 0 : value; try { await api(`/clips/${c.id}/rating`, { method: "POST", body: { rating: next } }); c.rating = next; up.classList.toggle("on", next > 0); down.classList.toggle("on", next < 0); up.setAttribute("aria-pressed", String(next > 0)); down.setAttribute("aria-pressed", String(next < 0)); } catch (e) { note(e.message); } };
  const up = el("button", { type: "button", className: "small up" + (c.rating > 0 ? " on" : ""), title: "Banger. Write more like this", onclick: () => rate(1) }, svg(ICON.up));
  const down = el("button", { type: "button", className: "small down" + (c.rating < 0 ? " on" : ""), title: "Mid. Not funny", onclick: () => rate(-1) }, svg(ICON.down));
  up.setAttribute("aria-label", "Funny"); down.setAttribute("aria-label", "Not funny");
  up.setAttribute("aria-pressed", String(c.rating > 0)); down.setAttribute("aria-pressed", String(c.rating < 0));
  const fresh = el("button", { type: "button", className: "small", title: "The robot writes a different caption and re-renders", onclick: async () => {
    busy(fresh, true, "Writing…");
    try { const r = await api(`/clips/${c.id}/regenerate-caption`, { method: "POST", body: {} }); c.caption = r.clip.caption; cap.textContent = r.clip.caption; video.src = `${c.video_url}?v=${Date.now()}#t=0.8`; }
    catch (e) { note(e.message); } finally { busy(fresh, false); }
  } }, svg(ICON.redo), el("span", { className: "lbl", textContent: "New caption" }));
  fresh.setAttribute("aria-label", "New caption");
  const dl = el("a", { className: "chip dl", href: `${c.video_url}?download=1` }, svg(ICON.dl), el("span", { className: "lbl", textContent: "Save" }));
  dl.setAttribute("aria-label", `Download clip: ${c.caption}`);
  card.append(video, cap, meta, el("div", { className: "row" }, up, down, fresh, dl));
  return card;
}

// ── API keys (the signed-in user's own) ───────────────────────────────────
async function loadKeys() {
  try {
    const { keys = [] } = await fetch("/account/keys", { credentials: "same-origin" }).then((r) => r.json()).catch(() => ({ keys: [] }));
    $("keys").replaceChildren(...(keys.length ? keys.map((k) => el("li", {}, el("button", { type: "button", disabled: !!k.revoked_at, onclick: async () => { if (!confirm(`Revoke "${k.name}"? Anything using it stops working.`)) return; await fetch(`/account/keys/${k.id}`, { method: "DELETE", credentials: "same-origin" }); loadKeys(); } },
      el("span", { textContent: `${k.name} · ${k.key_prefix}…${k.revoked_at ? " (revoked)" : ""}` }), el("span", { className: "st", textContent: k.revoked_at ? "revoked" : "revoke" }))))
      : [el("li", { className: "muted", textContent: "No keys yet." })]));
  } catch { /* the keys list is optional */ }
}
$("key-form").addEventListener("submit", async (e) => {
  e.preventDefault(); $("key-error").textContent = ""; $("key-new").hidden = true;
  try {
    const res = await fetch("/account/keys", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: $("key-name").value }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Couldn't create the key.");
    $("key-new").textContent = `Copy these now. They are not shown again.\n\nAPI key:        ${data.key}\nWebhook secret: ${data.webhook_secret}`; $("key-new").hidden = false;
    $("key-form").reset(); loadKeys();
  } catch (err) { $("key-error").textContent = err.message; }
});

handleEmailLinks().then((stop) => (stop ? null : start())).catch((e) => { document.querySelector("main .wrap").append(el("p", { className: "error", textContent: e.message })); });
