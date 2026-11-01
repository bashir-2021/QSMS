'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');

/**
 * File uploads are written to the private uploads directory (never under /public) and
 * served only through authenticated, tenant-checked routes.
 */
const TMP_DIR = path.join(config.uploads.dir, 'tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const ATTACHMENT_TYPES = { ...IMAGE_TYPES, 'application/pdf': '.pdf' };

function makeUploader(allowed, maxBytes) {
  return multer({
    storage: multer.diskStorage({
      destination: TMP_DIR,
      filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${allowed[file.mimetype] || ''}`),
    }),
    limits: { fileSize: maxBytes, files: 1, fields: 60 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const okExt = Object.values(allowed).includes(ext === '.jpeg' ? '.jpg' : ext);
      if (allowed[file.mimetype] && okExt) return cb(null, true);
      const err = new Error(`Unsupported file type. Allowed: ${[...new Set(Object.values(allowed))].join(', ')}`);
      err.status = 400; err.expose = true;
      return cb(err);
    },
  });
}

const imageUpload = makeUploader(IMAGE_TYPES, config.uploads.maxImageBytes);
const attachmentUpload = makeUploader(ATTACHMENT_TYPES, config.uploads.maxAttachmentBytes);

/** Verify magic bytes so a renamed executable can't pass as an image/PDF. */
function sniff(filePath) {
  const buf = Buffer.alloc(12);
  const fd = fs.openSync(filePath, 'r');
  try { fs.readSync(fd, buf, 0, 12, 0); } finally { fs.closeSync(fd); }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(0, 4).toString() === '%PDF') return 'application/pdf';
  return null;
}

/**
 * Move an uploaded temp file into the tenant's private folder after validating its content.
 * Returns the stored relative path ("<tenantId>/<file>") or throws.
 */
function persistUpload(file, tenantId, prefix = 'file') {
  if (!file) return null;
  const actual = sniff(file.path);
  if (!actual || actual !== file.mimetype) {
    fs.rmSync(file.path, { force: true });
    const err = new Error('The uploaded file content does not match its type.');
    err.status = 400; err.expose = true;
    throw err;
  }
  const dir = path.join(config.uploads.dir, String(tenantId));
  fs.mkdirSync(dir, { recursive: true });
  const name = `${prefix}-${path.basename(file.path)}`;
  fs.renameSync(file.path, path.join(dir, name));
  return `${tenantId}/${name}`;
}

/** Resolve a stored relative path safely inside the uploads dir (prevents path traversal). */
function resolveStored(relPath) {
  if (!relPath) return null;
  const full = path.resolve(config.uploads.dir, relPath);
  if (!full.startsWith(config.uploads.dir + path.sep)) return null;
  return fs.existsSync(full) ? full : null;
}

function removeStored(relPath) {
  const full = resolveStored(relPath);
  if (full) fs.rmSync(full, { force: true });
}

module.exports = { imageUpload, attachmentUpload, persistUpload, resolveStored, removeStored };
