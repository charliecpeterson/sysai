/**
 * provider.js — model selection based on SYSAI_PROVIDER config
 *
 * Set in ~/.sysai or environment:
 *   SYSAI_PROVIDER = anthropic | openai | llamacpp
 *   SYSAI_MODEL    = model name (optional, has defaults per provider)
 *
 * Provider-specific keys:
 *   anthropic : ANTHROPIC_API_KEY, optionally ANTHROPIC_BASE_URL
 *   openai    : OPENAI_API_KEY
 *   llamacpp  : SYSAI_BASE_URL, SYSAI_API_KEY (optional, defaults to 'llamacpp')
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI }    from '@ai-sdk/openai'
import { loadConfig }      from './config.js'

const DEFAULTS = {
  anthropic: 'claude-sonnet-4-6',
  openai:    'gpt-4o',
  llamacpp:  'local',
}

export function getModel() {
  loadConfig()

  // Backwards compat: if no provider set but ANTHROPIC_API_KEY exists, default to anthropic
  const provider  = process.env.SYSAI_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : null)
  const modelName = process.env.SYSAI_MODEL

  if (!provider) {
    console.error('sysai: No provider configured. Run: sysai setup')
    process.exit(1)
  }

  switch (provider) {
    case 'anthropic': {
      const apiKey  = process.env.ANTHROPIC_API_KEY
      const baseURL = process.env.ANTHROPIC_BASE_URL
      if (!apiKey) die('ANTHROPIC_API_KEY not set')
      const client = createAnthropic({ apiKey, ...(baseURL && { baseURL }) })
      return client(modelName || DEFAULTS.anthropic)
    }

    case 'openai': {
      const apiKey  = process.env.OPENAI_API_KEY
      const baseURL = process.env.OPENAI_BASE_URL
      if (!apiKey) die('OPENAI_API_KEY not set')
      const client = createOpenAI({ apiKey, ...(baseURL && { baseURL }) })
      // .chat() uses /chat/completions — avoids the Responses API which rejects our schema
      return client.chat(modelName || DEFAULTS.openai)
    }

    case 'llamacpp':
    case 'openai-compatible': {
      const baseURL = process.env.SYSAI_BASE_URL
      const apiKey  = process.env.SYSAI_API_KEY || 'llamacpp'
      if (!baseURL) die('SYSAI_BASE_URL not set (required for llamacpp)')
      // .chat() uses /chat/completions instead of the newer /responses endpoint
      const client = createOpenAI({ apiKey, baseURL })
      return client.chat(modelName || DEFAULTS.llamacpp)
    }

    default:
      die(`Unknown provider: "${provider}". Valid options: anthropic, openai, llamacpp`)
  }
}

function die(msg) {
  console.error(`sysai: ${msg}`)
  console.error('       Run: sysai setup')
  process.exit(1)
}
