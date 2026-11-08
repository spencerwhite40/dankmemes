"use strict";
// A small in-memory sliding window per key. Per process, which is fine for one web instance; move it to the
// database or Redis when the web app runs on several machines.
function createLimiter() {
  const hits = new Map();
  return {
    /** { ok, retryAfterSec }: records a hit when allowed. */
    check(id, limitPerMin, now = Date.now()) {
      const windowStart = now - 60000;
      const list = (hits.get(id) || []).filter((t) => t > windowStart);
      if (list.length >= limitPerMin) {
        hits.set(id, list);
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((list[0] + 60000 - now) / 1000)) };
      }
      list.push(now); hits.set(id, list);
      return { ok: true, retryAfterSec: 0 };
    },
  };
}
module.exports = { createLimiter };
