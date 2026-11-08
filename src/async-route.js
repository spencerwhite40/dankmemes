"use strict";
// Wraps an async route handler so a thrown error reaches Express's error handler instead of hanging the request.
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { asyncRoute };
