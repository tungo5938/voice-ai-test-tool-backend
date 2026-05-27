import { Router } from 'express'
import db from '../services/db.js'
import { createOrder } from '../services/orderCreator.js'

const router = Router()

// GET /api/orders/groups?env=test|prod
router.get('/groups', (req, res) => {
  const env = req.query.env || 'test'
  const groups = db.prepare(`SELECT * FROM order_groups WHERE environment = ? ORDER BY created_at DESC`).all(env)
  const result = groups.map(g => ({
    ...g,
    orders: db.prepare(`SELECT * FROM orders WHERE group_id = ? ORDER BY id ASC`).all(g.id)
      .map(o => ({ ...o, data: JSON.parse(o.data || '{}') }))
  }))
  res.json(result)
})

// POST /api/orders/group
router.post('/group', (req, res) => {
  const { name = 'Default', environment = 'test' } = req.body
  const r = db.prepare(`INSERT INTO order_groups (name, environment) VALUES (?, ?)`).run(name, environment)
  res.json({ ok: true, id: r.lastInsertRowid })
})

// DELETE /api/orders/group/:id
router.delete('/group/:id', (req, res) => {
  db.prepare(`DELETE FROM order_groups WHERE id = ?`).run(req.params.id)
  res.json({ ok: true })
})

// POST /api/orders — thêm 1 order row
router.post('/', (req, res) => {
  const { group_id, data = {} } = req.body
  if (!group_id) return res.status(400).json({ error: 'missing group_id' })
  const r = db.prepare(`INSERT INTO orders (group_id, data) VALUES (?, ?)`).run(group_id, JSON.stringify(data))
  res.json({ ok: true, id: r.lastInsertRowid })
})

// PUT /api/orders/:id
router.put('/:id', (req, res) => {
  const { data } = req.body
  db.prepare(`UPDATE orders SET data = ? WHERE id = ?`).run(JSON.stringify(data), req.params.id)
  res.json({ ok: true })
})

// DELETE /api/orders/:id
router.delete('/:id', (req, res) => {
  db.prepare(`DELETE FROM orders WHERE id = ?`).run(req.params.id)
  res.json({ ok: true })
})

// POST /api/orders/:id/create — trigger Playwright tạo đơn
router.post('/:id/create', async (req, res) => {
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.params.id)
  if (!order) return res.status(404).json({ error: 'not found' })

  const group = db.prepare(`SELECT * FROM order_groups WHERE id = ?`).get(order.group_id)
  if (!group) return res.status(404).json({ error: 'group not found' })

  // Mark as creating
  db.prepare(`UPDATE orders SET status = 'creating', error = NULL WHERE id = ?`).run(order.id)

  // Run async, respond immediately
  res.json({ ok: true, status: 'creating' })

  try {
    const result = await createOrder(JSON.parse(order.data || '{}'), group.environment)
    if (result.success) {
      db.prepare(`UPDATE orders SET order_code = ?, status = 'created' WHERE id = ?`).run(result.order_code, order.id)
    } else {
      db.prepare(`UPDATE orders SET status = 'failed', error = ? WHERE id = ?`).run(result.error, order.id)
    }
  } catch (err) {
    db.prepare(`UPDATE orders SET status = 'failed', error = ? WHERE id = ?`).run(err.message, order.id)
  }
})

// POST /api/orders/group/:id/create-all
router.post('/group/:id/create-all', async (req, res) => {
  const orders = db.prepare(`SELECT * FROM orders WHERE group_id = ? AND status IN ('pending','failed')`).all(req.params.id)
  if (!orders.length) return res.json({ ok: true, count: 0 })

  const group = db.prepare(`SELECT * FROM order_groups WHERE id = ?`).get(req.params.id)
  res.json({ ok: true, count: orders.length, status: 'creating' })

  for (const order of orders) {
    db.prepare(`UPDATE orders SET status = 'creating', error = NULL WHERE id = ?`).run(order.id)
    try {
      const result = await createOrder(JSON.parse(order.data || '{}'), group.environment)
      if (result.success) {
        db.prepare(`UPDATE orders SET order_code = ?, status = 'created' WHERE id = ?`).run(result.order_code, order.id)
      } else {
        db.prepare(`UPDATE orders SET status = 'failed', error = ? WHERE id = ?`).run(result.error, order.id)
      }
    } catch (err) {
      db.prepare(`UPDATE orders SET status = 'failed', error = ? WHERE id = ?`).run(err.message, order.id)
    }
  }
})

// GET /api/orders/:id/status — poll status sau khi trigger tạo
router.get('/:id/status', (req, res) => {
  const order = db.prepare(`SELECT id, order_code, status, error FROM orders WHERE id = ?`).get(req.params.id)
  if (!order) return res.status(404).json({ error: 'not found' })
  res.json(order)
})

export default router
