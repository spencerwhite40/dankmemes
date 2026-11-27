"use strict";
// The landing page: live prices from /api/pricing, and the buttons change to "Open the studio" for someone already signed in.
(function () {
  const money = (n) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); kids.flat().forEach((k) => k != null && e.append(k)); return e; };
  let pricing = null, period = "monthly";

  fetch("/api/me", { credentials: "same-origin" }).then((r) => r.json()).then((me) => {
    if (me.signedIn) {
      document.querySelectorAll("[data-cta]").forEach((a) => { a.href = "/app"; a.firstChild.textContent = "Open the studio "; });
      document.querySelectorAll("[data-signin]").forEach((a) => { a.hidden = true; });
    } else if (me.signupsOpen === false) {
      document.querySelectorAll("[data-cta]").forEach((a) => { a.href = "/app"; a.firstChild.textContent = "Sign in "; });
    }
  }).catch(() => { /* the page works without it */ });

  // Which plan to call out, and what each card lists. The numbers all come from the server (src/plans.js).
  const HOT = "creator";
  function card(p) {
    const price = period === "annual" ? p.price_annual : p.price_monthly;
    const free = p.price_monthly === 0;
    const items = [
      el("li", { textContent: `${p.minutes.toLocaleString("en-US")} minutes of video a month` }),
      el("li", { textContent: `Videos up to ${p.max_video_minutes} minutes` }),
      el("li", { textContent: `Up to ${p.clips_per_run} clips per video` }),
      el("li", { className: p.watermark ? "no" : "", textContent: p.watermark ? "Watermark on clips" : "No watermark" }),
      el("li", { className: p.api_access ? "" : "no", textContent: p.api_access ? "API keys and webhooks" : "No API access" }),
      el("li", { textContent: `Clips kept ${p.retention_days} days` }),
    ];
    return el("div", { className: "price-card" + (p.name === HOT ? " hot" : "") },
      p.name === HOT ? el("span", { className: "flag", textContent: "the sweet spot" }) : null,
      el("h3", { textContent: p.label }),
      el("div", { className: "amt" }, free ? "$0" : money(price), el("small", { textContent: free ? " forever" : period === "annual" ? ` /mo, ${money(price * 12)} a year` : " /mo" })),
      el("ul", {}, items),
      el("a", { className: "btn" + (p.name === HOT ? "" : " ghost"), href: "/app?signup=1", textContent: free ? "Start free" : `Get ${p.label}` }));
  }
  function render() {
    if (!pricing) return;
    const shown = pricing.plans.filter((p) => p.name !== "agency");
    document.getElementById("prices").replaceChildren(...shown.map(card));
    const big = pricing.plans.find((p) => p.name === "agency");
    document.getElementById("price-more").textContent = big ? `Running an operation? ${big.label} is ${money(period === "annual" ? big.price_annual : big.price_monthly)}/mo for ${big.minutes.toLocaleString("en-US")} minutes, ${big.concurrent_runs} videos at once. Top-up packs are there when a month runs hot.` : "";
    document.querySelectorAll("[data-period]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.period === period)));
  }
  document.querySelectorAll("[data-period]").forEach((b) => b.addEventListener("click", () => { period = b.dataset.period; render(); }));
  fetch("/api/pricing").then((r) => (r.ok ? r.json() : null)).then((p) => {
    if (!p) return;
    pricing = p;
    const paid = p.plans.find((x) => x.price_monthly > 0);
    if (paid) { const off = Math.round((1 - paid.price_annual / paid.price_monthly) * 100); document.querySelector('[data-period="annual"]').textContent = `Annual · save ${off}%`; }
    render();
  }).catch(() => { /* the noscript line is the fallback */ });
})();
