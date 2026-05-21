import { Router } from 'express'
import { sessionMap, sseClients } from '../services/sessionMap.js'
import db from '../services/db.js'

const router = Router()

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

  // Lưu raw event
  db.prepare(`INSERT INTO call_events (call_id, event, payload) VALUES (?, ?, ?)`)
    .run(callId, event, JSON.stringify(payload))

  const vr = payload.voicebot_result || {}
  const transcripts = vr.transcripts ? JSON.stringify(vr.transcripts) : null
  const callResult = vr.call_result || null

  // Upsert call record
  let existing = db.prepare(`SELECT id, call_id FROM calls WHERE call_id = ?`).get(callId)

  // Fallback: nếu CDR call_id không khớp với click2call call_id,
  // tìm bản ghi 'initiated' cùng số điện thoại trong vòng 10 phút
  if (!existing && payload.to_number) {
    const orphan = db.prepare(`
      SELECT id, call_id FROM calls
      WHERE state = 'initiated' AND phone = ?
        AND datetime(created_at) >= datetime('now', '-10 minutes', 'localtime')
      ORDER BY created_at DESC LIMIT 1
    `).get(payload.to_number)
    if (orphan) {
      console.log(`[webhook] Matched CDR ${callId} → initiated record ${orphan.call_id} via phone ${payload.to_number}`)
      // Cập nhật call_id cũ thành call_id từ CDR, giữ nguyên test_case_id
      db.prepare(`UPDATE calls SET call_id = ? WHERE id = ?`).run(callId, orphan.id)
      // Cập nhật sessionMap nếu có
      const sid = sessionMap.get(orphan.call_id)
      if (sid) { sessionMap.set(callId, sid); sessionMap.delete(orphan.call_id) }
      existing = { id: orphan.id, call_id: callId }
    }
  }

  if (!existing) {
    db.prepare(`
      INSERT INTO calls (call_id, state, from_number, to_number, hotline,
        duration, billsec, recording_url, call_result, transcripts, voicebot_result, time_started)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      callId, event,
      payload.from_number || null, payload.to_number || null, payload.hotline || null,
      payload.duration || null, payload.billsec || null,
      payload.recording_url || null, callResult, transcripts,
      JSON.stringify(vr),
      payload.time_started || new Date().toISOString()
    )
  } else {
    db.prepare(`
      UPDATE calls SET
        state=?, from_number=COALESCE(from_number,?), to_number=COALESCE(to_number,?),
        hotline=COALESCE(hotline,?), duration=COALESCE(?,duration),
        billsec=COALESCE(?,billsec), recording_url=COALESCE(?,recording_url),
        call_result=COALESCE(?,call_result), transcripts=COALESCE(?,transcripts),
        voicebot_result=COALESCE(?,voicebot_result),
        updated_at=datetime('now','localtime')
      WHERE call_id=?
    `).run(
      event,
      payload.from_number || null, payload.to_number || null, payload.hotline || null,
      payload.duration || null, payload.billsec || null,
      payload.recording_url || null, callResult, transcripts,
      vr && Object.keys(vr).length ? JSON.stringify(vr) : null,
      callId
    )
  }

  // Push SSE về frontend nếu có session đang lắng nghe
  const sessionId = sessionMap.get(callId)
  if (sessionId) {
    const client = sseClients.get(sessionId)
    if (client) {
      client.write(`data: ${JSON.stringify({ callId, event, ...payload })}\n\n`)
    }
  }
})

export default router
