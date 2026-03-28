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
 * Returns a fetch wrapper that normalises SSE events from OpenAI-compatible
 * proxies (OpenWebUI, LiteLLM, etc.) to the strict schema @ai-sdk/openai expects:
 *  - Drops events without `choices`/`error` (e.g. OpenWebUI `{"sources":[...]}`).
 *  - Strips unknown top-level fields (obfuscation, service_tier, system_fingerprint)
 *    that Zod 4 strict objects reject with AI_TypeValidationError.
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

        const kept = lines.flatMap(line => {
          if (!line.startsWith('data: ')) return [line]
          const payload = line.slice(6).trim()
          if (payload === '[DONE]') return [line]
          try {
            const obj = JSON.parse(payload)
            if (!('choices' in obj) && !('error' in obj)) return []   // drop non-standard events (e.g. OpenWebUI sources)
            // Strip fields not in the OpenAI streaming schema — Zod 4
            // strict objects reject unknown keys like obfuscation, service_tier, etc.
            const { id, created, model, choices, usage, error } = obj
            const clean = { id, created, model, choices, usage, error }
            // Remove undefined keys so the JSON stays minimal
            for (const k of Object.keys(clean) as (keyof typeof clean)[]) {
              if (clean[k] === undefined) delete clean[k]
            }
            return ['data: ' + JSON.stringify(clean)]
          } catch { return [line] }
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
