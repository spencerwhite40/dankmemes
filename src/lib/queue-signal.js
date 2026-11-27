"use strict";

// Tiny in-process signal so the job runner starts a run the moment one is
// queued instead of waiting for its next idle poll. The runner still polls
// (slowly) so jobs queued by another instance, or left over after a restart,
// get picked up.

// Listeners: the in-process runner, and the scaler that starts worker machines (src/lib/scaler.js).
const handlers = new Set();

/** Register a listener. Returns an unsubscribe function. */
function onJobQueued(fn) {
  handlers.add(fn);
  return () => { handlers.delete(fn); };
}

/** Called by the routes after a job is queued. Never throws. */
function notifyJobQueued() {
  for (const fn of handlers) {
    try { setImmediate(() => { Promise.resolve(fn()).catch(() => {}); }); } catch { /* best effort */ }
  }
}

module.exports = { onJobQueued, notifyJobQueued };
