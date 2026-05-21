import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import click2callRouter from './routes/click2call.js'
import webhookRouter from './routes/webhook.js'
import sseRouter from './routes/sse.js'
import testcasesRouter from './routes/testcases.js'
import reportsRouter from './routes/reports.js'
import { sessionMap } from './services/sessionMap.js'

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

app.use('/api/click2call', click2callRouter)
app.use('/api/webhook', webhookRouter)
app.use('/api/sse', sseRouter)
app.use('/api/testcases', testcasesRouter)
app.use('/api/reports', reportsRouter)

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() })
})

// Debug: view raw call_events
import db from './services/db.js'
app.get('/api/dev/events', (req, res) => {
  const rows = db.prepare('SELECT * FROM call_events ORDER BY id DESC LIMIT 30').all()
  res.json(rows.map(r => ({ ...r, payload: JSON.parse(r.payload || '{}') })))
})

// DEV-ONLY: seed callId→sessionId mapping for E2E SSE testing
app.post('/api/dev/seed-session', (req, res) => {
  const { callId, sessionId } = req.body
  if (!callId || !sessionId) return res.status(400).json({ error: 'missing callId or sessionId' })
  sessionMap.set(callId, sessionId)
  res.json({ ok: true, callId, sessionId })
})

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`)
})
