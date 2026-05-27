import { Router } from 'express'
import db from '../services/db.js'
import { runPostmanCollection } from '../services/postmanRunner.js'
import { fetchPostmanCollection, listPostmanCollections } from '../services/postmanApi.js'

const router = Router()

// ── Collections ──────────────────────────────────────────────────────────────

// GET /api/postman/collections
router.get('/collections', (req, res) => {
  const rows = db.prepare(`SELECT * FROM test_collections ORDER BY created_at DESC`).all()
  res.json(rows)
})

// GET /api/postman/postman-cloud-collections — list collections from Postman Cloud
router.get('/postman-cloud-collections', async (req, res) => {
  try {
    const collections = await listPostmanCollections()
    res.json(collections)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/postman/collections
// Body: { name, collection_id }  — collection_id is the Postman Cloud UID
router.post('/collections', async (req, res) => {
  const { name, collection_id } = req.body
  if (!name || !collection_id) return res.status(400).json({ error: 'missing name or collection_id' })

  // Validate by fetching from Postman Cloud
  try {
    await fetchPostmanCollection(collection_id)
  } catch (err) {
    return res.status(400).json({ error: `Cannot fetch collection from Postman: ${err.message}` })
  }

  const r = db.prepare(`INSERT INTO test_collections (name, collection_id, file_path) VALUES (?, ?, '')`).run(name, collection_id)
  res.json({ ok: true, id: r.lastInsertRowid })
})

// DELETE /api/postman/collections/:id
router.delete('/collections/:id', (req, res) => {
  db.prepare(`DELETE FROM test_collections WHERE id = ?`).run(req.params.id)
  res.json({ ok: true })
})

// GET /api/postman/collections/:id/requests — fetch from Postman Cloud, return list of requests
router.get('/collections/:id/requests', async (req, res) => {
  const col = db.prepare(`SELECT * FROM test_collections WHERE id = ?`).get(req.params.id)
  if (!col) return res.status(404).json({ error: 'not found' })
  try {
    const collection = await fetchPostmanCollection(col.collection_id)
    const requests = extractRequests(collection)
    res.json(requests)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── AC Rules ──────────────────────────────────────────────────────────────────

// GET /api/postman/collections/:id/ac-rules
router.get('/collections/:id/ac-rules', (req, res) => {
  const rules = db.prepare(`SELECT * FROM ac_rules WHERE collection_id = ? ORDER BY request_name, id`).all(req.params.id)
  res.json(rules)
})

// POST /api/postman/collections/:id/ac-rules
router.post('/collections/:id/ac-rules', (req, res) => {
  const { request_name, field_path, operator = 'eq', expected_value } = req.body
  if (!request_name || !field_path) return res.status(400).json({ error: 'missing fields' })
  const r = db.prepare(
    `INSERT INTO ac_rules (collection_id, request_name, field_path, operator, expected_value) VALUES (?, ?, ?, ?, ?)`
  ).run(req.params.id, request_name, field_path, operator, expected_value ?? null)
  res.json({ ok: true, id: r.lastInsertRowid })
})

// PUT /api/postman/ac-rules/:id
router.put('/ac-rules/:id', (req, res) => {
  const { field_path, operator, expected_value } = req.body
  db.prepare(`UPDATE ac_rules SET field_path=?, operator=?, expected_value=? WHERE id=?`)
    .run(field_path, operator, expected_value ?? null, req.params.id)
  res.json({ ok: true })
})

// DELETE /api/postman/ac-rules/:id
router.delete('/ac-rules/:id', (req, res) => {
  db.prepare(`DELETE FROM ac_rules WHERE id = ?`).run(req.params.id)
  res.json({ ok: true })
})

// ── Test Runs ─────────────────────────────────────────────────────────────────

// POST /api/postman/run
// Body: { collectionId, orderIds: [], requestNames: [] }
router.post('/run', async (req, res) => {
  const { collectionId, orderIds = [], requestNames = [] } = req.body
  if (!collectionId || !orderIds.length) return res.status(400).json({ error: 'missing collectionId or orderIds' })

  const col = db.prepare(`SELECT * FROM test_collections WHERE id = ?`).get(collectionId)
  if (!col) return res.status(404).json({ error: 'collection not found' })

  // Lấy order codes
  const orders = orderIds.map(id => db.prepare(`SELECT id, order_code FROM orders WHERE id = ?`).get(id)).filter(Boolean)
  const orderCodes = orders.map(o => o.order_code).filter(Boolean)
  if (!orderCodes.length) return res.status(400).json({ error: 'no created orders with order_code' })

  // Tạo run record
  const runRow = db.prepare(`INSERT INTO api_test_runs (collection_id, order_codes, status) VALUES (?, ?, 'running')`)
    .run(collectionId, JSON.stringify(orderCodes))
  const runId = runRow.lastInsertRowid

  res.json({ ok: true, runId })

  // Chạy async
  try {
    await runPostmanCollection({ col, runId, orderCodes, requestNames })
    db.prepare(`UPDATE api_test_runs SET status = 'done' WHERE id = ?`).run(runId)
  } catch (err) {
    db.prepare(`UPDATE api_test_runs SET status = 'failed' WHERE id = ?`).run(runId)
    console.error('[postman/run] error:', err.message)
  }
})

// GET /api/postman/runs
router.get('/runs', (req, res) => {
  const runs = db.prepare(`
    SELECT r.*, c.name as collection_name
    FROM api_test_runs r
    LEFT JOIN test_collections c ON c.id = r.collection_id
    ORDER BY r.created_at DESC LIMIT 50
  `).all()
  res.json(runs.map(r => ({ ...r, order_codes: JSON.parse(r.order_codes || '[]') })))
})

// GET /api/postman/runs/:id/results
router.get('/runs/:id/results', (req, res) => {
  const results = db.prepare(`SELECT * FROM api_test_results WHERE run_id = ? ORDER BY id ASC`).all(req.params.id)
  res.json(results.map(r => ({
    ...r,
    actual_response: tryParse(r.actual_response),
    ac_results: tryParse(r.ac_results),
  })))
})

// GET /api/postman/runs/:id/status — poll
router.get('/runs/:id/status', (req, res) => {
  const run = db.prepare(`SELECT id, status FROM api_test_runs WHERE id = ?`).get(req.params.id)
  if (!run) return res.status(404).json({ error: 'not found' })
  res.json(run)
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractRequests(collection, prefix = '') {
  const results = []
  const items = collection.item || []
  for (const item of items) {
    if (item.item) {
      // folder
      results.push(...extractRequests(item, prefix ? `${prefix} / ${item.name}` : item.name))
    } else if (item.request) {
      results.push({
        name: item.name,
        fullName: prefix ? `${prefix} / ${item.name}` : item.name,
        method: item.request.method || 'GET',
        url: typeof item.request.url === 'string' ? item.request.url : item.request.url?.raw || '',
      })
    }
  }
  return results
}

function tryParse(str) {
  try { return JSON.parse(str) } catch { return str }
}

export default router
