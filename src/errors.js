"use strict";
// An error that carries the HTTP status and a message that is safe to show the caller.
class HttpError extends Error {
  constructor(status, message, code) { super(message); this.name = "HttpError"; this.status = status; this.code = code; }
}
module.exports = { HttpError };
