import { Router } from 'express'
import { sessionMap, sseClients } from '../services/sessionMap.js'
import { getPitelToken } from '../services/pitelAuth.js'
import fetch from 'node-fetch'
import db from '../services/db.js'

const router = Router()

// Query Pitel CDR API để lấy billsec của click2call leg
async function getPitelBillsec(clickCallId) {
  try {
    const token = await getPitelToken()
    const res = await fetch(`${process.env.PITEL_BASE_URL}/v1/cdr/${clickCallId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json()
    return data?.billsec ?? null
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

  // Lưu raw event
  db.prepare(`INSERT INTO call_events (call_id, event, payload) VALUES (?, ?, ?)`)
    .run(callId, event, JSON.stringify(payload))

  const vr = payload.voicebot_result || {}
  const transcripts = vr.transcripts ? JSON.stringify(vr.transcripts) : null
  const callResult = vr.call_result || null

  // Async: upsert sau khi match xong
  processWebhook({ callId, event, payload, vr, transcripts, callResult })
})

async function processWebhook({ callId, event, payload, vr, transcripts, callResult }) {
  // 1. Thử exact match
  let existing = db.prepare(`SELECT id, call_id FROM calls WHERE call_id = ?`).get(callId)

  // 2. Fallback: match theo billsec từ Pitel CDR API — unique kể cả multi-user
  if (!existing && payload.to_number && payload.billsec) {
    const candidates = db.prepare(`
      SELECT id, call_id FROM calls
      WHERE state = 'initiated' AND phone = ?
        AND datetime(created_at) >= datetime('now', '-30 minutes', 'localtime')
      ORDER BY created_at ASC
    `).all(payload.to_number)

    for (const candidate of candidates) {
      const pitelBillsec = await getPitelBillsec(candidate.call_id)
      console.log(`[webhook] Checking candidate ${candidate.call_id}: pitel_billsec=${pitelBillsec} vs cdr_billsec=${payload.billsec}`)
      if (pitelBillsec !== null && pitelBillsec === payload.billsec) {
        console.log(`[webhook] ✅ Matched CDR ${callId} → ${candidate.call_id} via billsec=${payload.billsec}`)
        db.prepare(`UPDATE calls SET call_id = ? WHERE id = ?`).run(callId, candidate.id)
        const sid = sessionMap.get(candidate.call_id)
        if (sid) { sessionMap.set(callId, sid); sessionMap.delete(candidate.call_id) }
        existing = { id: candidate.id, call_id: callId }
        break
      }
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
