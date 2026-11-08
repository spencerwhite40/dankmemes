"use strict";
// Multipart upload of one video file to a temp path (the caller removes it after the file has been stored).
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const multer = require("multer");

const MAX_UPLOAD_MB = () => Number(process.env.MEME_BUILDER_MAX_UPLOAD_MB || 500);

function uploadMiddleware() {
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, os.tmpdir()),
      filename: (_req, file, cb) => cb(null, `mb-upload-${crypto.randomBytes(6).toString("hex")}${path.extname(file.originalname || "").slice(0, 8)}`),
    }),
    limits: { fileSize: MAX_UPLOAD_MB() * 1024 * 1024, files: 1 },
  });
  return (req, res, next) => upload.single("file")(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === "LIMIT_FILE_SIZE";
    return res.status(tooBig ? 413 : 400).json({ error: tooBig ? `That file is over the ${MAX_UPLOAD_MB()} MB limit.` : err.message, code: tooBig ? "file_too_large" : "bad_upload" });
  });
}

module.exports = { uploadMiddleware, MAX_UPLOAD_MB };
