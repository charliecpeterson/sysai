/**
 * models.js — named model configuration list
 *
 * Stores configs in ~/.sysai/models.json:
 *   { active: "claude-sonnet", models: [{ name, provider, model, apiKey, baseUrl }, …] }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join }    from 'path'

export const MODELS_PATH = join(homedir(), '.sysai', 'models.json')

export function loadModels() {
  if (!existsSync(MODELS_PATH)) return null
  try { return JSON.parse(readFileSync(MODELS_PATH, 'utf8')) } catch { return null }
}

export function saveModels(data) {
  mkdirSync(join(homedir(), '.sysai'), { recursive: true })
  writeFileSync(MODELS_PATH, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

/** Returns the active model config object, or null if no models.json exists. */
export function getActiveConfig() {
  const data = loadModels()
  if (!data?.models?.length) return null
  return data.models.find(m => m.name === data.active) ?? data.models[0]
}

export function switchActive(name) {
  const data = loadModels()
  if (!data) throw new Error('No models configured. Run: sysai setup')
  if (!data.models.find(m => m.name === name))
    throw new Error(`No model named "${name}". Run: sysai models`)
  data.active = name
  saveModels(data)
}

export function addModel(cfg) {
  const data = loadModels() ?? { active: cfg.name, models: [] }
  const idx = data.models.findIndex(m => m.name === cfg.name)
  if (idx >= 0) data.models[idx] = cfg
  else data.models.push(cfg)
  if (!data.active) data.active = cfg.name
  saveModels(data)
}

export function removeModel(name) {
  const data = loadModels()
  if (!data) return
  data.models = data.models.filter(m => m.name !== name)
  if (data.active === name) data.active = data.models[0]?.name ?? null
  saveModels(data)
}
