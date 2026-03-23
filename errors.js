/**
 * errors.js — human-friendly API error messages
 *
 * Vercel AI SDK throws APICallError with:
 *   .statusCode   — HTTP status
 *   .responseBody — raw response string (often provider JSON)
 *
 * This module parses those and returns short, actionable strings.
 */

/**
 * Map an API / network error to a short, actionable message.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function formatApiError(err) {
  if (!err) return 'Unknown error'

  const status = err.statusCode ?? err.status ?? null
  const body   = err.responseBody ?? null

  // Parse provider JSON from response body
  let parsed = null
  if (typeof body === 'string' && body.trimStart().startsWith('{')) {
    try { parsed = JSON.parse(body) } catch {}
  } else if (body && typeof body === 'object') {
    parsed = body
  }

  // Anthropic: { error: { type, message } }
  // OpenAI:    { error: { type, code, message } }
  const errType    = parsed?.error?.type ?? parsed?.type ?? null
  const errCode    = parsed?.error?.code ?? null
  const providerMsg = parsed?.error?.message ?? null

  // 401 — bad API key
  if (status === 401 || errType === 'authentication_error') {
    return 'Authentication failed — check your API key  (sysai setup)'
  }

  // 429 — rate limited
  if (status === 429 || errType === 'rate_limit_error' || errCode === 'rate_limit_exceeded') {
    return 'Rate limit hit — wait a moment, or switch models  (sysai model)'
  }

  // 529 — Anthropic overloaded
  if (status === 529 || errType === 'overloaded_error') {
    return 'API overloaded — try again in a few seconds'
  }

  // 402 — quota / billing
  if (status === 402 || errType === 'insufficient_quota' || errCode === 'insufficient_quota') {
    return "Quota exceeded — check billing at your provider's dashboard"
  }

  // 404 — model not found
  if (status === 404 || errCode === 'model_not_found') {
    const detail = providerMsg ? `: ${providerMsg.slice(0, 80)}` : ''
    return `Model not found — check model name  (sysai setup)${detail}`
  }

  // 400 — bad request
  if (status === 400 || errType === 'invalid_request_error') {
    const detail = (providerMsg ?? err.message ?? '').slice(0, 100)
    return `Invalid request: ${detail}`
  }

  // 5xx — provider server error
  if (status >= 500 && status !== 529) {
    return `Provider server error (${status}) — try again shortly`
  }

  // Network / connection errors
  const msg = String(err.message ?? '')
  if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(msg)) {
    return 'Connection failed — check network or base URL  (sysai setup)'
  }
  if (/ETIMEDOUT|timed? out|timeout/i.test(msg)) {
    return 'Request timed out — model may be slow or unreachable'
  }
  if (/ECONNRESET|socket hang up/i.test(msg)) {
    return 'Connection reset — try again'
  }

  // If the provider sent a message, prefer it
  if (providerMsg) return providerMsg.slice(0, 120)

  return msg.slice(0, 120) || 'Unknown error'
}
