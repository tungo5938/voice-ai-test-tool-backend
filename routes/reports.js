import { Router } from 'express'
import db from '../services/db.js'

const router = Router()

// GET /api/reports — paginated list of all calls
router.get('/', (req, res) => {
  const { limit = 50, offset = 0 } = req.query
  const calls = db.prepare(`
    SELECT * FROM calls
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(Number(limit), Number(offset))

  const total = db.prepare(`SELECT COUNT(*) as count FROM calls`).get().count
  res.json({ calls, total })
})

// GET /api/reports/by-testcase — latest call result per test_case_id + call count
router.get('/by-testcase', (req, res) => {
  const counts = db.prepare(`
    SELECT test_case_id, COUNT(*) as call_count
    FROM calls
    WHERE test_case_id IS NOT NULL
    GROUP BY test_case_id
  `).all()

  const result = {}
  for (const row of counts) {
    const latest = db.prepare(`
      SELECT * FROM calls
      WHERE test_case_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(row.test_case_id)

    if (latest) {
      result[row.test_case_id] = {
        ...latest,
        call_count: row.call_count,
      }
    }
  }

  res.json(result)
})

// GET /api/reports/history/:testCaseId — all calls for a test case (newest first)
router.get('/history/:testCaseId', (req, res) => {
  const calls = db.prepare(`
    SELECT * FROM calls
    WHERE test_case_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(req.params.testCaseId)
  res.json(calls)
})

// GET /api/reports/:callId/events — raw events for a call
router.get('/:callId/events', (req, res) => {
  const events = db.prepare(`
    SELECT * FROM call_events WHERE call_id = ? ORDER BY received_at ASC
  `).all(req.params.callId)
  res.json(events)
})

// PATCH /api/reports/:callId — update test_case_id / ext on a call
router.patch('/:callId', (req, res) => {
  const { test_case_id, ext } = req.body
  db.prepare(`UPDATE calls SET test_case_id=?, ext=?, updated_at=datetime('now','localtime') WHERE call_id=?`)
    .run(test_case_id || null, ext || null, req.params.callId)
  res.json({ ok: true })
})

export default router
