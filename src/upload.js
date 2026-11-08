"use strict";
// Multipart upload of one video file to a temp path (the caller removes it after the file has been stored).
// The size limit is the account's plan limit, capped by MEME_BUILDER_MAX_UPLOAD_MB when that is set.
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const multer = require("multer");
const accounts = require("./accounts");

const GLOBAL_CAP_MB = () => Number(process.env.MEME_BUILDER_MAX_UPLOAD_MB || 0);
const instances = new Map();   // one multer per distinct limit

function multerFor(limitMb) {
  if (!instances.has(limitMb)) {
    instances.set(limitMb, multer({
      storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, os.tmpdir()),
        filename: (_req, file, cb) => cb(null, `mb-upload-${crypto.randomBytes(6).toString("hex")}${path.extname(file.originalname || "").slice(0, 8)}`),
      }),
      limits: { fileSize: limitMb * 1024 * 1024, files: 1 },
    }));
  }
  return instances.get(limitMb);
}

/** ownerOf(req) returns the account id that is uploading. */
function uploadMiddleware(pool, ownerOf) {
  return async (req, res, next) => {
    let limitMb;
    try {
      const plan = await accounts.planFor(pool, ownerOf(req));
      limitMb = GLOBAL_CAP_MB() ? Math.min(plan.maxUploadMb, GLOBAL_CAP_MB()) : plan.maxUploadMb;
      req.plan = plan;
    } catch (e) { return next(e); }
    multerFor(limitMb).single("file")(req, res, (err) => {
      if (!err) return next();
      const tooBig = err.code === "LIMIT_FILE_SIZE";
      return res.status(tooBig ? 413 : 400).json({ error: tooBig ? `That file is over the ${limitMb} MB limit of your plan.` : err.message, code: tooBig ? "file_too_large" : "bad_upload" });
    });
  };
}

module.exports = { uploadMiddleware };
