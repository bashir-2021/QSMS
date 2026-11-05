'use strict';
/**
 * Local development database: runs MongoDB as the single-node replica set the app needs for
 * transactions, keeps its files in ./data, and sets the replica set up on first run.
 * Usage: `npm run db` in one terminal, `npm run dev` in another. Ctrl+C stops it.
 * MONGOD_PATH can point at a mongod binary that is not found automatically.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const mongoose = require('mongoose');
const config = require('../config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ALREADY_INITIALIZED = 23;
const NOT_YET_INITIALIZED = 94;

function findMongod() {
  if (process.env.MONGOD_PATH) return process.env.MONGOD_PATH;
  const serverDir = 'C:\\Program Files\\MongoDB\\Server';
  if (fs.existsSync(serverDir)) {
    const newest = fs.readdirSync(serverDir).sort((a, b) => parseFloat(b) - parseFloat(a))[0];
    const exe = newest && path.join(serverDir, newest, 'bin', 'mongod.exe');
    if (exe && fs.existsSync(exe)) return exe;
  }
  return 'mongod'; // on the PATH
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Wait for mongod to answer, set up the replica set if needed, and wait until it can take writes. */
async function waitUntilPrimary(port, replicaSet) {
  const host = `127.0.0.1:${port}`;
  const client = new mongoose.mongo.MongoClient(`mongodb://${host}/?directConnection=true`, { serverSelectionTimeoutMS: 30000 });
  await client.connect();
  const admin = client.db('admin');
  try {
    await admin.command({ replSetInitiate: { _id: replicaSet, members: [{ _id: 0, host }] } });
  } catch (err) {
    if (err.code !== ALREADY_INITIALIZED) throw err;
  }
  for (let i = 0; i < 60; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const status = await admin.command({ replSetGetStatus: 1 });
      if (status.myState === 1) break;
    } catch (err) {
      if (err.code !== NOT_YET_INITIALIZED) throw err;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(500);
  }
  await client.close();
}

async function main() {
  const uri = new URL(config.mongoUri);
  const port = uri.port || '27017';
  const replicaSet = uri.searchParams.get('replicaSet') || 'rs0';
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const mongod = spawn(findMongod(), [
    '--replSet', replicaSet, '--dbpath', DATA_DIR, '--port', port, '--bind_ip', '127.0.0.1',
    '--logpath', path.join(DATA_DIR, 'mongod.log'), '--logappend',
  ], { stdio: 'inherit' });
  mongod.on('error', (err) => {
    console.error(`Could not start mongod: ${err.message}. Set MONGOD_PATH to its location.`);
    process.exit(1);
  });
  mongod.on('exit', (code) => {
    console.log(`MongoDB stopped (exit code ${code}). If it failed, see data/mongod.log.`);
    process.exit(code || 0);
  });
  ['SIGINT', 'SIGTERM'].forEach((signal) => process.on(signal, () => mongod.kill()));

  await waitUntilPrimary(port, replicaSet);
  console.log(`MongoDB is ready on port ${port} (replica set ${replicaSet}). Leave this running and start the app with: npm run dev`);
}

main().catch((err) => {
  console.error(`Could not prepare MongoDB: ${err.message}`);
  process.exit(1);
});
