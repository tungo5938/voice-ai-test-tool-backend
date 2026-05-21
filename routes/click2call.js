import { Router } from 'express'
import fetch from 'node-fetch'
import { sessionMap } from '../services/sessionMap.js'
import { getPitelToken } from '../services/pitelAuth.js'
import db from '../services/db.js'

const router = Router()

router.post('/', async (req, res) => {
  const { ext, phone, testCaseId, sessionId } = req.body

  if (!ext || !/^\d{3,6}$/.test(ext)) {
    return res.status(400).json({ status: 'fail', error: 'INVALID_EXT' })
  }
  if (!phone) {
    return res.status(400).json({ status: 'fail', error: 'MISSING_PHONE' })
  }

  // Dev mode: no credentials configured
  if (!process.env.PITEL_BASE_URL || !process.env.PITEL_TOKEN) {
    const fakeCallId = `dev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    console.log(`[DEV] Simulated click2call: ext=${ext} phone=${phone} testCase=${testCaseId}`)
    if (sessionId) sessionMap.set(fakeCallId, sessionId)
    return res.json({ status: 'success', call_id: fakeCallId, dev: true })
  }

  try {
    const token = await getPitelToken()

    const params = new URLSearchParams({ ext, phone, auto_answer: 'false' })
    if (process.env.PITEL_HOTLINE) params.set('hotline', process.env.PITEL_HOTLINE)

    console.log(`[click2call] ext=${ext} phone=${phone} testCase=${testCaseId}`)

    const pitelRes = await fetch(`${process.env.PITEL_BASE_URL}/v1/click2call?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await pitelRes.json()
    console.log('[click2call] Pitel response:', JSON.stringify(data))

    if (data.status === 'success' && data.call_id) {
      if (sessionId) sessionMap.set(data.call_id, sessionId)
      // Lưu cuộc gọi vào DB ngay khi khởi tạo thành công
      db.prepare(`
        INSERT OR IGNORE INTO calls (call_id, test_case_id, ext, phone, state, time_started)
        VALUES (?, ?, ?, ?, 'initiated', datetime('now','localtime'))
      `).run(data.call_id, testCaseId || null, ext, phone)
      return res.json({ status: 'success', call_id: data.call_id })
    }

    return res.json({ status: 'fail', error: data.error || JSON.stringify(data) })
  } catch (err) {
    console.error('[click2call] error:', err.message)
    return res.status(502).json({ status: 'fail', error: err.message })
  }
})

export default router
