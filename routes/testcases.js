import { Router } from 'express'
import db from '../services/db.js'

const router = Router()

// GET /api/testcases/groups — all groups with their test cases
router.get('/groups', async (req, res) => {
  const groups = await db.all('SELECT * FROM test_case_groups ORDER BY created_at ASC')
  const allCases = await db.all('SELECT * FROM test_cases ORDER BY created_at ASC')

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
router.post('/import', async (req, res) => {
  const { groupName, tcIdColumn, rows } = req.body

  if (!groupName || !rows?.length) {
    return res.status(400).json({ error: 'Missing groupName or rows' })
  }

  const group = await db.run('INSERT INTO test_case_groups (name) VALUES (?)', [groupName])
  const groupId = group.lastInsertRowid

  for (const row of rows) {
    const tc_id = row[tcIdColumn] || `TC-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`
    const columns = { ...row }
    delete columns[tcIdColumn]
    await db.run(
      'INSERT INTO test_cases (tc_id, group_id, columns) VALUES (?, ?, ?)',
      [String(tc_id), groupId, JSON.stringify(columns)]
    )
  }

  res.json({ ok: true, groupId, count: rows.length })
})

// PUT /api/testcases/:id — update editable columns of a test case
router.put('/:id', async (req, res) => {
  const { columns } = req.body
  if (!columns) return res.status(400).json({ error: 'Missing columns' })

  const result = await db.run(
    `UPDATE test_cases SET columns=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    [JSON.stringify(columns), Number(req.params.id)]
  )

  if (result.changes === 0) return res.status(404).json({ error: 'Not found' })
  res.json({ ok: true })
})

// DELETE /api/testcases/group/:groupId — delete a whole tab/group
router.delete('/group/:groupId', async (req, res) => {
  await db.run('DELETE FROM test_cases WHERE group_id=?', [Number(req.params.groupId)])
  await db.run('DELETE FROM test_case_groups WHERE id=?', [Number(req.params.groupId)])
  res.json({ ok: true })
})

export default router
