/**
 * provider.ts — model selection
 *
 * Reads from ~/.sysai/models.json via models.ts
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI }    from '@ai-sdk/openai'
import { getActiveConfig } from '../storage/models.js'
import type { ModelConfig } from '../types.js'

export const DEFAULTS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai:    'gpt-4o',
  llamacpp:  'local',
}

/**
 * Build an AI SDK model instance from a config object.
 */
export function getModelInstance(cfg: ModelConfig) {
  const modelName = cfg.model
  switch (cfg.provider) {
    case 'anthropic': {
      if (!cfg.apiKey) throw new Error('API key not configured for this model')
      const client = createAnthropic({ apiKey: cfg.apiKey, ...(cfg.baseUrl && { baseURL: cfg.baseUrl }) })
      return client(modelName || DEFAULTS.anthropic)
    }
    case 'openai': {
      if (!cfg.apiKey) throw new Error('API key not configured for this model')
      const client = createOpenAI({ apiKey: cfg.apiKey, ...(cfg.baseUrl && { baseURL: cfg.baseUrl }) })
      return client.chat(modelName || DEFAULTS.openai)
    }
    case 'llamacpp':
    case 'openai-compatible': {
      if (!cfg.baseUrl) throw new Error('Base URL not configured for this model')
      const client = createOpenAI({ apiKey: cfg.apiKey || 'llamacpp', baseURL: cfg.baseUrl, fetch: makeFilteredFetch() })
      return client.chat(modelName || DEFAULTS.llamacpp)
    }
    default:
      throw new Error(`Unknown provider: "${cfg.provider}"`)
  }
}

/**
 * Returns a fetch wrapper that drops non-standard SSE events injected by
 * OpenWebUI (and similar proxies) that lack the `choices` or `error` fields
 * expected by the OpenAI streaming schema — e.g. `{"sources":[...]}`.
 * Without this, @ai-sdk/openai throws AI_TypeValidationError mid-stream.
 */
function makeFilteredFetch(): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await globalThis.fetch(input, init)
    const contentType = response.headers.get('content-type') ?? ''
    if (!response.body || !contentType.includes('text/event-stream')) return response

    const reader  = response.body.getReader()
    const enc     = new TextEncoder()
    const dec     = new TextDecoder()
    let   buf     = ''

    const filtered = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read()
        if (done) {
          // flush any remaining buffer
          if (buf) controller.enqueue(enc.encode(buf))
          controller.close()
          return
        }
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''   // keep incomplete last line for next chunk

        const kept = lines.filter(line => {
          if (!line.startsWith('data: ')) return true
          const payload = line.slice(6).trim()
          if (payload === '[DONE]') return true
          try {
            const obj = JSON.parse(payload)
            return 'choices' in obj || 'error' in obj
          } catch { return true }
        })
        if (kept.length) controller.enqueue(enc.encode(kept.join('\n') + '\n'))
      },
      cancel() { reader.cancel() },
    })

    return new Response(filtered, {
      status:     response.status,
      statusText: response.statusText,
      headers:    response.headers,
    })
  }
}

export function getModel() {
  const activeCfg = getActiveConfig()
  if (!activeCfg) {
    console.error('sysai: No models configured. Run: sysai setup')
    process.exit(1)
  }
  try { return getModelInstance(activeCfg) }
  catch (err) {
    console.error(`sysai: ${(err as Error).message}`)
    console.error('       Run: sysai setup')
    process.exit(1)
  }
}
