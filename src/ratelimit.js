"use strict";
// A small in-memory sliding window per id. Per process, which is fine for one web instance; move it to the
// database or Redis when the web app runs on several machines.
function createLimiter({ windowMs = 60000 } = {}) {
  const hits = new Map();
  return {
    /** { ok, retryAfterSec }: records a hit when allowed. */
    check(id, limit, now = Date.now()) {
      const windowStart = now - windowMs;
      const list = (hits.get(id) || []).filter((t) => t > windowStart);
      if (list.length >= limit) {
        hits.set(id, list);
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000)) };
      }
      list.push(now); hits.set(id, list);
      return { ok: true, retryAfterSec: 0 };
    },
    reset(id) { hits.delete(id); },
  };
}
module.exports = { createLimiter };
