/**
 * embeddings.ts — embedding client for hybrid KB search
 *
 * Calls /v1/embeddings (OpenAI-compatible) for both openai and openai-compatible
 * providers. Returns null if no active embedding is configured.
 */

import { getActiveEmbeddingConfig } from '../storage/models.js'
import type { EmbeddingConfig } from '../types.js'

const BATCH_SIZE = 50
// OpenAI text-embedding-3 limit is 8192 tokens (~32k chars).
// Truncate conservatively to avoid hitting the limit.
const MAX_EMBED_CHARS = 24_000  // ~6k tokens, safe for all providers

/**
 * Embed an array of texts using the provided or active embedding config.
 * Returns an array of float vectors (one per input text).
 */
export async function embedTexts(texts: string[], cfg?: EmbeddingConfig): Promise<number[][]> {
  const config = cfg ?? getActiveEmbeddingConfig()
  if (!config) return []

  const baseUrl = config.baseUrl ?? 'https://api.openai.com/v1'
  const url = baseUrl.replace(/\/$/, '') + '/embeddings'

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`

  const results: number[][] = []

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map(t =>
      t.length > MAX_EMBED_CHARS ? t.slice(0, MAX_EMBED_CHARS) : t
    )
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.model, input: batch }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Embedding API error ${res.status}: ${body.slice(0, 200)}`)
    }

    const json = await res.json() as { data: Array<{ embedding: number[] }> }
    for (const item of json.data) {
      results.push(item.embedding)
    }
  }

  return results
}

/**
 * Embed a single query string using the active embedding config.
 * Returns null if no active embedding or on error.
 */
export async function embedQuery(query: string): Promise<number[] | null> {
  try {
    const vecs = await embedTexts([query])
    return vecs[0] ?? null
  } catch {
    return null
  }
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}
