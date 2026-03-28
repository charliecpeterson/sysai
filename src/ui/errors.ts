/**
 * errors.ts — human-friendly API error messages
 *
 * Vercel AI SDK throws APICallError with:
 *   .statusCode   — HTTP status
 *   .responseBody — raw response string (often provider JSON)
 *
 * This module parses those and returns short, actionable strings.
 */

/**
 * Map an API / network error to a short, actionable message.
 */
export function formatApiError(err: unknown): string {
  if (!err) return 'Unknown error'

  const e = err as Record<string, unknown>
  const status = (e.statusCode ?? e.status ?? null) as number | null
  const body   = (e.responseBody ?? null) as string | Record<string, unknown> | null

  // Parse provider JSON from response body
  let parsed: Record<string, unknown> | null = null
  if (typeof body === 'string' && body.trimStart().startsWith('{')) {
    try { parsed = JSON.parse(body) } catch {}
  } else if (body && typeof body === 'object') {
    parsed = body as Record<string, unknown>
  }

  // Anthropic: { error: { type, message } }
  // OpenAI:    { error: { type, code, message } }
  const errObj      = parsed?.error as Record<string, unknown> | undefined
  const errType     = (errObj?.type ?? parsed?.type ?? null) as string | null
  const errCode     = (errObj?.code ?? null) as string | null
  const providerMsg = (errObj?.message ?? null) as string | null

  if (status === 401 || errType === 'authentication_error')
    return 'Authentication failed — check your API key  (sysai setup)'

  if (status === 429 || errType === 'rate_limit_error' || errCode === 'rate_limit_exceeded')
    return 'Rate limit hit — wait a moment, or switch models  (sysai model)'

  if (status === 529 || errType === 'overloaded_error')
    return 'API overloaded — try again in a few seconds'

  if (status === 402 || errType === 'insufficient_quota' || errCode === 'insufficient_quota')
    return "Quota exceeded — check billing at your provider's dashboard"

  if (status === 404 || errCode === 'model_not_found') {
    const detail = providerMsg ? `: ${providerMsg.slice(0, 80)}` : ''
    return `Model not found — check model name  (sysai setup)${detail}`
  }

  if (status === 400 || errType === 'invalid_request_error') {
    const detail = (providerMsg ?? (e.message as string) ?? '').slice(0, 100)
    return `Invalid request: ${detail}`
  }

  if (status !== null && status >= 500 && status !== 529)
    return `Provider server error (${status}) — try again shortly`

  const msg = String(e.message ?? '')
  if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(msg)) {
    const proxyHint = process.env.HTTP_PROXY || process.env.HTTPS_PROXY
      ? '' : '  Set $HTTPS_PROXY if behind a proxy.'
    return `Connection failed — check network or base URL  (sysai setup)${proxyHint}`
  }
  if (/ETIMEDOUT|timed? out|timeout/i.test(msg))
    return 'Request timed out — model may be slow or unreachable'
  if (/ECONNRESET|socket hang up/i.test(msg))
    return 'Connection reset — try again'

  if (providerMsg) return providerMsg.slice(0, 120)
  return msg.slice(0, 120) || 'Unknown error'
}
