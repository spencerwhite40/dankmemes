"use strict";
// A small stand-in for Google's Gemini API, for end-to-end tests. It speaks just enough of the real protocol (the Files API upload and
// generateContent) to let the whole pipeline run: it answers the three kinds of question the pipeline asks, from the prompt's own wording.
// Point the app at it with GOOGLE_API_BASE. Nothing here calls the internet.
const http = require("node:http");
const crypto = require("node:crypto");

/**
 * options.moments: what "watching the video" finds: [{ start: "00:08", end: "00:20", transcript, ... }]
 * options.fail: set to an HTTP status (e.g. 402) to make every generateContent call fail that way.
 * Returns { url, requests, setFail, close }. requests records each question: { kind, model, text }.
 */
async function startFakeGemini({ moments = [], fail = null } = {}) {
  const requests = [];
  let failWith = fail;
  let n = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, "http://x");
    const send = (status, obj, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };

    if (req.method === "POST" && url.pathname === "/upload/v1beta/files") return send(200, {}, { "x-goog-upload-url": `http://${req.headers.host}/upload-finalize/${++n}` });
    if (req.method === "POST" && url.pathname.startsWith("/upload-finalize/")) {
      const id = url.pathname.split("/").pop();
      requests.push({ kind: "upload", bytes: body.length });
      return send(200, { file: { name: `files/${id}`, uri: `http://${req.headers.host}/v1beta/files/${id}`, state: "ACTIVE", mimeType: "video/mp4" } });
    }
    const gen = /^\/v1beta\/models\/([^/:]+):generateContent$/.exec(url.pathname);
    if (req.method === "POST" && gen) {
      const j = JSON.parse(body.toString("utf8"));
      const text = [(j.systemInstruction && j.systemInstruction.parts || []).map((p) => p.text).join("\n"), ...j.contents.flatMap((c) => c.parts.map((p) => p.text || ""))].join("\n");
      const hasVideo = j.contents.some((c) => c.parts.some((p) => p.fileData || p.file_data));
      let kind, payload;
      if (hasVideo && /Reply with ONLY a JSON array\. Each item/.test(text)) { kind = "analysis"; payload = moments; }
      else if (/Reply with ONLY JSON: \{"found"/.test(text)) {
        kind = "verify"; const win = Number((/about (\d+) seconds/.exec(text) || [])[1]) || 30;
        payload = { found: true, start: 2, end: Math.min(win - 2, 2 + 14), pick: "A", fit: 8 };
      } else if (/For EACH one, write/.test(text)) {
        kind = "captions";
        const ids = [...new Set([...text.matchAll(/^\[(m\d+)\]/gm)].map((m) => m[1]))];
        payload = ids.map((id, i) => ({ id, usable: true, candidates: [`When the dock says "fifteen minutes" (${id})`, `POV: one more stop (${id})`, `Me explaining detention to a shipper (${id})`], best: `When the dock says "fifteen minutes" (${id})`, score: 5 + (i % 4), why: "matches the feeling" }));
      } else if (/Reply with ONLY JSON: \{ "caption"/.test(text)) { kind = "recaption"; payload = { caption: "A brand new caption from the fake model" }; }
      else { kind = "other"; payload = {}; }
      requests.push({ kind, model: gen[1], text });
      if (failWith) return send(failWith, { error: { message: failWith === 402 ? "Payment required" : "simulated failure", status: "FAILED" } });
      return send(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 300 } });
    }
    send(404, { error: { message: `fake gemini: no route for ${req.method} ${url.pathname}` } });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`, requests,
    setFail: (s) => { failWith = s; },
    close: () => new Promise((r) => server.close(r)),
  };
}

module.exports = { startFakeGemini };
