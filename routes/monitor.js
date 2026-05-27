import { Router } from 'express'
import db from '../services/db.js'

const router = Router()

// GET /api/monitor/events?page=1&limit=50
router.get('/events', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50
  const offset = parseInt(req.query.offset) || 0

  const rows = await db.all(
    `SELECT ce.id, ce.call_id, ce.event, ce.payload, ce.received_at,
            cr.rating, cr.comment
     FROM call_events ce
     LEFT JOIN call_reviews cr ON cr.call_id = ce.call_id
     WHERE ce.event = 'completed'
     ORDER BY ce.id DESC
     LIMIT ? OFFSET ?`,
    [limit, offset]
  )

  const result = rows.map(r => {
    let payload = {}
    try { payload = JSON.parse(r.payload || '{}') } catch {}

    const vr = payload.voicebot_result || {}
    return {
      id: r.id,
      call_id: r.call_id,
      event: r.event,
      received_at: r.received_at,
      // Từ payload
      billsec: payload.billsec ?? null,
      duration: payload.duration ?? null,
      from_number: payload.from_number ?? null,
      recording_url: payload.recording_url ?? null,
      status: payload.status ?? null,
      transcripts: vr.transcripts ?? [],
      // Review
      rating: r.rating ?? null,
      comment: r.comment ?? null,
    }
  })

  res.json(result)
})

// POST /api/monitor/:callId/review — tạo hoặc update review
router.post('/:callId/review', async (req, res) => {
  const { callId } = req.params
  const { rating, comment } = req.body

  const existing = await db.get('SELECT id FROM call_reviews WHERE call_id = ?', [callId])

  if (existing) {
    await db.run(
      `UPDATE call_reviews SET rating = ?, comment = ?, updated_at = CURRENT_TIMESTAMP WHERE call_id = ?`,
      [rating ?? null, comment ?? null, callId]
    )
  } else {
    await db.run(
      `INSERT INTO call_reviews (call_id, rating, comment) VALUES (?, ?, ?)`,
      [callId, rating ?? null, comment ?? null]
    )
  }

  res.json({ ok: true })
})

export default router
