import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import os from 'os';

const DATA_DIR = join(os.homedir(), '.ipm');
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, 'ipm.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id     TEXT NOT NULL,
    doc_title  TEXT NOT NULL,
    project    TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setConfig(key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
}

export function saveRun(docId, docTitle, project) {
  return db.prepare(
    'INSERT INTO runs (doc_id, doc_title, project) VALUES (?, ?, ?)'
  ).run(docId, docTitle, project).lastInsertRowid;
}

export function updateRunStatus(id, status) {
  db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, id);
}
