"use strict";

// Tiny in-process signal so the job runner starts a run the moment one is
// queued instead of waiting for its next idle poll. The runner still polls
// (slowly) so jobs queued by another instance, or left over after a restart,
// get picked up.

let handler = null;

/** The runner registers itself here. Returns an unsubscribe function. */
function onJobQueued(fn) {
  handler = fn;
  return () => { if (handler === fn) handler = null; };
}

/** Called by the routes after a job is queued. Never throws. */
function notifyJobQueued() {
  if (!handler) return;
  try { setImmediate(() => { Promise.resolve(handler()).catch(() => {}); }); } catch { /* best effort */ }
}

module.exports = { onJobQueued, notifyJobQueued };
