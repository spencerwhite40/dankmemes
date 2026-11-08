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

// ── sign in ──────────────────────────────────────────────────────────────
function showLogin() { $("login").hidden = false; $("app").hidden = true; $("logout").hidden = true; }
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault(); $("login-error").textContent = "";
  try {
    const res = await fetch("/login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: $("password").value }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Couldn't sign in.");
    $("password").value = ""; await start();
  } catch (err) { $("login-error").textContent = err.message; }
});
$("logout").addEventListener("click", async () => { await fetch("/logout", { method: "POST" }); location.reload(); });

// ── load ────────────────────────────────────────────────────────────────
async function start() {
  const me = await fetch("/api/me").then((r) => r.json());
  if (!me.signedIn) return showLogin();
  $("login").hidden = true; $("app").hidden = false; $("logout").hidden = !me.authEnabled;
  const [{ personas }, { videos }, { jobs }] = await Promise.all([api("/personas"), api("/videos"), api("/jobs")]);
  $("persona").replaceChildren(...personas.map((p) => el("option", { value: p.id, textContent: p.name })));
  $("previous").replaceChildren(el("option", { value: "", textContent: "None" }), ...videos.map((v) => el("option", { value: v.job_id, textContent: `${v.label}${v.duration ? ` · ${mmss(v.duration)}` : ""} · ${new Date(v.created_at).toLocaleDateString()}` })));
  renderRecent(jobs);
  const active = jobs.find((j) => j.status === "queued" || j.status === "running");
  if (active) open(active.id);   // come back to a run that is still going
}

function renderRecent(jobs) {
  $("recent").replaceChildren(...(jobs.length ? jobs.slice(0, 10).map((j) => el("li", {}, el("button", { type: "button", onclick: () => open(j.id) },
    el("span", { textContent: j.source_label }), el("span", { className: "st", textContent: j.status === "done" ? `${j.clip_count} clips` : j.status }))))
    : [el("li", { className: "muted", textContent: "Nothing yet." })]));
}

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
    api("/jobs").then(({ jobs }) => renderRecent(jobs));
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
    else { clearInterval(ticker); api("/jobs").then(({ jobs }) => renderRecent(jobs)); }
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
