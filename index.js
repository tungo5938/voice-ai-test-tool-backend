import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { initDb } from './services/db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
import click2callRouter from './routes/click2call.js'
import webhookRouter from './routes/webhook.js'
import sseRouter from './routes/sse.js'
import testcasesRouter from './routes/testcases.js'
import reportsRouter from './routes/reports.js'
import ordersRouter from './routes/orders.js'
import postmanRouter from './routes/postman.js'
import monitorRouter from './routes/monitor.js'
import { sessionMap } from './services/sessionMap.js'
import { getPitelToken } from './services/pitelAuth.js'
import fetch from 'node-fetch'

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

app.use('/api/click2call', click2callRouter)
app.use('/api/webhook', webhookRouter)
app.use('/api/sse', sseRouter)
app.use('/api/testcases', testcasesRouter)
app.use('/api/reports', reportsRouter)
app.use('/api/orders', ordersRouter)
app.use('/api/postman', postmanRouter)
app.use('/api/monitor', monitorRouter)

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() })
})

// View call events
import db from './services/db.js'
app.get('/api/dev/events', async (req, res) => {
  const rows = await db.all('SELECT * FROM call_events ORDER BY id DESC LIMIT 100')
  res.json(rows.map(r => ({ ...r, payload: JSON.parse(r.payload || '{}') })))
})

// View calls
app.get('/api/dev/calls', async (req, res) => {
  const rows = await db.all('SELECT * FROM calls ORDER BY id DESC LIMIT 100')
  res.json(rows)
})

// Open browser for GHN login (local only)
import { openBrowserForLogin } from './services/orderCreator.js'
app.post('/api/orders/open-browser', async (req, res) => {
  const { environment = 'test' } = req.body
  const result = await openBrowserForLogin(environment)
  res.json(result)
})

// Debug: query Pitel CDR
app.get('/api/dev/pitel-cdr/:callId', async (req, res) => {
  try {
    const token = await getPitelToken()
    const r = await fetch(`${process.env.PITEL_BASE_URL}/v1/cdr/${req.params.callId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    res.json(await r.json())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/dev/seed-session', (req, res) => {
  const { callId, sessionId } = req.body
  if (!callId || !sessionId) return res.status(400).json({ error: 'missing callId or sessionId' })
  sessionMap.set(callId, sessionId)
  res.json({ ok: true, callId, sessionId })
})

// Serve frontend static files (production)
const frontendDist = resolve(__dirname, '../frontend/dist')
if (existsSync(frontendDist)) {
  app.use(express.static(frontendDist))
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(resolve(frontendDist, 'index.html'))
    }
  })
  console.log('[static] Serving frontend from', frontendDist)
}

// Init DB trước khi start server
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`)
  })
}).catch(err => {
  console.error('[startup] DB init failed:', err.message)
  process.exit(1)
})
