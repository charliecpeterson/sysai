/**
 * models.ts — named model configuration list
 *
 * Stores configs in ~/.sysai/models.json:
 *   { active: "claude-sonnet", models: [{ name, provider, model, apiKey, baseUrl }, …] }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join }    from 'path'
import type { ModelConfig, ModelsData, EmbeddingConfig } from '../types.js'

export const MODELS_PATH = join(homedir(), '.sysai', 'models.json')

let _cache: ModelsData | null = null

export function loadModels(): ModelsData | null {
  if (!existsSync(MODELS_PATH)) return null
  if (_cache) return _cache
  try { _cache = JSON.parse(readFileSync(MODELS_PATH, 'utf8')); return _cache } catch { return null }
}

export function saveModels(data: ModelsData): void {
  _cache = data  // keep cache consistent with what we write
  mkdirSync(join(homedir(), '.sysai'), { recursive: true })
  writeFileSync(MODELS_PATH, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

/** Returns the active model config object, or null if no models.json exists. */
export function getActiveConfig(): ModelConfig | null {
  const data = loadModels()
  if (!data?.models?.length) return null
  return data.models.find(m => m.name === data.active) ?? data.models[0]
}

export function switchActive(name: string): void {
  const data = loadModels()
  if (!data) throw new Error('No models configured. Run: sysai setup')
  if (!data.models.find(m => m.name === name))
    throw new Error(`No model named "${name}". Run: sysai models`)
  data.active = name
  saveModels(data)
}

export function addModel(cfg: ModelConfig): void {
  const data = loadModels() ?? { active: cfg.name, models: [] }
  const idx = data.models.findIndex(m => m.name === cfg.name)
  if (idx >= 0) data.models[idx] = cfg
  else data.models.push(cfg)
  if (!data.active) data.active = cfg.name
  saveModels(data)
}

export function removeModel(name: string): void {
  const data = loadModels()
  if (!data) return
  data.models = data.models.filter(m => m.name !== name)
  if (data.active === name) data.active = data.models[0]?.name ?? null
  saveModels(data)
}

// ── Embedding config ─────────────────────────────────────────────────────────

/** Get a specific embedding config by name. */
export function getEmbeddingConfig(name: string): EmbeddingConfig | null {
  const data = loadModels()
  return data?.embeddings?.find(e => e.name === name) ?? null
}

/** List all configured embeddings. */
export function listEmbeddings(): EmbeddingConfig[] {
  return loadModels()?.embeddings ?? []
}

export function addEmbedding(cfg: EmbeddingConfig): void {
  const data = loadModels() ?? { active: null, models: [] }
  if (!data.embeddings) data.embeddings = []
  const idx = data.embeddings.findIndex(e => e.name === cfg.name)
  if (idx >= 0) data.embeddings[idx] = cfg
  else data.embeddings.push(cfg)
  saveModels(data)
}

export function removeEmbedding(name: string): void {
  const data = loadModels()
  if (!data?.embeddings) return
  data.embeddings = data.embeddings.filter(e => e.name !== name)
  saveModels(data)
}
