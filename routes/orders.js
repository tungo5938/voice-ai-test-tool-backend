import { Router } from 'express'
import db from '../services/db.js'
import { createOrder } from '../services/orderCreator.js'

const router = Router()

// GET /api/orders/groups?env=test|prod
router.get('/groups', async (req, res) => {
  const env = req.query.env || 'test'
  const groups = await db.all(`SELECT * FROM order_groups WHERE environment = ? ORDER BY created_at DESC`, [env])
  const result = []
  for (const g of groups) {
    const orders = await db.all(`SELECT * FROM orders WHERE group_id = ? ORDER BY id ASC`, [g.id])
    result.push({
      ...g,
      orders: orders.map(o => ({ ...o, data: JSON.parse(o.data || '{}') }))
    })
  }
  res.json(result)
})

// POST /api/orders/group
router.post('/group', async (req, res) => {
  const { name = 'Default', environment = 'test' } = req.body
  const r = await db.run(`INSERT INTO order_groups (name, environment) VALUES (?, ?)`, [name, environment])
  res.json({ ok: true, id: r.lastInsertRowid })
})

// DELETE /api/orders/group/:id
router.delete('/group/:id', async (req, res) => {
  await db.run(`DELETE FROM order_groups WHERE id = ?`, [req.params.id])
  res.json({ ok: true })
})

// POST /api/orders — thêm 1 order row
router.post('/', async (req, res) => {
  const { group_id, data = {} } = req.body
  if (!group_id) return res.status(400).json({ error: 'missing group_id' })
  const r = await db.run(`INSERT INTO orders (group_id, data) VALUES (?, ?)`, [group_id, JSON.stringify(data)])
  res.json({ ok: true, id: r.lastInsertRowid })
})

// PUT /api/orders/:id
router.put('/:id', async (req, res) => {
  const { data } = req.body
  await db.run(`UPDATE orders SET data = ? WHERE id = ?`, [JSON.stringify(data), req.params.id])
  res.json({ ok: true })
})

// DELETE /api/orders/:id
router.delete('/:id', async (req, res) => {
  await db.run(`DELETE FROM orders WHERE id = ?`, [req.params.id])
  res.json({ ok: true })
})

// POST /api/orders/:id/create — trigger Playwright tạo đơn
router.post('/:id/create', async (req, res) => {
  const order = await db.get(`SELECT * FROM orders WHERE id = ?`, [req.params.id])
  if (!order) return res.status(404).json({ error: 'not found' })

  const group = await db.get(`SELECT * FROM order_groups WHERE id = ?`, [order.group_id])
  if (!group) return res.status(404).json({ error: 'group not found' })

  await db.run(`UPDATE orders SET status = 'creating', error = NULL WHERE id = ?`, [order.id])
  res.json({ ok: true, status: 'creating' })

  try {
    const result = await createOrder(JSON.parse(order.data || '{}'), group.environment)
    if (result.success) {
      await db.run(`UPDATE orders SET order_code = ?, status = 'created' WHERE id = ?`, [result.order_code, order.id])
    } else {
      await db.run(`UPDATE orders SET status = 'failed', error = ? WHERE id = ?`, [result.error, order.id])
    }
  } catch (err) {
    await db.run(`UPDATE orders SET status = 'failed', error = ? WHERE id = ?`, [err.message, order.id])
  }
})

// POST /api/orders/group/:id/create-all
router.post('/group/:id/create-all', async (req, res) => {
  const orders = await db.all(
    `SELECT * FROM orders WHERE group_id = ? AND status IN ('pending','failed')`,
    [req.params.id]
  )
  if (!orders.length) return res.json({ ok: true, count: 0 })

  const group = await db.get(`SELECT * FROM order_groups WHERE id = ?`, [req.params.id])
  res.json({ ok: true, count: orders.length, status: 'creating' })

  for (const order of orders) {
    await db.run(`UPDATE orders SET status = 'creating', error = NULL WHERE id = ?`, [order.id])
    try {
      const result = await createOrder(JSON.parse(order.data || '{}'), group.environment)
      if (result.success) {
        await db.run(`UPDATE orders SET order_code = ?, status = 'created' WHERE id = ?`, [result.order_code, order.id])
      } else {
        await db.run(`UPDATE orders SET status = 'failed', error = ? WHERE id = ?`, [result.error, order.id])
      }
    } catch (err) {
      await db.run(`UPDATE orders SET status = 'failed', error = ? WHERE id = ?`, [err.message, order.id])
    }
  }
})

// GET /api/orders/:id/status — poll status sau khi trigger tạo
router.get('/:id/status', async (req, res) => {
  const order = await db.get(`SELECT id, order_code, status, error FROM orders WHERE id = ?`, [req.params.id])
  if (!order) return res.status(404).json({ error: 'not found' })
  res.json(order)
})

export default router
