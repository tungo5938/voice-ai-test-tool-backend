// In-memory map: call_id → SSE response object (or sessionId for lookup)
export const sessionMap = new Map()

// SSE clients: sessionId → res
export const sseClients = new Map()
