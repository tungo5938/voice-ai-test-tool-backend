import fetch from 'node-fetch'

let cachedToken = null
let tokenExpiry = 0

export async function getPitelToken() {
  const now = Date.now() / 1000
  if (cachedToken && now < tokenExpiry - 300) {
    return cachedToken
  }

  const res = await fetch(`${process.env.PITEL_BASE_URL}/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: process.env.PITEL_TOKEN }),
  })

  const data = await res.json()
  if (!data?.data?.token) {
    throw new Error('Pitel auth failed: ' + JSON.stringify(data))
  }

  cachedToken = data.data.token
  tokenExpiry = now + (data.data.expired_in || 3600)
  console.log(`[pitelAuth] Token refreshed, expires in ${Math.floor(data.data.expired_in / 3600)}h`)
  return cachedToken
}
