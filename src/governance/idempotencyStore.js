const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

let db;
let selectByKeyStmt;
let insertStmt;

function ensureInitialized() {
  if (!db) {
    throw new Error('Idempotency store is not initialized. Call initIdempotency(dbPath) first.');
  }
}

async function initIdempotency(dbPath) {
  if (!dbPath || !String(dbPath).trim()) {
    throw new Error('IDP_DB_PATH must be set when idempotency is enabled.');
  }

  const resolvedPath = path.resolve(String(dbPath));
  const directory = path.dirname(resolvedPath);
  fs.mkdirSync(directory, { recursive: true });

  db = new DatabaseSync(resolvedPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS idempotency (
      key TEXT PRIMARY KEY,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  selectByKeyStmt = db.prepare('SELECT result_json FROM idempotency WHERE key = ?');
  insertStmt = db.prepare(
    'INSERT OR IGNORE INTO idempotency (key, result_json, created_at) VALUES (?, ?, ?)'
  );

  return { dbPath: resolvedPath };
}

async function getIdempotency(key) {
  ensureInitialized();

  const row = selectByKeyStmt.get(key);
  if (!row) {
    return null;
  }

  return JSON.parse(row.result_json);
}

async function setIdempotency(key, resultObj) {
  ensureInitialized();

  const createdAt = new Date().toISOString();
  insertStmt.run(key, JSON.stringify(resultObj), createdAt);
}

module.exports = {
  initIdempotency,
  getIdempotency,
  setIdempotency
};
