import { Router } from 'express'
import { sessionMap, sseClients } from '../services/sessionMap.js'
import { getPitelToken } from '../services/pitelAuth.js'
import fetch from 'node-fetch'
import db from '../services/db.js'

const router = Router()

// Query Pitel CDR API lấy time_ended của click2call leg
async function getPitelTimeEnded(clickCallId) {
  try {
    const token = await getPitelToken()
    const res = await fetch(`${process.env.PITEL_BASE_URL}/v1/cdr/${clickCallId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json()
    if (!data?.time_ended) return null
    // time_ended từ Pitel là giờ VN (UTC+7) → đổi sang UTC timestamp
    const utcMs = new Date(data.time_ended.replace(' ', 'T') + '+07:00').getTime()
    return Math.floor(utcMs / 1000) // unix seconds UTC
  } catch {
    return null
  }
}

router.post('/pitel', (req, res) => {
  // Verify secret nếu có config
  const secret = process.env.WEBHOOK_SECRET
  if (secret && req.query.secret !== secret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  // Respond 200 immediately — Pitel không retry
  res.sendStatus(200)

  const payload = req.body
  const callId = payload.call_id
  if (!callId) return

  const event = payload.state || payload.event || 'unknown'
  console.log(`[webhook] event=${event} callId=${callId}`, JSON.stringify(payload))

  // Async processing — fire and forget
  processWebhook({ callId, event, payload }).catch(err =>
    console.error('[webhook] processWebhook error:', err.message)
  )
})

async function processWebhook({ callId, event, payload }) {
  const vr = payload.voicebot_result || {}
  const transcripts = vr.transcripts ? JSON.stringify(vr.transcripts) : null
  const callResult = vr.call_result || null

  // Lưu raw event
  await db.run(
    `INSERT INTO call_events (call_id, event, payload) VALUES (?, ?, ?)`,
    [callId, event, JSON.stringify(payload)]
  )

  // 1. Thử exact match
  let existing = await db.get(`SELECT id, call_id FROM calls WHERE call_id = ?`, [callId])

  // 2. Fallback: match theo time_ended từ Pitel CDR API (gap 30-600s sau khi voicebot CDR đến)
  if (!existing && payload.to_number) {
    // Dùng JS để tính thời điểm 30 phút trước (tương thích SQLite + PostgreSQL)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    const candidates = await db.all(`
      SELECT id, call_id FROM calls
      WHERE state = 'initiated' AND phone = ?
        AND created_at >= ?
      ORDER BY created_at ASC
    `, [payload.to_number, thirtyMinutesAgo])

    const nowUtc = Math.floor(Date.now() / 1000)

    for (const candidate of candidates) {
      const timeEndedUTC = await getPitelTimeEnded(candidate.call_id)
      const gapSeconds = timeEndedUTC !== null ? nowUtc - timeEndedUTC : null
      console.log(`[webhook] Checking candidate ${candidate.call_id}: time_ended_utc=${timeEndedUTC} gap=${gapSeconds}s`)
      if (timeEndedUTC !== null && gapSeconds >= 30 && gapSeconds <= 600) {
        console.log(`[webhook] ✅ Matched CDR ${callId} → ${candidate.call_id} via time proximity (gap=${gapSeconds}s)`)
        await db.run(
          `UPDATE calls SET call_id = ?, state = 'matching' WHERE id = ? AND state = 'initiated'`,
          [callId, candidate.id]
        )
        const sid = sessionMap.get(candidate.call_id)
        if (sid) { sessionMap.set(callId, sid); sessionMap.delete(candidate.call_id) }
        existing = { id: candidate.id, call_id: callId }
        break
      }
    }
  }

  if (!existing) {
    await db.run(`
      INSERT INTO calls (call_id, state, from_number, to_number, hotline,
        duration, billsec, recording_url, call_result, transcripts, voicebot_result, time_started)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      callId, event,
      payload.from_number || null, payload.to_number || null, payload.hotline || null,
      payload.duration || null, payload.billsec || null,
      payload.recording_url || null, callResult, transcripts,
      JSON.stringify(vr),
      payload.time_started || new Date().toISOString()
    ])
  } else {
    await db.run(`
      UPDATE calls SET
        state=?, from_number=COALESCE(from_number,?), to_number=COALESCE(to_number,?),
        hotline=COALESCE(hotline,?), duration=COALESCE(?,duration),
        billsec=COALESCE(?,billsec), recording_url=COALESCE(?,recording_url),
        call_result=COALESCE(?,call_result), transcripts=COALESCE(?,transcripts),
        voicebot_result=COALESCE(?,voicebot_result),
        updated_at=CURRENT_TIMESTAMP
      WHERE call_id=?
    `, [
      event,
      payload.from_number || null, payload.to_number || null, payload.hotline || null,
      payload.duration || null, payload.billsec || null,
      payload.recording_url || null, callResult, transcripts,
      vr && Object.keys(vr).length ? JSON.stringify(vr) : null,
      callId
    ])
  }

  // Push SSE về frontend
  const sessionId = sessionMap.get(callId)
  if (sessionId) {
    const client = sseClients.get(sessionId)
    if (client) {
      client.write(`data: ${JSON.stringify({ callId, event, ...payload })}\n\n`)
    }
  }
}

export default router
