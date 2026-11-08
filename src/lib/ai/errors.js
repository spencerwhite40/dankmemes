"use strict";
// One error type for every AI provider. `retryable` means "try again / try the next model"; `code` is a stable reason
// ("out_of_credit", "bad_key", "no_provider", ...) that friendlyMessage turns into plain words.
class AiError extends Error {
  constructor(msg, { status, code, retryable } = {}) {
    super(msg);
    this.name = "AiError";
    this.status = status;
    this.code = code;
    this.retryable = !!retryable;
  }
}
module.exports = { AiError };
