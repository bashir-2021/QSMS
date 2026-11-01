'use strict';
const mongoose = require('mongoose');
const config = require('./index');

mongoose.set('strictQuery', true);

async function connect(uri = config.mongoUri) {
  await mongoose.connect(uri, { autoIndex: true, serverSelectionTimeoutMS: 10000 });
  // Build declared indexes (unique / tenant-scoped constraints) before serving traffic.
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes().catch((err) => {
    console.error(`[db] index sync failed for ${m.modelName}: ${err.message}`);
  })));
  return mongoose.connection;
}

async function disconnect() {
  await mongoose.disconnect();
}

/**
 * Run `fn(session)` inside a MongoDB transaction when the deployment supports it.
 * Financial operations always go through this helper so related writes commit together.
 * With MONGO_TRANSACTIONS=false (standalone dev server) the function runs without a session.
 */
async function runInTransaction(fn) {
  if (!config.useTransactions) return fn(null);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = { connect, disconnect, runInTransaction };
