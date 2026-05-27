import Database from 'better-sqlite3'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
// DATA_DIR env var allows Railway/Docker to mount a persistent volume
const dataDir = process.env.DATA_DIR || resolve(__dirname, '../../data')
mkdirSync(dataDir, { recursive: true })
const db = new Database(resolve(dataDir, 'calls.db'))

db.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT UNIQUE,
    test_case_id TEXT,
    ext TEXT,
    phone TEXT,
    state TEXT DEFAULT 'initiated',
    from_number TEXT,
    to_number TEXT,
    hotline TEXT,
    duration INTEGER,
    billsec INTEGER,
    recording_url TEXT,
    call_result TEXT,
    transcripts TEXT,
    voicebot_result TEXT,
    time_started TEXT,
    time_answered TEXT,
    time_ended TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS call_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT,
    event TEXT,
    payload TEXT,
    received_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS test_case_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS test_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tc_id TEXT NOT NULL,
    group_id INTEGER REFERENCES test_case_groups(id) ON DELETE CASCADE,
    columns TEXT NOT NULL DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS order_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT 'Default',
    environment TEXT NOT NULL DEFAULT 'test',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER REFERENCES order_groups(id) ON DELETE CASCADE,
    data TEXT NOT NULL DEFAULT '{}',
    order_code TEXT,
    status TEXT DEFAULT 'pending',
    error TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS test_collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    collection_id TEXT,
    file_path TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS api_test_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id INTEGER REFERENCES test_collections(id),
    order_codes TEXT NOT NULL DEFAULT '[]',
    status TEXT DEFAULT 'running',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS api_test_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER REFERENCES api_test_runs(id) ON DELETE CASCADE,
    order_code TEXT,
    request_name TEXT,
    method TEXT,
    url TEXT,
    status_code INTEGER,
    actual_response TEXT,
    passed INTEGER DEFAULT 0,
    ac_results TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS ac_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id INTEGER REFERENCES test_collections(id) ON DELETE CASCADE,
    request_name TEXT NOT NULL,
    field_path TEXT NOT NULL,
    operator TEXT NOT NULL DEFAULT 'eq',
    expected_value TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`)

// Migration: add collection_id column to test_collections if missing
try {
  db.exec(`ALTER TABLE test_collections ADD COLUMN collection_id TEXT`)
} catch (_) { /* column already exists */ }

export default db
