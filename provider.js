/**
 * provider.js — model selection
 *
 * Reads from ~/.sysai/models.json via models.js
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI }    from '@ai-sdk/openai'
import { getActiveConfig } from './models.js'

const DEFAULTS = {
  anthropic: 'claude-sonnet-4-6',
  openai:    'gpt-4o',
  llamacpp:  'local',
}

/**
 * Build an AI SDK model instance from a config object.
 * @param {{ provider, model?, apiKey?, baseUrl? }} cfg
 */
export function getModelInstance(cfg) {
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
      const client = createOpenAI({ apiKey: cfg.apiKey || 'llamacpp', baseURL: cfg.baseUrl })
      return client.chat(modelName || DEFAULTS.llamacpp)
    }
    default:
      throw new Error(`Unknown provider: "${cfg.provider}"`)
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
    console.error(`sysai: ${err.message}`)
    console.error('       Run: sysai setup')
    process.exit(1)
  }
}
