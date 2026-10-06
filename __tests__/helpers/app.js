/**
 * freshApp — boots a COMPLETELY FRESH module registry (new MMKV map,
 * new DB connection cache) pointing at a fresh database, then returns
 * the storage + connection modules. All subsequently required service
 * modules share this registry, so getDb()/storage are consistent.
 *
 * dbPath: ':memory:' (default) or a temp file path (upgrade tests
 * pre-create an old schema in the file BEFORE calling freshApp).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function freshApp(dbPath) {
  globalThis.__SELA_DB_PATH = dbPath || ':memory:';
  jest.resetModules();
  const storage = require(path.join(ROOT, 'src/storage/storage'));
  const connection = require(path.join(ROOT, 'src/database/connection'));
  return {storage, connection};
}

/** A unique temp DB file path (removed if it exists). */
function tempDb(name) {
  const file = path.join(os.tmpdir(), `sela-test-${name}-${Date.now()}.db`);
  try {
    fs.rmSync(file, {force: true});
  } catch {
    // Ignore.
  }
  return file;
}

/** Requires an app module (path from PROJECT ROOT) from the registry. */
function load(moduleFromRoot) {
  return require(path.join(ROOT, moduleFromRoot));
}

module.exports = {freshApp, tempDb, load, ROOT};
