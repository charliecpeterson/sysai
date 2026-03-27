/**
 * kb.ts — knowledge base storage and indexing
 *
 * Each KB lives at ~/.sysai/kb/<name>/ with:
 *   docs/       — user-dropped source files (txt, md, pdf)
 *   index.json  — processed text chunks
 * Global config at ~/.sysai/kb/config.json tracks active KBs and metadata.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { execSync } from 'child_process'
import { homedir } from 'os'
import { join, extname } from 'path'
import type { KbConfig, KbMeta, KbChunk } from '../types.js'
import { getEmbeddingConfig } from './models.js'
import { embedTexts } from '../core/embeddings.js'

const KB_DIR     = join(homedir(), '.sysai', 'kb')
const CONFIG_PATH = join(KB_DIR, 'config.json')

// Rough estimate: 1 token ≈ 4 chars for English text
const CHARS_PER_TOKEN = 4

// ── Config ───────────────────────────────────────────────────────────────────

export function loadKbConfig(): KbConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as KbConfig
    }
  } catch {}
  return { active: [], kbs: {} }
}

export function saveKbConfig(config: KbConfig): void {
  mkdirSync(KB_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8')
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export function createKb(name: string, description: string): void {
  const config = loadKbConfig()
  if (config.kbs[name]) throw new Error(`KB "${name}" already exists`)

  const kbDir = join(KB_DIR, name, 'docs')
  mkdirSync(kbDir, { recursive: true })

  config.kbs[name] = { description, lastIndexed: null, docCount: 0, tokenEstimate: 0 }
  config.active.push(name)  // new KBs start active
  saveKbConfig(config)
}

export function deleteKb(name: string): boolean {
  const config = loadKbConfig()
  if (!config.kbs[name]) return false

  const kbDir = join(KB_DIR, name)
  rmSync(kbDir, { recursive: true, force: true })

  delete config.kbs[name]
  config.active = config.active.filter(n => n !== name)
  saveKbConfig(config)
  return true
}

export function setKbActive(name: string, active: boolean): void {
  const config = loadKbConfig()
  if (!config.kbs[name]) throw new Error(`KB "${name}" not found`)

  config.active = config.active.filter(n => n !== name)
  if (active) config.active.push(name)
  saveKbConfig(config)
}

export function listKbs(): Array<{ name: string; active: boolean } & KbMeta> {
  const config = loadKbConfig()
  return Object.entries(config.kbs).map(([name, meta]) => ({
    name,
    active: config.active.includes(name),
    ...meta,
  }))
}

// ── Indexing ──────────────────────────────────────────────────────────────────

/**
 * Read all docs in a KB's docs/ directory and produce an index.json of text chunks.
 * If an active embedding is configured, also generates vectors.json.
 * Supports: .txt, .md, .markdown, .pdf (via pdftotext), .json, .csv, .log, .yaml, .yml
 */
export async function indexKb(
  name: string,
  opts: { embeddingName?: string | null; onProgress?: (msg: string) => void } = {},
): Promise<{ docCount: number; tokenEstimate: number; embeddingModel: string | null }> {
  const { embeddingName, onProgress } = opts
  const config = loadKbConfig()
  if (!config.kbs[name]) throw new Error(`KB "${name}" not found`)

  const docsDir    = join(KB_DIR, name, 'docs')
  const indexPath  = join(KB_DIR, name, 'index.json')
  const vectorPath = join(KB_DIR, name, 'vectors.json')

  if (!existsSync(docsDir)) {
    mkdirSync(docsDir, { recursive: true })
    return { docCount: 0, tokenEstimate: 0, embeddingModel: null }
  }

  const files  = findFiles(docsDir)
  const chunks: KbChunk[] = []

  for (const file of files) {
    const text = extractText(file)
    if (!text.trim()) continue
    chunks.push(...chunkText(text, file))
  }

  writeFileSync(indexPath, JSON.stringify(chunks, null, 2), 'utf8')

  const totalChars    = chunks.reduce((sum, c) => sum + c.text.length, 0)
  const tokenEstimate = Math.ceil(totalChars / CHARS_PER_TOKEN)

  // Generate embeddings if an embedding was requested
  let embeddingModel: string | null = null
  let embeddingDimensions: number | null = null
  const embCfg = embeddingName ? getEmbeddingConfig(embeddingName) : null

  if (embeddingName && !embCfg) {
    onProgress?.(`embedding config "${embeddingName}" not found — using BM25 only`)
  } else if (embCfg && chunks.length > 0) {
    onProgress?.(`embedding ${chunks.length} chunks with ${embCfg.name}...`)
    try {
      const vectors = await embedTexts(chunks.map(c => c.text), embCfg)
      if (vectors.length === chunks.length) {
        writeFileSync(vectorPath, JSON.stringify(vectors), 'utf8')
        embeddingModel = embCfg.name
        embeddingDimensions = vectors[0]?.length ?? null
      }
    } catch (err) {
      onProgress?.(`embedding failed: ${(err as Error).message} — using BM25 only`)
    }
  } else if (!embCfg && existsSync(vectorPath)) {
    // No embedding requested — remove stale vectors
    rmSync(vectorPath)
  }

  config.kbs[name].lastIndexed        = new Date().toISOString()
  config.kbs[name].docCount           = files.length
  config.kbs[name].tokenEstimate      = tokenEstimate
  config.kbs[name].embeddingModel     = embeddingModel
  config.kbs[name].embeddingDimensions = embeddingDimensions
  saveKbConfig(config)

  return { docCount: files.length, tokenEstimate, embeddingModel }
}

/**
 * Load all active KBs' text as a single string for CAG injection.
 * Returns null if no active KBs or no indexed content.
 */
export function loadActiveKbText(): { text: string; kbNames: string[] } | null {
  const config = loadKbConfig()
  if (config.active.length === 0) return null

  const parts: string[] = []
  const kbNames: string[] = []

  for (const name of config.active) {
    const indexPath = join(KB_DIR, name, 'index.json')
    if (!existsSync(indexPath)) continue

    try {
      const chunks = JSON.parse(readFileSync(indexPath, 'utf8')) as KbChunk[]
      if (chunks.length === 0) continue

      const desc = config.kbs[name]?.description ?? name
      const text = chunks.map(c => c.text).join('\n\n')
      parts.push(`### ${name}: ${desc}\n\n${text}`)
      kbNames.push(name)
    } catch {}
  }

  if (parts.length === 0) return null
  return { text: parts.join('\n\n---\n\n'), kbNames }
}

/**
 * Estimate total token count of active KBs.
 */
export function activeKbTokenEstimate(): number {
  const config = loadKbConfig()
  return config.active.reduce((sum, name) => sum + (config.kbs[name]?.tokenEstimate ?? 0), 0)
}

/**
 * List all files in active KBs with relative paths and sizes.
 */
export function listKbFiles(kbName?: string): Array<{ kb: string; file: string; size: number }> {
  const config = loadKbConfig()
  const targetKbs = kbName
    ? config.active.filter(n => n === kbName)
    : config.active

  const results: Array<{ kb: string; file: string; size: number }> = []

  for (const name of targetKbs) {
    const docsDir = join(KB_DIR, name, 'docs')
    if (!existsSync(docsDir)) continue

    for (const fullPath of findFiles(docsDir)) {
      const rel = fullPath.slice(docsDir.length + 1)  // strip docs/ prefix
      try {
        const stat = statSync(fullPath)
        results.push({ kb: name, file: rel, size: stat.size })
      } catch {}
    }
  }

  return results
}

/**
 * Get the absolute path to a file in a KB's docs directory.
 */
export function getKbFilePath(kbName: string, relPath: string): string | null {
  const fullPath = join(KB_DIR, kbName, 'docs', relPath)
  return existsSync(fullPath) ? fullPath : null
}

/**
 * Get descriptions of active KBs (for search tool help text).
 */
export function activeKbDescriptions(): Array<{ name: string; description: string }> {
  const config = loadKbConfig()
  return config.active
    .filter(name => config.kbs[name])
    .map(name => ({ name, description: config.kbs[name].description }))
}

// ── BM25 Search ──────────────────────────────────────────────────────────────

export interface SearchResult {
  kb: string
  file: string
  chunkIndex: number
  score: number
  text: string
}

/**
 * Search active KBs using hybrid BM25 + cosine similarity (if embeddings available),
 * or BM25-only if no vectors exist. Returns stale embedding warnings via onWarn.
 */
export async function searchKb(
  query: string,
  opts: { limit?: number; kb?: string; onWarn?: (msg: string) => void } = {},
): Promise<SearchResult[]> {
  const config = loadKbConfig()
  const limit = opts.limit ?? 8
  const targetKbs = opts.kb
    ? config.active.filter(n => n === opts.kb)
    : config.active

  if (targetKbs.length === 0) return []

  // Load all chunks across target KBs
  const allChunks: Array<KbChunk & { kb: string }> = []
  for (const name of targetKbs) {
    const indexPath = join(KB_DIR, name, 'index.json')
    if (!existsSync(indexPath)) continue
    try {
      const chunks = JSON.parse(readFileSync(indexPath, 'utf8')) as KbChunk[]
      for (const c of chunks) allChunks.push({ ...c, kb: name })
    } catch {}
  }

  if (allChunks.length === 0) return []

  // BM25 scoring
  const queryTerms = tokenize(query)
  if (queryTerms.length === 0) return []

  const N = allChunks.length
  const avgDl = allChunks.reduce((s, c) => s + tokenize(c.text).length, 0) / N

  // Document frequency for each query term
  const df = new Map<string, number>()
  for (const term of queryTerms) df.set(term, 0)

  const chunkTermFreqs: Array<{ terms: Map<string, number>; len: number }> = []
  for (const chunk of allChunks) {
    const terms = tokenize(chunk.text)
    const freq = new Map<string, number>()
    for (const t of terms) freq.set(t, (freq.get(t) ?? 0) + 1)
    chunkTermFreqs.push({ terms: freq, len: terms.length })

    for (const qt of queryTerms) {
      if (freq.has(qt)) df.set(qt, (df.get(qt) ?? 0) + 1)
    }
  }

  // Pre-compute file name tokens for boosting
  const fileNameTokens: Set<string>[] = allChunks.map(c => {
    const name = c.file.toLowerCase().replace(/[^a-z0-9]+/g, ' ')
    return new Set(name.split(/\s+/).filter(w => w.length > 1))
  })

  // Score each chunk
  const k1 = 1.5
  const b  = 0.75
  const FILE_NAME_BOOST = 2.0  // multiply score if file name matches query terms
  const scored: Array<{ idx: number; score: number }> = []

  for (let i = 0; i < N; i++) {
    const { terms: freq, len: dl } = chunkTermFreqs[i]
    let score = 0

    for (const term of queryTerms) {
      const n = df.get(term) ?? 0
      if (n === 0) continue
      const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1)
      const tf  = freq.get(term) ?? 0
      score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgDl))
    }

    // Boost if file name/path contains query terms
    if (score > 0) {
      const fnTokens = fileNameTokens[i]
      const nameMatches = queryTerms.filter(t => fnTokens.has(t)).length
      if (nameMatches > 0) score *= FILE_NAME_BOOST
    }

    if (score > 0) scored.push({ idx: i, score })
  }

  scored.sort((a, b) => b.score - a.score)

  // Hybrid: try to load vectors for each KB using its own embedding config
  let finalScored = scored
  {
    const vectorsByKb = new Map<string, number[][]>()
    let anyVectorsLoaded = false

    for (const kbName of targetKbs) {
      const kbMeta = config.kbs[kbName]
      const vectorPath = join(KB_DIR, kbName, 'vectors.json')

      if (!existsSync(vectorPath) || !kbMeta?.embeddingModel) continue

      const embCfg = getEmbeddingConfig(kbMeta.embeddingModel)
      if (!embCfg) {
        opts.onWarn?.(`kb "${kbName}": embedding config "${kbMeta.embeddingModel}" no longer exists — using BM25 only. Re-run: sysai kb index ${kbName}`)
        continue
      }

      try {
        const vecs = JSON.parse(readFileSync(vectorPath, 'utf8')) as number[][]
        vectorsByKb.set(kbName, vecs)
        anyVectorsLoaded = true
      } catch {}
    }

    if (anyVectorsLoaded) {
      // Build a mapping from allChunks index → vector
      const chunkVecIndex = new Map<number, number[]>()
      const kbChunkOffsets = new Map<string, number>()
      let offset = 0
      for (const kbName of targetKbs) {
        kbChunkOffsets.set(kbName, offset)
        const kbChunks = allChunks.filter(c => c.kb === kbName)
        offset += kbChunks.length
      }

      // Re-map: allChunks index → vector from that KB's vectors.json
      const kbChunkCounters = new Map<string, number>()
      for (let i = 0; i < allChunks.length; i++) {
        const kb = allChunks[i].kb
        const vecs = vectorsByKb.get(kb)
        if (!vecs) continue
        const counter = kbChunkCounters.get(kb) ?? 0
        kbChunkCounters.set(kb, counter + 1)
        if (counter < vecs.length) chunkVecIndex.set(i, vecs[counter])
      }

      // Embed the query — once per distinct embedding model used across KBs
      try {
        const { embedTexts: _embedTexts, cosineSimilarity } = await import('../core/embeddings.js')

        // Find distinct embedding configs for the loaded KBs
        const embConfigsByName = new Map<string, import('../types.js').EmbeddingConfig>()
        for (const kbName of vectorsByKb.keys()) {
          const embName = config.kbs[kbName]?.embeddingModel
          if (embName && !embConfigsByName.has(embName)) {
            const cfg = getEmbeddingConfig(embName)
            if (cfg) embConfigsByName.set(embName, cfg)
          }
        }

        // Embed query with each distinct config
        const queryVecByModel = new Map<string, number[]>()
        for (const [embName, embCfg] of embConfigsByName) {
          try {
            const vecs = await _embedTexts([query], embCfg)
            if (vecs[0]) queryVecByModel.set(embName, vecs[0])
          } catch {}
        }

        if (queryVecByModel.size > 0) {
          // Build KB → embedding model map for fast lookup
          const kbEmbModel = new Map<string, string>()
          for (const kbName of vectorsByKb.keys()) {
            const embName = config.kbs[kbName]?.embeddingModel
            if (embName) kbEmbModel.set(kbName, embName)
          }

          const maxBm25 = scored.length > 0 ? scored[0].score : 1
          const BM25_WEIGHT   = 0.4
          const COSINE_WEIGHT = 0.6

          const hybridScored: Array<{ idx: number; score: number }> = []
          for (let i = 0; i < N; i++) {
            const chunk    = allChunks[i]
            const embModel = kbEmbModel.get(chunk.kb)
            const queryVec = embModel ? queryVecByModel.get(embModel) : undefined
            const vec      = chunkVecIndex.get(i)
            const cosine   = (queryVec && vec) ? cosineSimilarity(queryVec, vec) : 0
            const bm25Raw  = scored.find(s => s.idx === i)?.score ?? 0
            const bm25Norm = maxBm25 > 0 ? bm25Raw / maxBm25 : 0
            const hybrid   = BM25_WEIGHT * bm25Norm + COSINE_WEIGHT * cosine
            if (hybrid > 0.01) hybridScored.push({ idx: i, score: hybrid })
          }

          hybridScored.sort((a, b) => b.score - a.score)
          finalScored = hybridScored
        }
      } catch {}
    }
  }

  // Take wide retrieval (top 20), then stitch adjacent chunks from the same file
  const WIDE_LIMIT = Math.max(20, limit * 4)
  const wide = finalScored.slice(0, WIDE_LIMIT)

  const stitched = stitchChunks(wide, allChunks)

  return stitched.slice(0, limit)
}

/**
 * Stitch adjacent chunks from the same file together.
 * If chunk 3 and chunk 4 from the same file both scored, merge them into one result.
 */
function stitchChunks(
  scored: Array<{ idx: number; score: number }>,
  allChunks: Array<KbChunk & { kb: string }>,
): SearchResult[] {
  // Group by (kb, file) and track which chunk indices we have
  const groups = new Map<string, { kb: string; file: string; indices: Map<number, number> }>()

  for (const { idx, score } of scored) {
    const chunk = allChunks[idx]
    const key = `${chunk.kb}::${chunk.file}`
    if (!groups.has(key)) {
      groups.set(key, { kb: chunk.kb, file: chunk.file, indices: new Map() })
    }
    const g = groups.get(key)!
    // Keep the best score for each chunk index
    const existing = g.indices.get(chunk.index)
    if (existing === undefined || score > existing) {
      g.indices.set(chunk.index, score)
    }
  }

  // For each group, find contiguous runs and stitch them
  const results: SearchResult[] = []

  for (const g of groups.values()) {
    const sortedIndices = [...g.indices.keys()].sort((a, b) => a - b)
    let runStart = sortedIndices[0]
    let runScore = g.indices.get(runStart) ?? 0

    for (let i = 1; i <= sortedIndices.length; i++) {
      const prev = sortedIndices[i - 1]
      const curr = sortedIndices[i]

      if (curr === prev + 1) {
        // Extend run, take max score
        runScore = Math.max(runScore, g.indices.get(curr) ?? 0)
      } else {
        // Emit the run
        const runEnd = prev
        const texts: string[] = []
        for (let ci = runStart; ci <= runEnd; ci++) {
          const chunk = allChunks.find(c => c.kb === g.kb && c.file === g.file && c.index === ci)
          if (chunk) texts.push(chunk.text)
        }
        results.push({
          kb: g.kb,
          file: g.file,
          chunkIndex: runStart,
          score: runScore,
          text: texts.join('\n\n'),
        })

        // Start new run
        if (curr !== undefined) {
          runStart = curr
          runScore = g.indices.get(curr) ?? 0
        }
      }
    }
  }

  results.sort((a, b) => b.score - a.score)
  return results
}

/**
 * Tokenize text for BM25: lowercase, split on non-alphanumeric, remove stopwords.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w))
}

const STOPWORDS = new Set([
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i',
  'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at',
  'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her',
  'she', 'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there',
  'their', 'what', 'so', 'up', 'out', 'if', 'about', 'who', 'get',
  'which', 'go', 'me', 'when', 'make', 'can', 'like', 'no', 'just',
  'him', 'know', 'take', 'into', 'your', 'some', 'could', 'them',
  'than', 'other', 'been', 'has', 'its', 'is', 'was', 'are', 'were',
])

// ── Internal helpers ─────────────────────────────────────────────────────────

function findFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      results.push(...findFiles(full))
    } else {
      results.push(full)
    }
  }
  return results
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.log',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.sh', '.bash', '.py', '.js', '.ts', '.go', '.rs',
  '.html', '.xml', '.rst', '.org',
])

function extractText(filePath: string): string {
  const ext = extname(filePath).toLowerCase()

  if (ext === '.pdf') {
    return extractPdf(filePath)
  }

  if (TEXT_EXTENSIONS.has(ext) || ext === '') {
    try {
      // Skip files > 10MB
      const stat = statSync(filePath)
      if (stat.size > 10 * 1024 * 1024) return ''
      return readFileSync(filePath, 'utf8')
    } catch { return '' }
  }

  return ''
}

function extractPdf(filePath: string): string {
  // Try pdftotext (poppler-utils), fall back silently
  try {
    return execSync(`pdftotext -layout "${filePath}" -`, {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch {
    return ''
  }
}

/**
 * Split text into chunks. For CAG mode we keep chunks large (the whole file
 * if it's reasonable). This preserves maximum context. Chunks are only split
 * when a single file exceeds ~8k tokens to keep index.json manageable.
 */
const MAX_CHUNK_CHARS = 8000 * CHARS_PER_TOKEN  // ~8k tokens

function chunkText(text: string, file: string): KbChunk[] {
  if (text.length <= MAX_CHUNK_CHARS) {
    return [{ file, index: 0, text }]
  }

  // Split on paragraph boundaries (double newline), then combine into chunks
  const paragraphs = text.split(/\n{2,}/)
  const chunks: KbChunk[] = []
  let current = ''
  let idx = 0

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > MAX_CHUNK_CHARS && current.length > 0) {
      chunks.push({ file, index: idx++, text: current.trim() })
      current = ''
    }
    current += (current ? '\n\n' : '') + para
  }
  if (current.trim()) {
    chunks.push({ file, index: idx, text: current.trim() })
  }

  return chunks
}
