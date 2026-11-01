'use strict';
/**
 * Database backup using the official MongoDB Database Tools (mongodump).
 * Produces a compressed, timestamped archive and prunes archives older than BACKUP_KEEP_DAYS.
 *
 *   npm run backup
 *   Restore:  mongorestore --uri "$MONGO_URI" --gzip --archive=backups/quranic-YYYYMMDD-HHmm.gz --drop
 *
 * Schedule it with cron (e.g. `15 2 * * * cd /srv/quranic && npm run backup`) and copy the
 * backup folder off-site (object storage). Uploaded files in UPLOAD_DIR must be backed up too.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');

const keepDays = parseInt(process.env.BACKUP_KEEP_DAYS || '14', 10);
fs.mkdirSync(config.backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
const file = path.join(config.backupDir, `quranic-${stamp}.gz`);

const child = spawn('mongodump', [`--uri=${config.mongoUri}`, '--gzip', `--archive=${file}`], { stdio: 'inherit' });
child.on('error', (err) => {
  console.error('mongodump not found. Install MongoDB Database Tools: https://www.mongodb.com/docs/database-tools/', err.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  if (code !== 0) { console.error(`mongodump exited with code ${code}`); process.exitCode = code; return; }
  console.log(`Backup written to ${file}`);
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  fs.readdirSync(config.backupDir)
    .filter((f) => /^quranic-.*\.gz$/.test(f))
    .forEach((f) => {
      const full = path.join(config.backupDir, f);
      if (fs.statSync(full).mtimeMs < cutoff) { fs.rmSync(full); console.log(`Pruned ${f}`); }
    });
});
