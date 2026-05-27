/**
 * postmanApi.js
 * Fetch collections and environments from the Postman Cloud API.
 */
import fetch from 'node-fetch'

const POSTMAN_API = 'https://api.getpostman.com'

function getApiKey() {
  const key = process.env.POSTMAN_API_KEY
  if (!key || key.includes('XXXX')) throw new Error('POSTMAN_API_KEY chưa được cấu hình trong .env')
  return key
}

/**
 * Fetch a single Postman collection from the Cloud API.
 * Returns the collection object (with .item, .variable, etc.)
 */
export async function fetchPostmanCollection(collectionId) {
  const apiKey = getApiKey()
  const res = await fetch(`${POSTMAN_API}/collections/${collectionId}`, {
    headers: { 'X-Api-Key': apiKey },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Postman API error ${res.status}: ${body}`)
  }
  const data = await res.json()
  // Collection v2.1: { collection: { info, item, variable } }
  return data.collection || data
}

/**
 * List all collections accessible by the API key.
 */
export async function listPostmanCollections() {
  const apiKey = getApiKey()
  const res = await fetch(`${POSTMAN_API}/collections`, {
    headers: { 'X-Api-Key': apiKey },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Postman API error ${res.status}: ${body}`)
  }
  const data = await res.json()
  return data.collections || []
}

/**
 * Fetch a Postman environment by ID (for variable substitution).
 */
export async function fetchPostmanEnvironment(environmentId) {
  const apiKey = getApiKey()
  const res = await fetch(`${POSTMAN_API}/environments/${environmentId}`, {
    headers: { 'X-Api-Key': apiKey },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Postman API error ${res.status}: ${body}`)
  }
  const data = await res.json()
  return data.environment || data
}
