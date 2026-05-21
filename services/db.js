import Database from 'better-sqlite3'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// DATA_DIR env var allows Railway/Docker to mount a persistent volume
const dataDir = process.env.DATA_DIR || resolve(__dirname, '../../data')
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
`)

export default db
