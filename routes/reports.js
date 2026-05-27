import { Router } from 'express'
import db from '../services/db.js'

const router = Router()

// GET /api/reports — paginated list of all calls
router.get('/', async (req, res) => {
  const { limit = 50, offset = 0 } = req.query
  const calls = await db.all(
    `SELECT * FROM calls ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [Number(limit), Number(offset)]
  )
  const row = await db.get(`SELECT COUNT(*) as count FROM calls`)
  res.json({ calls, total: row.count })
})

// GET /api/reports/by-testcase — latest call result per test_case_id + call count
router.get('/by-testcase', async (req, res) => {
  const counts = await db.all(`
    SELECT test_case_id, COUNT(*) as call_count
    FROM calls
    WHERE test_case_id IS NOT NULL
    GROUP BY test_case_id
  `)

  const result = {}
  for (const row of counts) {
    const latest = await db.get(`
      SELECT * FROM calls
      WHERE test_case_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `, [row.test_case_id])

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
router.get('/history/:testCaseId', async (req, res) => {
  const calls = await db.all(`
    SELECT * FROM calls
    WHERE test_case_id = ?
    ORDER BY created_at DESC, id DESC
  `, [req.params.testCaseId])
  res.json(calls)
})

// GET /api/reports/:callId/events — raw events for a call
router.get('/:callId/events', async (req, res) => {
  const events = await db.all(
    `SELECT * FROM call_events WHERE call_id = ? ORDER BY received_at ASC`,
    [req.params.callId]
  )
  res.json(events)
})

// PATCH /api/reports/:callId — update test_case_id / ext on a call
router.patch('/:callId', async (req, res) => {
  const { test_case_id, ext } = req.body
  await db.run(
    `UPDATE calls SET test_case_id=?, ext=?, updated_at=CURRENT_TIMESTAMP WHERE call_id=?`,
    [test_case_id || null, ext || null, req.params.callId]
  )
  res.json({ ok: true })
})

export default router
