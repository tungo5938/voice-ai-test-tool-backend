import { Router } from 'express'
import db from '../services/db.js'
import { runPostmanCollection } from '../services/postmanRunner.js'
import { fetchPostmanCollection, listPostmanCollections } from '../services/postmanApi.js'

const router = Router()

// ── Collections ──────────────────────────────────────────────────────────────

// GET /api/postman/collections
router.get('/collections', async (req, res) => {
  const rows = await db.all(`SELECT * FROM test_collections ORDER BY created_at DESC`)
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

  try {
    await fetchPostmanCollection(collection_id)
  } catch (err) {
    return res.status(400).json({ error: `Cannot fetch collection from Postman: ${err.message}` })
  }

  const r = await db.run(
    `INSERT INTO test_collections (name, collection_id, file_path) VALUES (?, ?, '')`,
    [name, collection_id]
  )
  res.json({ ok: true, id: r.lastInsertRowid })
})

// DELETE /api/postman/collections/:id
router.delete('/collections/:id', async (req, res) => {
  await db.run(`DELETE FROM test_collections WHERE id = ?`, [req.params.id])
  res.json({ ok: true })
})

// GET /api/postman/collections/:id/requests — fetch from Postman Cloud, return list of requests
router.get('/collections/:id/requests', async (req, res) => {
  const col = await db.get(`SELECT * FROM test_collections WHERE id = ?`, [req.params.id])
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
router.get('/collections/:id/ac-rules', async (req, res) => {
  const rules = await db.all(
    `SELECT * FROM ac_rules WHERE collection_id = ? ORDER BY request_name, id`,
    [req.params.id]
  )
  res.json(rules)
})

// POST /api/postman/collections/:id/ac-rules
router.post('/collections/:id/ac-rules', async (req, res) => {
  const { request_name, field_path, operator = 'eq', expected_value } = req.body
  if (!request_name || !field_path) return res.status(400).json({ error: 'missing fields' })
  const r = await db.run(
    `INSERT INTO ac_rules (collection_id, request_name, field_path, operator, expected_value) VALUES (?, ?, ?, ?, ?)`,
    [req.params.id, request_name, field_path, operator, expected_value ?? null]
  )
  res.json({ ok: true, id: r.lastInsertRowid })
})

// PUT /api/postman/ac-rules/:id
router.put('/ac-rules/:id', async (req, res) => {
  const { field_path, operator, expected_value } = req.body
  await db.run(
    `UPDATE ac_rules SET field_path=?, operator=?, expected_value=? WHERE id=?`,
    [field_path, operator, expected_value ?? null, req.params.id]
  )
  res.json({ ok: true })
})

// DELETE /api/postman/ac-rules/:id
router.delete('/ac-rules/:id', async (req, res) => {
  await db.run(`DELETE FROM ac_rules WHERE id = ?`, [req.params.id])
  res.json({ ok: true })
})

// ── Test Runs ─────────────────────────────────────────────────────────────────

// POST /api/postman/run
// Body: { collectionId, orderIds: [], requestNames: [] }
router.post('/run', async (req, res) => {
  const { collectionId, orderIds = [], requestNames = [] } = req.body
  if (!collectionId || !orderIds.length) return res.status(400).json({ error: 'missing collectionId or orderIds' })

  const col = await db.get(`SELECT * FROM test_collections WHERE id = ?`, [collectionId])
  if (!col) return res.status(404).json({ error: 'collection not found' })

  // Lấy order codes
  const orders = (await Promise.all(
    orderIds.map(id => db.get(`SELECT id, order_code FROM orders WHERE id = ?`, [id]))
  )).filter(Boolean)
  const orderCodes = orders.map(o => o.order_code).filter(Boolean)
  if (!orderCodes.length) return res.status(400).json({ error: 'no created orders with order_code' })

  // Tạo run record
  const runRow = await db.run(
    `INSERT INTO api_test_runs (collection_id, order_codes, status) VALUES (?, ?, 'running')`,
    [collectionId, JSON.stringify(orderCodes)]
  )
  const runId = runRow.lastInsertRowid

  res.json({ ok: true, runId })

  try {
    await runPostmanCollection({ col, runId, orderCodes, requestNames })
    await db.run(`UPDATE api_test_runs SET status = 'done' WHERE id = ?`, [runId])
  } catch (err) {
    await db.run(`UPDATE api_test_runs SET status = 'failed' WHERE id = ?`, [runId])
    console.error('[postman/run] error:', err.message)
  }
})

// GET /api/postman/runs
router.get('/runs', async (req, res) => {
  const runs = await db.all(`
    SELECT r.*, c.name as collection_name
    FROM api_test_runs r
    LEFT JOIN test_collections c ON c.id = r.collection_id
    ORDER BY r.created_at DESC LIMIT 50
  `)
  res.json(runs.map(r => ({ ...r, order_codes: JSON.parse(r.order_codes || '[]') })))
})

// GET /api/postman/runs/:id/results
router.get('/runs/:id/results', async (req, res) => {
  const results = await db.all(
    `SELECT * FROM api_test_results WHERE run_id = ? ORDER BY id ASC`,
    [req.params.id]
  )
  res.json(results.map(r => ({
    ...r,
    actual_response: tryParse(r.actual_response),
    ac_results: tryParse(r.ac_results),
  })))
})

// GET /api/postman/runs/:id/status — poll
router.get('/runs/:id/status', async (req, res) => {
  const run = await db.get(`SELECT id, status FROM api_test_runs WHERE id = ?`, [req.params.id])
  if (!run) return res.status(404).json({ error: 'not found' })
  res.json(run)
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractRequests(collection, prefix = '') {
  const results = []
  const items = collection.item || []
  for (const item of items) {
    if (item.item) {
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
