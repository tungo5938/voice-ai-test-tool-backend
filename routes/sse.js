import { Router } from 'express'
import { sseClients } from '../services/sessionMap.js'

const router = Router()

router.get('/', (req, res) => {
  const sessionId = req.query.sessionId
  if (!sessionId) return res.status(400).json({ error: 'missing sessionId' })

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  sseClients.set(sessionId, res)
  res.write(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`)

  req.on('close', () => {
    sseClients.delete(sessionId)
  })
})

export default router
