/**
 * provider.js — model selection
 *
 * Primary path: reads from ~/.sysai/models.json via models.js
 * Legacy fallback: reads SYSAI_PROVIDER / API keys from env (old flat config)
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI }    from '@ai-sdk/openai'
import { loadConfig }      from './config.js'
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
  // New path: models.json — read directly so model switches take effect immediately
  const activeCfg = getActiveConfig()
  if (activeCfg) {
    try { return getModelInstance(activeCfg) }
    catch (err) { die(err.message) }
  }

  // Legacy fallback: flat KEY=VALUE config in env
  loadConfig()
  const provider  = process.env.SYSAI_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : null)
  const modelName = process.env.SYSAI_MODEL

  if (!provider) {
    console.error('sysai: No provider configured. Run: sysai setup')
    process.exit(1)
  }

  const cfg = { provider, model: modelName }
  switch (provider) {
    case 'anthropic':
      cfg.apiKey  = process.env.ANTHROPIC_API_KEY
      cfg.baseUrl = process.env.ANTHROPIC_BASE_URL
      break
    case 'openai':
      cfg.apiKey  = process.env.OPENAI_API_KEY
      cfg.baseUrl = process.env.OPENAI_BASE_URL
      break
    case 'llamacpp':
    case 'openai-compatible':
      cfg.baseUrl = process.env.SYSAI_BASE_URL
      cfg.apiKey  = process.env.SYSAI_API_KEY
      break
    default:
      die(`Unknown provider: "${provider}". Valid options: anthropic, openai, llamacpp`)
  }
  try { return getModelInstance(cfg) }
  catch (err) { die(err.message) }
}

function die(msg) {
  console.error(`sysai: ${msg}`)
  console.error('       Run: sysai setup')
  process.exit(1)
}
