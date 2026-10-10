import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Opens (and migrates) the library database.
 *
 * Migrations are `NNN_name.sql` files applied in order; the applied level is
 * tracked in `PRAGMA user_version`, each migration in its own transaction.
 *
 * @param {string} dbPath Absolute path to library.db.
 * @returns {DatabaseSync} Open database handle.
 */
export function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  for (const file of files) {
    const level = Number(file.slice(0, 3));
    if (level <= current) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    tx(db, () => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${level}`);
    });
  }
}

/**
 * Runs fn inside a transaction; rolls back on throw.
 *
 * @template T
 * @param {DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** ISO timestamp used for every *_at column. */
export const now = () => new Date().toISOString();

/**
 * Appends an audit event.
 *
 * @param {DatabaseSync} db
 * @param {string} action
 * @param {object} payload
 * @param {object|null} [undo]
 */
export function logEvent(db, action, payload, undo = null) {
  db.prepare('INSERT INTO events (ts, actor, action, payload_json, undo_json) VALUES (?, ?, ?, ?, ?)')
    .run(now(), 'user', action, JSON.stringify(payload), undo ? JSON.stringify(undo) : null);
}
