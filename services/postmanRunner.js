/**
 * postmanRunner.js
 * Parse Postman Collection v2.1, inject order_code, gọi API, so sánh AC rules.
 */
import fetch from 'node-fetch'
import db from './db.js'
import { fetchPostmanCollection } from './postmanApi.js'

/**
 * runPostmanCollection({ col, runId, orderCodes, requestNames })
 * Với mỗi order_code × request được chọn → gọi API → so sánh AC → lưu kết quả
 */
export async function runPostmanCollection({ col, runId, orderCodes, requestNames }) {
  const collection = await fetchPostmanCollection(col.collection_id)

  // Extract all requests từ collection
  const allRequests = extractRequests(collection)

  // Filter theo requestNames nếu có
  const targetRequests = requestNames.length
    ? allRequests.filter(r => requestNames.includes(r.name) || requestNames.includes(r.fullName))
    : allRequests

  // Collection-level variables
  const colVars = {}
  for (const v of (collection.variable || [])) {
    colVars[v.key] = v.value
  }

  // Load AC rules cho collection
  const acRules = await db.all(`SELECT * FROM ac_rules WHERE collection_id = ?`, [col.id])

  for (const orderCode of orderCodes) {
    for (const req of targetRequests) {
      const vars = { ...colVars, orderCode, order_code: orderCode }
      const result = await executeRequest(req, vars)

      // Áp dụng AC rules cho request này
      const rules = acRules.filter(r => r.request_name === req.name || r.request_name === req.fullName)
      const acResults = evaluateAcRules(rules, result.body)
      const allPassed = acResults.length === 0 ? null : acResults.every(r => r.passed) ? 1 : 0

      await db.run(
        `INSERT INTO api_test_results
          (run_id, order_code, request_name, method, url, status_code, actual_response, passed, ac_results)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          runId,
          orderCode,
          req.name,
          result.method,
          result.url,
          result.status,
          JSON.stringify(result.body),
          allPassed ?? 0,
          JSON.stringify(acResults),
        ]
      )
    }
  }
}

// ── Execute a single request ──────────────────────────────────────────────────

async function executeRequest(req, vars) {
  const method = req.method || 'GET'
  const url = replaceVars(req.url, vars)

  // Build headers
  const headers = {}
  for (const h of (req.headers || [])) {
    if (!h.disabled) headers[replaceVars(h.key, vars)] = replaceVars(h.value, vars)
  }

  // Build body
  let body
  if (req.body) {
    if (req.body.mode === 'raw') {
      body = replaceVars(req.body.raw || '', vars)
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json'
    } else if (req.body.mode === 'urlencoded') {
      const params = new URLSearchParams()
      for (const item of (req.body.urlencoded || [])) {
        if (!item.disabled) params.set(replaceVars(item.key, vars), replaceVars(item.value, vars))
      }
      body = params.toString()
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    }
  }

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method.toUpperCase()) ? undefined : body,
    })

    let responseBody
    const contentType = res.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      responseBody = await res.json()
    } else {
      responseBody = await res.text()
    }

    return { method, url, status: res.status, body: responseBody, error: null }
  } catch (err) {
    return { method, url, status: 0, body: null, error: err.message }
  }
}

// ── AC Rule Evaluation ────────────────────────────────────────────────────────

function evaluateAcRules(rules, responseBody) {
  return rules.map(rule => {
    const actual = getNestedValue(responseBody, rule.field_path)
    let passed = false

    switch (rule.operator) {
      case 'exists':
        passed = actual !== undefined && actual !== null
        break
      case 'eq':
        passed = String(actual) === String(rule.expected_value)
        break
      case 'contains':
        passed = typeof actual === 'string'
          ? actual.includes(rule.expected_value)
          : Array.isArray(actual)
            ? actual.includes(rule.expected_value)
            : false
        break
      case 'gt':
        passed = Number(actual) > Number(rule.expected_value)
        break
      case 'lt':
        passed = Number(actual) < Number(rule.expected_value)
        break
      default:
        passed = false
    }

    return {
      field: rule.field_path,
      operator: rule.operator,
      expected: rule.expected_value,
      actual: actual !== undefined ? actual : null,
      passed,
    }
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractRequests(collection, prefix = '') {
  const results = []
  for (const item of (collection.item || [])) {
    if (item.item) {
      results.push(...extractRequests(item, prefix ? `${prefix} / ${item.name}` : item.name))
    } else if (item.request) {
      const reqUrl = typeof item.request.url === 'string'
        ? item.request.url
        : item.request.url?.raw || ''

      results.push({
        name: item.name,
        fullName: prefix ? `${prefix} / ${item.name}` : item.name,
        method: item.request.method || 'GET',
        url: reqUrl,
        headers: item.request.header || [],
        body: item.request.body || null,
      })
    }
  }
  return results
}

function replaceVars(str, vars) {
  if (!str) return str
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] !== undefined ? vars[key] : `{{${key}}}`)
}

function getNestedValue(obj, path) {
  if (!obj || !path) return undefined
  try {
    const parsed = typeof obj === 'string' ? JSON.parse(obj) : obj
    return path.split('.').reduce((curr, key) => {
      if (curr === null || curr === undefined) return undefined
      // Support array index: data[0]
      const arrMatch = key.match(/^(\w+)\[(\d+)\]$/)
      if (arrMatch) return curr[arrMatch[1]]?.[parseInt(arrMatch[2])]
      return curr[key]
    }, parsed)
  } catch {
    return undefined
  }
}
