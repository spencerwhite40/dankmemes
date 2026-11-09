"use strict";
// The whole interface: pick an audience, pick a video, make clips, watch progress, get clips.
const $ = (id) => document.getElementById(id);
const API = "/api";
const STEPS = [
  ["fetch", "Getting the video"], ["prepare", "Preparing"], ["upload", "Uploading"], ["analyze", "Watching it"],
  ["captions", "Writing captions"], ["verify", "Checking each clip"], ["render", "Rendering clips"],
];
const stepIndex = (stage) => ({ starting: 0, fetch: 0, prepare: 1, upload: 2, analyze: 3, analyzed: 3, captions: 4, selected: 4, verify: 5, render: 6, done: 7 }[stage] ?? -1);

let jobId = null, pollTimer = null, ticker = null, startedAt = null;

async function api(path, opts = {}) {
  const res = await fetch(API + path, { credentials: "same-origin", ...opts, headers: { ...(opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) }, body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showLogin(); throw new Error("Please sign in."); }
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); kids.flat().forEach((k) => e.append(k)); return e; };
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// ── sign in / create account ─────────────────────────────────────────────
let mode = "in";
function setMode(m) {
  mode = m;
  $("tab-in").classList.toggle("on", m === "in"); $("tab-up").classList.toggle("on", m === "up");
  $("name").hidden = m === "in"; $("pw-hint").hidden = m === "in";
  $("auth-submit").textContent = m === "in" ? "Sign in" : "Create account";
  $("password").autocomplete = m === "in" ? "current-password" : "new-password";
  $("login-error").textContent = "";
}
$("tab-in").addEventListener("click", () => setMode("in"));
$("tab-up").addEventListener("click", () => setMode("up"));
function showLogin(signupsOpen = true) {
  $("login").hidden = false; $("app").hidden = true; $("logout").hidden = true; $("whoami").textContent = "";
  $("tab-up").hidden = !signupsOpen; if (!signupsOpen) setMode("in");
}
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault(); $("login-error").textContent = "";
  try {
    const res = await fetch(mode === "in" ? "/auth/login" : "/auth/signup", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: $("email").value, password: $("password").value, name: $("name").value }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Couldn't sign in.");
    $("password").value = ""; await start();
  } catch (err) { $("login-error").textContent = err.message; }
});
$("logout").addEventListener("click", async () => { await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }); location.reload(); });

// ── your plan ───────────────────────────────────────────────────────────────
const gb = (b) => (b / 1024 ** 3 < 0.1 ? `${Math.round(b / 1024 ** 2)} MB` : `${(b / 1024 ** 3).toFixed(1)} GB`);
function meter(label, used, limit, text) {
  const pct = Math.min(100, Math.round((used / limit) * 100));
  return el("div", { className: "meter" + (pct >= 90 ? " hot" : "") }, el("span", { textContent: `${label}: ${text}` }), el("div", { className: "bar" }, el("span", { style: `width:${pct}%` })));
}
async function refreshPlan() {
  const me = await fetch("/api/me", { credentials: "same-origin" }).then((r) => r.json()).catch(() => null);
  if (!me || !me.signedIn) return;
  const { plan, limits, usage } = me;
  $("plan-name").textContent = plan.label;
  $("whoami").textContent = `${me.user.email} · ${plan.label}`;
  $("meters").replaceChildren(
    meter("Minutes this month", usage.minutes, limits.monthly_minutes, `${usage.minutes} of ${limits.monthly_minutes}`),
    meter("Storage", usage.storage_bytes, limits.storage_gb * 1024 ** 3, `${gb(usage.storage_bytes)} of ${limits.storage_gb} GB`),
    meter("Running now", usage.active_runs, limits.concurrent_runs, `${usage.active_runs} of ${limits.concurrent_runs}`),
  );
  const topUp = usage.pack_minutes > 0 ? ` Top-up minutes: ${usage.pack_minutes}.` : "";
  $("plan-note").textContent = `Videos up to ${limits.max_video_minutes} minutes and ${limits.max_upload_mb} MB. Runs and clips are kept for ${limits.retention_days} days, then deleted.${limits.api_access ? "" : " API access needs a paid plan."}${limits.watermark ? " Clips carry a watermark; Creator and above have none." : ""}${topUp}`;
  $("keys-intro").textContent = limits.api_access ? "Let another app use your account through the API. A key is shown once, so copy it when it appears. See docs/api.md." : "API keys come with a paid plan.";
  $("key-form").hidden = !limits.api_access;
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
  if (q === "cancelled") { $("billing-note").textContent = "Checkout cancelled. You haven't been charged."; return; }
  $("billing-note").textContent = "Thanks! Updating your account…";
  let before = null; try { before = sessionStorage.getItem("mb_pay_before"); sessionStorage.removeItem("mb_pay_before"); } catch { /* ignore */ }
  // Stripe's message may already have arrived, so look at once, then every 2 seconds for 20.
  for (let i = 0; i < 11; i++) {
    if (i) { await new Promise((r) => setTimeout(r, 2000)); await refreshPlan(); await loadBilling(); }
    const paidUp = before ? snap() !== before : (billing.current && (billing.current.status || billing.current.pack_minutes > 0));
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
async function afterBillingChange(note) { await refreshPlan(); await loadBilling(); if (note) $("billing-note").textContent = note; }
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
  if (me.user.locked) return showLocked(me);   // nothing else of the account is reachable until they subscribe again
  const [{ personas }, { videos }, { jobs }] = await Promise.all([api("/personas"), api("/videos"), api("/jobs")]);
  $("persona").replaceChildren(...personas.map((p) => el("option", { value: p.id, textContent: p.name })));
  $("previous").replaceChildren(el("option", { value: "", textContent: "None" }), ...videos.map((v) => el("option", { value: v.job_id, textContent: `${v.label}${v.duration ? ` · ${mmss(v.duration)}` : ""} · ${new Date(v.created_at).toLocaleDateString()}` })));
  renderRecent(jobs); loadKeys();
  const active = jobs.find((j) => j.status === "queued" || j.status === "running");
  if (active) open(active.id);   // come back to a run that is still going
}

function renderRecent(jobs) {
  $("recent").replaceChildren(...(jobs.length ? jobs.slice(0, 10).map((j) => el("li", {},
    el("button", { type: "button", onclick: () => open(j.id) }, el("span", { textContent: j.source_label }), el("span", { className: "st", textContent: j.status === "done" ? `${j.clip_count} clips` : j.status })),
    j.status === "queued" || j.status === "running" ? "" : el("button", { type: "button", className: "del", textContent: "delete", title: "Delete this run and free its storage", onclick: async () => {
      if (!confirm(`Delete "${j.source_label}" and its ${j.clip_count} clips?`)) return;
      try { await api(`/jobs/${j.id}`, { method: "DELETE" }); if (jobId === j.id) { $("run").hidden = true; $("clips-wrap").hidden = true; jobId = null; } const { jobs: next } = await api("/jobs"); renderRecent(next); refreshPlan(); }
      catch (err) { $("make-error").textContent = err.message; }
    } })))
    : [el("li", { className: "muted", textContent: "Nothing yet." })]));
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

// ── make clips ──────────────────────────────────────────────────────────
$("make").addEventListener("click", async () => {
  $("make-error").textContent = "";
  const file = $("file").files[0], previous = $("previous").value, personaId = $("persona").value;
  if (!file && !previous) { $("make-error").textContent = "Pick a video first."; return; }
  $("make").disabled = true;
  try {
    let res;
    if (file) {
      const fd = new FormData(); fd.append("file", file); fd.append("personaId", personaId);
      res = await uploadWithProgress(fd);
    } else {
      res = await api(`/jobs/${previous}/recaption`, { method: "POST", body: { personaId } });
    }
    $("file").value = "";
    open(res.job.id);
    api("/jobs").then(({ jobs }) => renderRecent(jobs)); refreshPlan();
  } catch (err) { $("make-error").textContent = err.message; }
  finally { $("make").disabled = false; $("upload-bar").hidden = true; }
});

function uploadWithProgress(fd) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API}/jobs`); xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { $("upload-bar").hidden = false; $("upload-bar").value = Math.round((e.loaded / e.total) * 100); } };
    xhr.onload = () => { let d = {}; try { d = JSON.parse(xhr.responseText); } catch { /* not json */ } xhr.status >= 200 && xhr.status < 300 ? resolve(d) : reject(new Error(d.error || `Upload failed (${xhr.status}).`)); };
    xhr.onerror = () => reject(new Error("The upload was interrupted. Check your connection and try again."));
    xhr.send(fd);
  });
}

// ── a run ───────────────────────────────────────────────────────────────
function open(id) {
  jobId = id; clearTimeout(pollTimer); clearInterval(ticker); startedAt = null;
  $("run").hidden = false; $("clips-wrap").hidden = true; $("clips").replaceChildren(); $("retry").hidden = true;
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

function render(job, clips) {
  const active = job.status === "queued" || job.status === "running";
  const idx = stepIndex(job.stage), info = job.stage_info || {};
  $("run").hidden = job.status === "done";
  $("run-title").textContent = job.status === "error" ? "That run didn't finish" : `Working on "${job.source_label}"`;
  $("steps").replaceChildren(...STEPS.map(([, label], i) => el("li", { className: i < idx ? "done" : i === idx ? "now" : "", textContent: (i < idx ? "✓ " : "") + label })));
  startedAt = Date.parse(job.started_at || job.created_at);
  const tick = () => {
    const secs = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    let extra = "";
    if (job.stage === "render" && info.count != null) extra = ` · Rendering clip ${Math.min((info.done || 0) + 1, info.count)} of ${info.count}`;
    if (job.stage === "verify" && info.total != null) extra = ` · Checking clip ${Math.min((info.done || 0) + 1, info.total)} of ${info.total}`;
    $("run-status").textContent = job.status === "error" ? (job.error || "Something went wrong.") : job.status === "queued" ? "Waiting for its turn…" : `${mmss(secs)} elapsed${extra}`;
  };
  tick(); clearInterval(ticker); if (active) ticker = setInterval(tick, 1000);
  const notes = [];
  if (info.noAudio) notes.push("This video has no sound track, so the clips will be silent.");
  if (info.captionBatchesFailed) notes.push("Part of the video couldn't be captioned, so you may get fewer clips.");
  $("notes").replaceChildren(...notes.map((n) => el("p", { className: "note", textContent: n })));
  $("retry").hidden = job.status !== "error";
  $("retry").onclick = async () => { try { await api(`/jobs/${job.id}/retry`, { method: "POST" }); open(job.id); } catch (e) { $("run-status").textContent = e.message; } };

  $("clips-wrap").hidden = clips.length === 0;
  $("clips-title").textContent = `${clips.length} clip${clips.length === 1 ? "" : "s"}${active ? " so far…" : ""}`;
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
  const card = el("div", { className: "clip" }); card.dataset.id = c.id;
  const video = el("video", { controls: true, playsInline: true, preload: "metadata", src: `${c.video_url}#t=0.8` });
  const cap = el("p", { className: "cap", textContent: c.caption });
  const meta = el("p", { className: "meta", textContent: `${mmss(c.start_sec)}–${mmss(c.end_sec)}${c.emotion ? ` · ${c.emotion}` : ""}${c.score != null ? ` · ${c.score}/10` : ""}` });
  const rate = async (value) => { const next = c.rating === value ? 0 : value; try { await api(`/clips/${c.id}/rating`, { method: "POST", body: { rating: next } }); c.rating = next; up.classList.toggle("on", next > 0); down.classList.toggle("on", next < 0); } catch (e) { cap.textContent = e.message; } };
  const up = el("button", { type: "button", className: "small up" + (c.rating > 0 ? " on" : ""), textContent: "👍", title: "Funny, write more like this", onclick: () => rate(1) });
  const down = el("button", { type: "button", className: "small down" + (c.rating < 0 ? " on" : ""), textContent: "👎", title: "Not funny", onclick: () => rate(-1) });
  const fresh = el("button", { type: "button", className: "small", textContent: "New caption", onclick: async () => {
    fresh.disabled = true; fresh.textContent = "Writing…";
    try { const r = await api(`/clips/${c.id}/regenerate-caption`, { method: "POST", body: {} }); c.caption = r.clip.caption; cap.textContent = r.clip.caption; video.src = `${c.video_url}?v=${Date.now()}#t=0.8`; }
    catch (e) { cap.textContent = e.message; } finally { fresh.disabled = false; fresh.textContent = "New caption"; }
  } });
  const dl = el("a", { href: `${c.video_url}?download=1`, textContent: "Download" });
  card.append(video, cap, meta, el("div", { className: "row" }, up, down, fresh, dl));
  return card;
}

start().catch((e) => { document.body.append(el("p", { className: "error", textContent: e.message })); });
