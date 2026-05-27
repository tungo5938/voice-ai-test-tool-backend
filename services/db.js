/**
 * db.js — Unified DB adapter
 * Local  → SQLite  (better-sqlite3, sync API vẫn hoạt động qua .prepare())
 * Production → PostgreSQL (pg) khi có DATABASE_URL
 *
 * Tất cả routes đều dùng async: await db.all() / db.get() / db.run()
 * Ngoài ra .prepare() vẫn hoạt động cho SQLite local (backward compat)
 */

import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT UNIQUE, test_case_id TEXT, ext TEXT, phone TEXT,
    state TEXT DEFAULT 'initiated', from_number TEXT, to_number TEXT,
    hotline TEXT, duration INTEGER, billsec INTEGER, recording_url TEXT,
    call_result TEXT, transcripts TEXT, voicebot_result TEXT,
    time_started TEXT, time_answered TEXT, time_ended TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS call_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT, event TEXT, payload TEXT,
    received_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS test_case_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS test_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tc_id TEXT NOT NULL,
    group_id INTEGER REFERENCES test_case_groups(id) ON DELETE CASCADE,
    columns TEXT NOT NULL DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS order_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT 'Default', environment TEXT NOT NULL DEFAULT 'test',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER REFERENCES order_groups(id) ON DELETE CASCADE,
    data TEXT NOT NULL DEFAULT '{}', order_code TEXT,
    status TEXT DEFAULT 'pending', error TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS test_collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    collection_id TEXT, file_path TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS api_test_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id INTEGER REFERENCES test_collections(id),
    order_codes TEXT NOT NULL DEFAULT '[]', status TEXT DEFAULT 'running',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS api_test_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER REFERENCES api_test_runs(id) ON DELETE CASCADE,
    order_code TEXT, request_name TEXT, method TEXT, url TEXT,
    status_code INTEGER, actual_response TEXT, passed INTEGER DEFAULT 0,
    ac_results TEXT, created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS ac_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id INTEGER REFERENCES test_collections(id) ON DELETE CASCADE,
    request_name TEXT NOT NULL, field_path TEXT NOT NULL,
    operator TEXT NOT NULL DEFAULT 'eq', expected_value TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS calls (
    id SERIAL PRIMARY KEY, call_id TEXT UNIQUE, test_case_id TEXT, ext TEXT, phone TEXT,
    state TEXT DEFAULT 'initiated', from_number TEXT, to_number TEXT,
    hotline TEXT, duration INTEGER, billsec INTEGER, recording_url TEXT,
    call_result TEXT, transcripts TEXT, voicebot_result TEXT,
    time_started TEXT, time_answered TEXT, time_ended TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS call_events (
    id SERIAL PRIMARY KEY, call_id TEXT, event TEXT, payload TEXT,
    received_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS test_case_groups (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS test_cases (
    id SERIAL PRIMARY KEY, tc_id TEXT NOT NULL,
    group_id INTEGER REFERENCES test_case_groups(id) ON DELETE CASCADE,
    columns TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS order_groups (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL DEFAULT 'Default',
    environment TEXT NOT NULL DEFAULT 'test', created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    group_id INTEGER REFERENCES order_groups(id) ON DELETE CASCADE,
    data TEXT NOT NULL DEFAULT '{}', order_code TEXT,
    status TEXT DEFAULT 'pending', error TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS test_collections (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, collection_id TEXT,
    file_path TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS api_test_runs (
    id SERIAL PRIMARY KEY,
    collection_id INTEGER REFERENCES test_collections(id),
    order_codes TEXT NOT NULL DEFAULT '[]', status TEXT DEFAULT 'running',
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS api_test_results (
    id SERIAL PRIMARY KEY,
    run_id INTEGER REFERENCES api_test_runs(id) ON DELETE CASCADE,
    order_code TEXT, request_name TEXT, method TEXT, url TEXT,
    status_code INTEGER, actual_response TEXT, passed INTEGER DEFAULT 0,
    ac_results TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS ac_rules (
    id SERIAL PRIMARY KEY,
    collection_id INTEGER REFERENCES test_collections(id) ON DELETE CASCADE,
    request_name TEXT NOT NULL, field_path TEXT NOT NULL,
    operator TEXT NOT NULL DEFAULT 'eq', expected_value TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
`

let _db = null

export async function initDb() {
  if (_db) return _db

  if (process.env.DATABASE_URL) {
    // ── PostgreSQL ──────────────────────────────────────────────────────────
    const { default: pg } = await import('pg')
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
    await pool.query(PG_SCHEMA)
    console.log('[db] PostgreSQL connected ✅')

    const pgify = sql => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`) }

    _db = {
      _type: 'pg',
      async all(sql, params = []) {
        const { rows } = await pool.query(pgify(sql), params)
        return rows
      },
      async get(sql, params = []) {
        const { rows } = await pool.query(pgify(sql), params)
        return rows[0] ?? null
      },
      async run(sql, params = []) {
        const q = pgify(sql)
        const isInsert = /^\s*INSERT/i.test(q) && !/RETURNING/i.test(q)
        const { rows, rowCount } = await pool.query(isInsert ? q + ' RETURNING id' : q, params)
        return { lastInsertRowid: rows[0]?.id ?? null, changes: rowCount }
      },
      async exec(sql) { await pool.query(sql) },
      // Compat shim cho code dùng db.prepare()
      prepare(sql) {
        return {
          run:  (...a) => _db.run(sql, flat(a)),
          get:  (...a) => _db.get(sql, flat(a)),
          all:  (...a) => _db.all(sql, flat(a)),
        }
      },
    }
  } else {
    // ── SQLite ──────────────────────────────────────────────────────────────
    const { default: Database } = await import('better-sqlite3')
    const dataDir = process.env.DATA_DIR || resolve(__dirname, '../../data')
    mkdirSync(dataDir, { recursive: true })
    const sqlite = new Database(resolve(dataDir, 'calls.db'))
    sqlite.exec(SQLITE_SCHEMA)
    try { sqlite.exec(`ALTER TABLE test_collections ADD COLUMN collection_id TEXT`) } catch (_) {}
    console.log('[db] SQLite connected ✅ (local)')

    _db = {
      _type: 'sqlite',
      async all(sql, params = []) { return sqlite.prepare(sql).all(...params) },
      async get(sql, params = [])  { return sqlite.prepare(sql).get(...params) ?? null },
      async run(sql, params = [])  {
        const r = sqlite.prepare(sql).run(...params)
        return { lastInsertRowid: r.lastInsertRowid, changes: r.changes }
      },
      async exec(sql) { sqlite.exec(sql) },
      prepare(sql)    { return sqlite.prepare(sql) },
    }
  }

  return _db
}

function flat(args) {
  return args.length === 1 && Array.isArray(args[0]) ? args[0] : args
}

// Proxy: throw rõ ràng nếu dùng trước khi initDb()
export default new Proxy({}, {
  get(_, prop) {
    if (!_db) throw new Error('[db] Not initialized — call initDb() first in index.js')
    const val = _db[prop]
    return typeof val === 'function' ? val.bind(_db) : val
  },
})
