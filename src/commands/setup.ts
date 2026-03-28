/**
 * setup.ts — model management and configuration commands
 *
 * Exports: setup, status, listModels, switchModel, editInstructions
 * (all lazily imported by main.ts via dynamic import)
 */

import { VERSION } from '../version.js'
import { createInterface } from 'readline'
import type { Interface as RLInterface } from 'readline'
import { mkdirSync, existsSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'
import { generateText } from 'ai'
import { loadModels, addModel, removeModel, switchActive, addEmbedding, removeEmbedding } from '../storage/models.js'
import { loadMcpConfig } from '../storage/mcp.js'
import { McpClientManager } from '../core/mcp-client.js'
import { listKbs, activeKbTokenEstimate, isKbStale } from '../storage/kb.js'
import { formatApiError } from '../ui/errors.js'
import { DEFAULTS, getModelInstance } from '../core/provider.js'
import { RESET, BOLD, DIM, RED, GREEN, YELLOW, CYAN } from '../ui/colors.js'
import type { ModelConfig, Provider, EmbeddingConfig, EmbeddingProvider } from '../types.js'

export async function setup(): Promise<void> {
  mkdirSync(`${homedir()}/.sysai`, { recursive: true })

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string) => new Promise<string>(resolve => rl.question(q, resolve))

  process.stdout.write(`\n  ${CYAN}sysai setup${RESET} — manage model configurations\n\n`)

  // Main menu loop
  while (true) {
    const data = loadModels()
    const models = data?.models ?? []
    const embeddings = data?.embeddings ?? []

    // Show configured LLMs
    if (models.length === 0) {
      process.stdout.write(`  ${DIM}No LLM models configured yet.${RESET}\n\n`)
    } else {
      process.stdout.write(`  ${DIM}LLM models:${RESET}\n`)
      for (const m of models) {
        const active = m.name === data?.active ? `  ${GREEN}← active${RESET}` : ''
        const modelId = m.model || `${DIM}(default)${RESET}`
        process.stdout.write(`    ${BOLD}${m.name}${RESET}  ${DIM}${m.provider}${RESET}  ${modelId}${active}\n`)
      }
      process.stdout.write('\n')
    }

    // Show configured embeddings
    if (embeddings.length > 0) {
      process.stdout.write(`  ${DIM}Embedding models:${RESET}\n`)
      for (const e of embeddings) {
        process.stdout.write(`    ${BOLD}${e.name}${RESET}  ${DIM}${e.provider}${RESET}  ${e.model}\n`)
      }
      process.stdout.write('\n')
    }

    // Menu
    process.stdout.write(`  ${DIM}a${RESET}) Add LLM model    `)
    if (models.length > 0) {
      process.stdout.write(`${DIM}r${RESET}) Remove LLM    ${DIM}s${RESET}) Set active LLM\n`)
    } else {
      process.stdout.write('\n')
    }
    process.stdout.write(`  ${DIM}e${RESET}) Add embedding    `)
    if (embeddings.length > 0) {
      process.stdout.write(`${DIM}d${RESET}) Remove embedding\n`)
    } else {
      process.stdout.write('\n')
    }
    process.stdout.write(`  ${DIM}q${RESET}) Done\n`)

    const choice = (await ask('  Choice: ')).trim().toLowerCase()
    process.stdout.write('\n')

    if (choice === 'q' || choice === '') { break }

    if (choice === 'a') {
      const cfg = await addModelWizard(ask, rl)
      if (!cfg) { process.stdout.write('\n'); continue }

      addModel(cfg)
      process.stdout.write(`\n${GREEN}  ✓ Added "${cfg.name}"${RESET}\n\n`)

      // Health check (30s timeout for slow networks / local models)
      process.stdout.write(`  ${DIM}Testing connection...${RESET}`)
      try {
        const mdl = getModelInstance(cfg)
        await Promise.race([
          generateText({ model: mdl, prompt: 'Reply with exactly: ok', maxOutputTokens: 10 }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout after 30s')), 30_000)),
        ])
        process.stdout.write(`\r${GREEN}  ✓ Connection works!${RESET}                    \n\n`)
      } catch (err) {
        process.stdout.write(`\r${RED}  ✗ ${formatApiError(err)}${RESET}\n`)
        process.stdout.write(`  ${DIM}Model saved — fix config and test with: sysai status${RESET}\n\n`)
      }

      // Offer to set as active
      if (loadModels()?.active !== cfg.name) {
        const setActive = (await ask(`  Set "${cfg.name}" as active model? [Y/n]: `)).trim().toLowerCase()
        if (setActive !== 'n' && setActive !== 'no') {
          switchActive(cfg.name)
          process.stdout.write(`${GREEN}  ✓ Active model set to "${cfg.name}"${RESET}\n`)
        }
      }
      process.stdout.write('\n')
      continue
    }

    if (choice === 'r' && models.length > 0) {
      const name = (await ask('  LLM name to remove: ')).trim()
      if (!name || !models.find(m => m.name === name)) {
        process.stdout.write(`${RED}  Not found: "${name}"${RESET}\n\n`)
      } else {
        removeModel(name)
        process.stdout.write(`${GREEN}  ✓ Removed "${name}"${RESET}\n\n`)
      }
      continue
    }

    if (choice === 's' && models.length > 0) {
      const name = (await ask('  LLM name to activate: ')).trim()
      try {
        switchActive(name)
        process.stdout.write(`${GREEN}  ✓ Active model set to "${name}"${RESET}\n\n`)
      } catch (err) {
        process.stdout.write(`${RED}  ${(err as Error).message}${RESET}\n\n`)
      }
      continue
    }

    if (choice === 'e') {
      const cfg = await addEmbeddingWizard(ask)
      if (!cfg) { process.stdout.write('\n'); continue }

      addEmbedding(cfg)
      process.stdout.write(`\n${GREEN}  ✓ Added embedding "${cfg.name}"${RESET}\n\n`)

      // Health check — test embedding endpoint
      process.stdout.write(`  ${DIM}Testing embedding...${RESET}`)
      try {
        const { embedTexts } = await import('../core/embeddings.js')
        const result = await embedTexts(['test'], cfg)
        if (result.length > 0 && result[0].length > 0) {
          process.stdout.write(`\r${GREEN}  ✓ Embedding works! (${result[0].length} dimensions)${RESET}                    \n\n`)
        } else {
          throw new Error('empty result')
        }
      } catch (err) {
        process.stdout.write(`\r${RED}  ✗ ${(err as Error).message}${RESET}\n`)
        process.stdout.write(`  ${DIM}Config saved — fix and test with: sysai status${RESET}\n\n`)
      }

      process.stdout.write('\n')
      continue
    }

    if (choice === 'd' && embeddings.length > 0) {
      const name = (await ask('  Embedding name to remove: ')).trim()
      if (!name || !embeddings.find(e => e.name === name)) {
        process.stdout.write(`${RED}  Not found: "${name}"${RESET}\n\n`)
      } else {
        removeEmbedding(name)
        process.stdout.write(`${GREEN}  ✓ Removed embedding "${name}"${RESET}\n\n`)
      }
      continue
    }

    process.stdout.write(`  ${DIM}Unknown option.${RESET}\n\n`)
  }

  rl.close()
}

async function addModelWizard(
  ask: (q: string) => Promise<string>,
  _rl: RLInterface
): Promise<ModelConfig | null> {
  process.stdout.write(`  Which provider?\n\n`)
  process.stdout.write(`    1) Anthropic  ${DIM}(Claude)${RESET}\n`)
  process.stdout.write(`    2) OpenAI     ${DIM}(GPT-4o, gpt-5.4, o3, etc.)${RESET}\n`)
  process.stdout.write(`    3) Local      ${DIM}(llama.cpp, Ollama, any OpenAI-compatible endpoint)${RESET}\n\n`)

  const choice = (await ask('  Choose [1/2/3]: ')).trim()
  let provider: Provider
  let defaultModel: string

  if      (choice === '1') { provider = 'anthropic'; defaultModel = DEFAULTS.anthropic }
  else if (choice === '2') { provider = 'openai';    defaultModel = DEFAULTS.openai    }
  else if (choice === '3') { provider = 'llamacpp';  defaultModel = DEFAULTS.llamacpp  }
  else { process.stdout.write(`${RED}  Invalid choice.${RESET}\n`); return null }

  const cfg: Partial<ModelConfig> & { provider: Provider } = { provider }

  // Provider-specific fields
  if (provider === 'anthropic' || provider === 'openai') {
    const keyLabel = provider === 'anthropic' ? 'Anthropic' : 'OpenAI'
    cfg.apiKey = (await ask(`  ${keyLabel} API key: `)).trim()
    if (!cfg.apiKey) { process.stdout.write(`${RED}  No API key provided.${RESET}\n`); return null }
    const base = (await ask(`  Base URL ${DIM}(Enter for default)${RESET}: `)).trim()
    if (base) cfg.baseUrl = base
  } else {
    cfg.baseUrl = (await ask('  Base URL (e.g. http://localhost:11434/v1): ')).trim()
    if (!cfg.baseUrl) { process.stdout.write(`${RED}  No base URL provided.${RESET}\n`); return null }
    const key = (await ask(`  API key ${DIM}(Enter to skip)${RESET}: `)).trim()
    if (key) cfg.apiKey = key
  }

  const modelId = (await ask(`  Model ID ${DIM}(Enter for ${defaultModel})${RESET}: `)).trim()
  if (modelId) cfg.model = modelId

  const suggestedName = (cfg.model || defaultModel).replace(/[^a-z0-9._-]/gi, '-').toLowerCase()
  const name = (await ask(`  Config name ${DIM}(Enter for "${suggestedName}")${RESET}: `)).trim() || suggestedName
  cfg.name = name

  return cfg as ModelConfig
}

const EMBEDDING_DEFAULTS: Record<string, string> = {
  'openai': 'text-embedding-3-small',
  'openai-compatible': 'nomic-embed-text',
}

async function addEmbeddingWizard(
  ask: (q: string) => Promise<string>,
): Promise<EmbeddingConfig | null> {
  process.stdout.write(`  Which embedding provider?\n\n`)
  process.stdout.write(`    1) OpenAI              ${DIM}(text-embedding-3-small, text-embedding-3-large)${RESET}\n`)
  process.stdout.write(`    2) OpenAI-compatible   ${DIM}(Ollama, llama.cpp, Voyage, Cohere, etc.)${RESET}\n\n`)

  const choice = (await ask('  Choose [1/2]: ')).trim()
  let provider: EmbeddingProvider

  if      (choice === '1') { provider = 'openai' }
  else if (choice === '2') { provider = 'openai-compatible' }
  else { process.stdout.write(`${RED}  Invalid choice.${RESET}\n`); return null }

  const cfg: Partial<EmbeddingConfig> & { provider: EmbeddingProvider } = { provider }

  if (provider === 'openai') {
    cfg.apiKey = (await ask('  OpenAI API key: ')).trim()
    if (!cfg.apiKey) { process.stdout.write(`${RED}  No API key provided.${RESET}\n`); return null }
    const base = (await ask(`  Base URL ${DIM}(Enter for default)${RESET}: `)).trim()
    if (base) cfg.baseUrl = base
  } else {
    cfg.baseUrl = (await ask('  Base URL (e.g. http://localhost:11434/v1): ')).trim()
    if (!cfg.baseUrl) { process.stdout.write(`${RED}  No base URL provided.${RESET}\n`); return null }
    const key = (await ask(`  API key ${DIM}(Enter to skip)${RESET}: `)).trim()
    if (key) cfg.apiKey = key
  }

  const defaultModel = EMBEDDING_DEFAULTS[provider] ?? 'text-embedding-3-small'
  const modelId = (await ask(`  Model ID ${DIM}(Enter for ${defaultModel})${RESET}: `)).trim()
  cfg.model = modelId || defaultModel

  const suggestedName = cfg.model.replace(/[^a-z0-9._-]/gi, '-').toLowerCase()
  const name = (await ask(`  Config name ${DIM}(Enter for "${suggestedName}")${RESET}: `)).trim() || suggestedName
  cfg.name = name

  return cfg as EmbeddingConfig
}

export async function status(): Promise<void> {
  const srcDir = dirname(fileURLToPath(import.meta.url))

  process.stdout.write(`\n  ${CYAN}sysai${RESET} v${VERSION}\n\n`)
  process.stdout.write(`  ${DIM}source:${RESET}  ${srcDir}\n\n`)

  const data = loadModels()
  const models = data?.models ?? []

  if (models.length === 0) {
    process.stdout.write(`  ${YELLOW}No models configured — run: sysai setup${RESET}\n\n`)
    return
  }

  // Ping all models in parallel with 8s timeout
  process.stdout.write(`  ${DIM}checking models…${RESET}\n\n`)

  const ping = async (cfg: ModelConfig): Promise<{ ok: boolean; err?: string }> => {
    try {
      const mdl = getModelInstance(cfg)
      await Promise.race([
        generateText({ model: mdl, prompt: 'Reply: ok', maxOutputTokens: 4 }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 30_000)),
      ])
      return { ok: true }
    } catch (err) {
      return { ok: false, err: formatApiError(err) }
    }
  }

  // Run model pings + MCP connect in parallel
  const mcpConfig  = loadMcpConfig()
  const mcpNames   = Object.keys(mcpConfig.servers ?? {})
  const mcpManager = new McpClientManager()

  const [results] = await Promise.all([
    Promise.all(models.map(m => ping(m))),
    mcpNames.length > 0 ? mcpManager.connectAll(mcpConfig.servers) : Promise.resolve(),
  ])

  // Column widths
  const maxName  = Math.max(...models.map(m => m.name.length), 4)
  const maxProv  = Math.max(...models.map(m => m.provider.length), 8)
  for (let i = 0; i < models.length; i++) {
    const m = models[i]
    const r = results[i]
    const isActive = m.name === data?.active
    const dot = r.ok ? `${GREEN}●${RESET}` : `${RED}●${RESET}`
    const modelId = m.model || `${DIM}${DEFAULTS[m.provider] ?? '?'}${RESET}`
    const activeMark = isActive ? `  ${GREEN}${BOLD}← active${RESET}` : ''
    const errNote = !r.ok ? `  ${RED}${DIM}${r.err}${RESET}` : ''
    const name = isActive ? `${BOLD}${m.name.padEnd(maxName)}${RESET}` : m.name.padEnd(maxName)
    process.stdout.write(`  ${dot}  ${name}  ${m.provider.padEnd(maxProv)}  ${modelId}${activeMark}${errNote}\n`)
  }

  // MCP servers
  if (mcpNames.length > 0) {
    process.stdout.write('\n')
    const connected = new Set(mcpManager.summary().map(s => s.serverName))
    for (const name of mcpNames) {
      if (connected.has(name)) {
        const group = mcpManager.toolsByServer().find(g => g.serverName === name)!
        process.stdout.write(`  ${GREEN}◆${RESET}  ${name}  ${DIM}${group.tools.length} tool${group.tools.length === 1 ? '' : 's'}${RESET}\n`)
      } else {
        process.stdout.write(`  ${RED}◆${RESET}  ${name}  ${RED}${DIM}failed to connect${RESET}\n`)
      }
    }
    mcpManager.closeAll()
  }

  // Embedding models
  const embeddings = data?.embeddings ?? []
  if (embeddings.length > 0) {
    process.stdout.write('\n')
    for (const e of embeddings) {
      process.stdout.write(`  ${DIM}◇${RESET}  ${e.name}  ${DIM}${e.provider}${RESET}  ${e.model}\n`)
    }
  }

  // Knowledge bases
  const kbs = listKbs()
  if (kbs.length > 0) {
    process.stdout.write('\n')
    const CAG_LIMIT = 80_000
    const totalTokens = activeKbTokenEstimate()
    const activeCount = kbs.filter(k => k.active).length

    const { getEmbeddingConfig: getEmb2 } = await import('../storage/models.js')
    for (const k of kbs) {
      const dot = k.active ? `${GREEN}■${RESET}` : `${DIM}□${RESET}`
      const tokens = k.tokenEstimate > 0 ? formatTokensShort(k.tokenEstimate) : 'n/a'
      const docs = `${k.docCount} doc${k.docCount === 1 ? '' : 's'}`
      const stale   = k.lastIndexed && isKbStale(k.name)
      const indexed = !k.lastIndexed ? `  ${YELLOW}(not indexed)${RESET}` : stale ? `  ${YELLOW}(stale)${RESET}` : ''
      let embNote = ''
      if (k.embeddingModel) {
        const cfg = getEmb2(k.embeddingModel)
        embNote = cfg
          ? `  ${DIM}${k.embeddingModel}${RESET}`
          : `  ${YELLOW}${k.embeddingModel} (config removed)${RESET}`
      }
      process.stdout.write(`  ${dot}  ${k.name}  ${DIM}${docs}, ~${tokens} tokens${RESET}${embNote}${indexed}\n`)
    }

    if (activeCount > 0) {
      let mode: string
      if (totalTokens <= CAG_LIMIT) {
        mode = `${GREEN}CAG${RESET} (in-context)`
      } else {
        // Hybrid if any active KB has vectors indexed with a still-valid embedding config
        const { getEmbeddingConfig: getEmb } = await import('../storage/models.js')
        const hasHybrid = kbs.some(k =>
          k.active && k.embeddingModel && getEmb(k.embeddingModel) !== null
        )
        mode = hasHybrid
          ? `${CYAN}search${RESET} (hybrid BM25+vectors)`
          : `${CYAN}search${RESET} (BM25)`
      }
      process.stdout.write(`  ${DIM}mode: ${RESET}${mode}  ${DIM}~${formatTokensShort(totalTokens)} tokens active${RESET}\n`)
    }
  }

  process.stdout.write('\n')

  const ev = (name: string, def: string) => {
    const val = process.env[name]
    return val ? `${val} ${DIM}(from env)${RESET}` : `${DIM}${def} (default)${RESET}`
  }
  process.stdout.write(`  ${DIM}env vars:${RESET}\n`)
  process.stdout.write(`    SYSAI_MAX_TURNS       ${ev('SYSAI_MAX_TURNS',      '20')}  — max agent iterations per query\n`)
  process.stdout.write(`    SYSAI_MAX_TOKENS      ${ev('SYSAI_MAX_TOKENS',   '8192')}  — max tokens per response\n`)
  process.stdout.write(`    SYSAI_BASH_TIMEOUT    ${ev('SYSAI_BASH_TIMEOUT',  '120')}  — seconds before killing a bash command\n`)
  process.stdout.write(`    SYSAI_COMPACT_KEEP    ${ev('SYSAI_COMPACT_KEEP',    '6')}  — turns to keep when compacting\n`)
  process.stdout.write(`    SYSAI_NO_JINA         ${process.env.SYSAI_NO_JINA ? `${YELLOW}1 (Jina disabled)${RESET}` : `${DIM}unset (Jina enabled)${RESET}`}  — disable Jina Reader and web search\n`)
  process.stdout.write(`    GITHUB_TOKEN          ${process.env.GITHUB_TOKEN   ? `${GREEN}set${RESET}` : `${DIM}unset (60 req/hr)${RESET}`}  — GitHub API token (5000 req/hr when set)\n`)
  process.stdout.write(`\n  ${DIM}sysai model <name>${RESET}   switch active model\n`)
  process.stdout.write(`  ${DIM}sysai setup${RESET}           add / remove models\n\n`)
}

export async function listModels(): Promise<void> {
  const data = loadModels()
  if (!data?.models?.length) {
    process.stdout.write(`No models configured. Run: ${CYAN}sysai setup${RESET}\n`)
    return
  }

  const models = data.models
  const maxName = Math.max(...models.map(m => m.name.length),     4)
  const maxProv = Math.max(...models.map(m => m.provider.length), 8)
  const maxMdl  = Math.max(...models.map(m => (m.model || DEFAULTS[m.provider] || '?').length), 5)

  process.stdout.write('\n')
  // Header
  process.stdout.write(
    `  ${DIM}${'NAME'.padEnd(maxName)}  ${'PROVIDER'.padEnd(maxProv)}  ${'MODEL'.padEnd(maxMdl)}  STATUS${RESET}\n`
  )
  process.stdout.write(`  ${DIM}${'-'.repeat(maxName + maxProv + maxMdl + 16)}${RESET}\n`)

  for (const m of models) {
    const isActive = m.name === data.active
    const modelId  = m.model || DEFAULTS[m.provider] || '?'
    const status   = isActive ? `${GREEN}● active${RESET}` : `${DIM}○${RESET}`
    const name     = isActive ? `${BOLD}${m.name.padEnd(maxName)}${RESET}` : m.name.padEnd(maxName)
    process.stdout.write(`  ${name}  ${DIM}${m.provider.padEnd(maxProv)}${RESET}  ${modelId.padEnd(maxMdl)}  ${status}\n`)
  }
  process.stdout.write('\n')
}

export async function switchModel(name?: string): Promise<void> {
  const data = loadModels()
  if (!data?.models?.length) {
    process.stderr.write(`sysai: No models configured. Run: sysai setup\n`)
    process.exit(1)
  }

  let resolvedName = name
  if (!resolvedName) {
    // Interactive picker
    process.stdout.write('\n')
    const models = data.models
    for (let i = 0; i < models.length; i++) {
      const m = models[i]
      const active = m.name === data.active ? `  ${GREEN}← active${RESET}` : ''
      const modelId = m.model || `${DIM}${DEFAULTS[m.provider] ?? '?'}${RESET}`
      process.stdout.write(`  ${DIM}${i + 1})${RESET}  ${BOLD}${m.name}${RESET}  ${DIM}${m.provider}${RESET}  ${modelId}${active}\n`)
    }
    process.stdout.write('\n')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise<string>(resolve => rl.question('  Switch to (name or number): ', resolve))
    rl.close()
    const num = parseInt(answer.trim())
    resolvedName = (!isNaN(num) && num >= 1 && num <= models.length)
      ? models[num - 1].name
      : answer.trim()
  }

  try {
    switchActive(resolvedName)
    process.stdout.write(`${GREEN}  ✓ Active model: ${BOLD}${resolvedName}${RESET}\n\n`)
  } catch (err) {
    process.stderr.write(`${RED}sysai: ${(err as Error).message}${RESET}\n`)
    process.exit(1)
  }
}

export async function editInstructions(): Promise<void> {
  const path = `${homedir()}/.sysai/instructions.md`
  mkdirSync(`${homedir()}/.sysai`, { recursive: true })

  if (!existsSync(path)) {
    writeFileSync(path, [
      '# Machine-specific instructions for sysai',
      '# This file is injected into every query. Keep it concise and specific.',
      '# Examples: cluster name, scheduler, key paths, job script templates.',
      '',
    ].join('\n'), 'utf8')
  }

  const editor = process.env.VISUAL || process.env.EDITOR || 'vi'
  spawnSync(editor, [path], { stdio: 'inherit' })
}

function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
