"use strict";
// Getting JSON out of a model's reply, including replies that were cut off partway.

/**
 * The complete top-level objects of a JSON array that was cut off partway (the model hit its length limit or the
 * connection dropped). Returns [] when there is no complete item. Pure.
 */
function salvageArray(t) {
  const start = t.indexOf("[");
  if (start === -1) return [];
  const items = [];
  let depth = 0, inStr = false, esc = false, itemStart = -1;
  for (let i = start + 1; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) itemStart = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && itemStart !== -1) { try { items.push(JSON.parse(t.slice(itemStart, i + 1))); } catch { /* skip a bad item */ } itemStart = -1; }
      if (depth < 0) break;
    }
  }
  return items;
}

function extractJSON(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(t); } catch { /* fall through */ }
  const start = t.search(/[[{]/);
  if (start === -1) throw new Error("no JSON found");
  const close = t[start] === "{" ? "}" : "]";
  const end = t.lastIndexOf(close);
  if (end > start) { try { return JSON.parse(t.slice(start, end + 1)); } catch { /* cut off or malformed: try to salvage below */ } }
  if (t[start] === "[") { const items = salvageArray(t.slice(start)); if (items.length) return items; }
  throw new Error("the reply was cut off or not valid JSON");
}

module.exports = { salvageArray, extractJSON };
