"use strict";

// Meme Builder file storage: source videos and rendered clips.
//
// Cloudflare R2 (S3 API) when the R2 credentials exist (see backendName), otherwise the local disk.
// Files are STREAMED in and out (videos are too big to hold in memory) and reads support Range requests for playback.
//
// Stored values are URIs so a row keeps working if the backend changes later:
//   r2://<bucket>/meme-builder/<...>      file://<absolute path>
//
// Server disks are ephemeral, so production must end up on R2: that happens automatically whenever the R2 credentials are set.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const hasR2Creds = () => !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);

/**
 * Which backend holds the files: MEME_BUILDER_STORAGE_BACKEND (r2 | local) if set, otherwise R2 when the
 * R2 credentials are present, else the local disk.
 */
const backendName = () => {
  const explicit = (process.env.MEME_BUILDER_STORAGE_BACKEND || "").toLowerCase();
  if (explicit === "r2" || explicit === "local") return explicit;
  return hasR2Creds() ? "r2" : "local";
};
const r2Bucket = () => process.env.R2_BUCKET || "meme-builder";
const localRoot = () => process.env.MEME_BUILDER_STORAGE_ROOT || path.join(process.cwd(), "storage");

let _s3 = null;
function s3() {
  if (_s3) return _s3;
  const { R2_ACCOUNT_ID: accountId, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("[meme-builder-storage] R2 backend selected but R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY missing.");
  }
  const { S3Client } = require("@aws-sdk/client-s3");
  // R2_ENDPOINT is for local development against an S3-compatible server only; production never sets it.
  const custom = process.env.R2_ENDPOINT;
  _s3 = new S3Client({
    region: "auto",
    endpoint: custom || `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    // Newer SDKs add a trailing checksum and "aws-chunked" framing to streamed uploads by default.
    // Third-party S3 APIs (R2 included) can reject that, and the blog code never exercises it (it
    // uploads from memory), so only add checksums when an operation requires them.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    ...(custom ? { forcePathStyle: true } : {}),
  });
  return _s3;
}

function parseUri(uri) {
  if (uri.startsWith("r2://")) {
    const rest = uri.slice(5);
    const slash = rest.indexOf("/");
    if (slash < 0) throw new Error(`malformed r2 uri ${uri}`);
    return { scheme: "r2", bucket: rest.slice(0, slash), key: rest.slice(slash + 1) };
  }
  if (uri.startsWith("file://")) return { scheme: "file", file: uri.slice(7) };
  throw new Error(`unknown storage uri ${uri}`);
}

const safeKey = (key) => String(key).split("/").filter((p) => p && p !== "." && p !== "..").join("/");

/** Stream a local file into storage under `key` (relative, e.g. "<jobId>/clip-01.mp4"). Returns the stored URI. */
async function putFile(localPath, key, contentType = "application/octet-stream") {
  const k = `meme-builder/${safeKey(key)}`;
  if (backendName() === "r2") {
    const { PutObjectCommand } = require("@aws-sdk/client-s3");
    const { size } = await fs.promises.stat(localPath);
    await s3().send(new PutObjectCommand({ Bucket: r2Bucket(), Key: k, Body: fs.createReadStream(localPath), ContentLength: size, ContentType: contentType }));
    return `r2://${r2Bucket()}/${k}`;
  }
  const dest = path.join(localRoot(), safeKey(key));
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.copyFile(localPath, dest);
  return `file://${dest}`;
}

/** Size in bytes of a stored object (for Range requests). */
async function sizeOf(uri) {
  const u = parseUri(uri);
  if (u.scheme === "r2") {
    const { HeadObjectCommand } = require("@aws-sdk/client-s3");
    return (await s3().send(new HeadObjectCommand({ Bucket: u.bucket, Key: u.key }))).ContentLength;
  }
  return (await fs.promises.stat(u.file)).size;
}

/** Open for reading. range = { start, end } (inclusive) or null. Returns { stream, size, start, end, contentType }. */
async function openRead(uri, range = null) {
  const u = parseUri(uri);
  if (u.scheme === "r2") {
    const { GetObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
    const head = await s3().send(new HeadObjectCommand({ Bucket: u.bucket, Key: u.key }));
    const size = head.ContentLength;
    const start = range ? range.start : 0;
    const end = range ? Math.min(range.end, size - 1) : size - 1;
    const res = await s3().send(new GetObjectCommand({ Bucket: u.bucket, Key: u.key, ...(range ? { Range: `bytes=${start}-${end}` } : {}) }));
    return { stream: res.Body, size, start, end, contentType: head.ContentType || "application/octet-stream" };
  }
  const { size } = await fs.promises.stat(u.file);
  const start = range ? range.start : 0;
  const end = range ? Math.min(range.end, size - 1) : size - 1;
  return { stream: fs.createReadStream(u.file, { start, end }), size, start, end, contentType: "application/octet-stream" };
}

/** Copy a stored object to a local path (jobs need the source video on disk for ffmpeg). */
async function downloadToFile(uri, dest) {
  const { stream } = await openRead(uri);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await require("node:stream/promises").pipeline(stream, fs.createWriteStream(dest));
  return dest;
}

async function remove(uri) {
  if (!uri) return;
  const u = parseUri(uri);
  if (u.scheme === "r2") {
    const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
    await s3().send(new DeleteObjectCommand({ Bucket: u.bucket, Key: u.key }));
  } else {
    await fs.promises.rm(u.file, { force: true });
  }
}

/** True when an error means "that stored object isn't there" (local file or R2 object). */
function isNotFound(err) {
  if (!err) return false;
  return !!(err.code === "ENOENT" || err.name === "NotFound" || err.name === "NoSuchKey" || (err.$metadata && err.$metadata.httpStatusCode === 404));
}

const SOURCE_GONE =
  "The uploaded video is no longer stored on the server. This usually means the server restarted and cleared its disk before the run could start. Upload the video again.";

/** Scratch directory for a job (ffmpeg input/output); callers delete it when done. */
async function makeWorkDir(name) {
  const dir = await fs.promises.mkdtemp(path.join(process.env.MEME_BUILDER_TMP || os.tmpdir(), `mb-${safeKey(name).replace(/\//g, "-")}-`));
  return dir;
}

module.exports = { putFile, openRead, sizeOf, downloadToFile, remove, makeWorkDir, parseUri, backendName, isNotFound, SOURCE_GONE };
