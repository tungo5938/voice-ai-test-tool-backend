/**
 * auth.js — Simple API key middleware
 * Protects all /api/* routes except /api/webhook (uses its own secret)
 * and /api/health (public).
 *
 * Set ADMIN_KEY env var on Railway.
 * Frontend sends: Authorization: Bearer <key>
 *           OR:   x-api-key: <key>
 */

const ADMIN_KEY = process.env.ADMIN_KEY

export function requireApiKey(req, res, next) {
  // If no key configured → skip (dev mode)
  if (!ADMIN_KEY) return next()

  // Webhook has its own secret — skip
  if (req.path.startsWith('/api/webhook')) return next()
  // Health check — public
  if (req.path === '/api/health') return next()

  const authHeader = req.headers['authorization']
  const keyHeader  = req.headers['x-api-key']

  const provided =
    (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null) ||
    keyHeader ||
    req.query.api_key

  if (provided === ADMIN_KEY) return next()

  res.status(401).json({ error: 'Unauthorized — invalid or missing API key' })
}
