import { Router } from 'express'
import db from '../services/db.js'

const router = Router()

// GET /api/testcases/groups — all groups with their test cases
router.get('/groups', (req, res) => {
  const groups = db.prepare('SELECT * FROM test_case_groups ORDER BY created_at ASC').all()
  const allCases = db.prepare('SELECT * FROM test_cases ORDER BY created_at ASC').all()

  const result = groups.map(g => ({
    id: g.id,
    name: g.name,
    created_at: g.created_at,
    testCases: allCases
      .filter(tc => tc.group_id === g.id)
      .map(tc => ({
        _id: tc.id,
        tc_id: tc.tc_id,
        ...JSON.parse(tc.columns || '{}'),
      })),
  }))

  res.json(result)
})

// POST /api/testcases/import — create a new group with test cases (add-only)
router.post('/import', (req, res) => {
  const { groupName, tcIdColumn, rows } = req.body

  if (!groupName || !rows?.length) {
    return res.status(400).json({ error: 'Missing groupName or rows' })
  }

  const group = db.prepare('INSERT INTO test_case_groups (name) VALUES (?)').run(groupName)
  const groupId = group.lastInsertRowid

  const insertStmt = db.prepare(
    'INSERT INTO test_cases (tc_id, group_id, columns) VALUES (?, ?, ?)'
  )

  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      const tc_id = row[tcIdColumn] || `TC-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`
      const columns = { ...row }
      delete columns[tcIdColumn]
      insertStmt.run(String(tc_id), groupId, JSON.stringify(columns))
    }
  })

  insertMany(rows)
  res.json({ ok: true, groupId, count: rows.length })
})

// PUT /api/testcases/:id — update editable columns of a test case
router.put('/:id', (req, res) => {
  const { columns } = req.body
  if (!columns) return res.status(400).json({ error: 'Missing columns' })

  const affected = db.prepare(
    `UPDATE test_cases SET columns=?, updated_at=datetime('now','localtime') WHERE id=?`
  ).run(JSON.stringify(columns), Number(req.params.id))

  if (affected.changes === 0) return res.status(404).json({ error: 'Not found' })
  res.json({ ok: true })
})

// DELETE /api/testcases/group/:groupId — delete a whole tab/group
router.delete('/group/:groupId', (req, res) => {
  db.prepare('DELETE FROM test_cases WHERE group_id=?').run(Number(req.params.groupId))
  db.prepare('DELETE FROM test_case_groups WHERE id=?').run(Number(req.params.groupId))
  res.json({ ok: true })
})

export default router
