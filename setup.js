/**
 * setup.js — model management and configuration commands
 *
 * Exports: setup, status, listModels, switchModel, editInstructions
 * (all lazily imported by main.js via dynamic import)
 */

import { VERSION } from './version.js'
import { createInterface } from 'readline'
import { mkdirSync, existsSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'
import { formatApiError } from './errors.js'
import { RESET, BOLD, DIM, RED, GREEN, YELLOW, CYAN } from './colors.js'

export async function setup() {
  const { loadModels, saveModels, addModel, removeModel, switchActive } = await import('./models.js')
  const { generateText } = await import('ai')
  const { getModelInstance } = await import('./provider.js')

  mkdirSync(`${homedir()}/.sysai`, { recursive: true })

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q) => new Promise(resolve => rl.question(q, resolve))

  process.stdout.write(`\n  ${CYAN}sysai setup${RESET} — manage model configurations\n\n`)

  // Main menu loop
  while (true) {
    const data = loadModels()
    const models = data?.models ?? []

    if (models.length === 0) {
      process.stdout.write(`  ${DIM}No models configured yet.${RESET}\n\n`)
    } else {
      process.stdout.write(`  ${DIM}Configured models:${RESET}\n`)
      for (const m of models) {
        const active = m.name === data?.active ? `  ${GREEN}← active${RESET}` : ''
        const modelId = m.model || `${DIM}(default)${RESET}`
        process.stdout.write(`    ${BOLD}${m.name}${RESET}  ${DIM}${m.provider}${RESET}  ${modelId}${active}\n`)
      }
      process.stdout.write('\n')
    }

    process.stdout.write(`  ${DIM}a${RESET}) Add model    `)
    if (models.length > 0) {
      process.stdout.write(`${DIM}r${RESET}) Remove model    ${DIM}s${RESET}) Set active    `)
    }
    process.stdout.write(`${DIM}q${RESET}) Done\n`)

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
          generateText({ model: mdl, prompt: 'Reply with exactly: ok', maxTokens: 10 }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout after 30s')), 30_000)),
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
      const name = (await ask('  Model name to remove: ')).trim()
      if (!name || !models.find(m => m.name === name)) {
        process.stdout.write(`${RED}  Not found: "${name}"${RESET}\n\n`)
      } else {
        removeModel(name)
        process.stdout.write(`${GREEN}  ✓ Removed "${name}"${RESET}\n\n`)
      }
      continue
    }

    if (choice === 's' && models.length > 0) {
      const name = (await ask('  Model name to activate: ')).trim()
      try {
        switchActive(name)
        process.stdout.write(`${GREEN}  ✓ Active model set to "${name}"${RESET}\n\n`)
      } catch (err) {
        process.stdout.write(`${RED}  ${err.message}${RESET}\n\n`)
      }
      continue
    }

    process.stdout.write(`  ${DIM}Unknown option.${RESET}\n\n`)
  }

  rl.close()
}

async function addModelWizard(ask, rl) {
  const DEFAULTS = { anthropic: 'claude-sonnet-4-6', openai: 'gpt-4o', llamacpp: 'local' }

  process.stdout.write(`  Which provider?\n\n`)
  process.stdout.write(`    1) Anthropic  ${DIM}(Claude)${RESET}\n`)
  process.stdout.write(`    2) OpenAI     ${DIM}(GPT-4o, gpt-5.4, o3, etc.)${RESET}\n`)
  process.stdout.write(`    3) Local      ${DIM}(llama.cpp, Ollama, any OpenAI-compatible endpoint)${RESET}\n\n`)

  const choice = (await ask('  Choose [1/2/3]: ')).trim()
  let provider, defaultModel

  if      (choice === '1') { provider = 'anthropic'; defaultModel = DEFAULTS.anthropic }
  else if (choice === '2') { provider = 'openai';    defaultModel = DEFAULTS.openai    }
  else if (choice === '3') { provider = 'llamacpp';  defaultModel = DEFAULTS.llamacpp  }
  else { process.stdout.write(`${RED}  Invalid choice.${RESET}\n`); return null }

  const cfg = { provider }

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

  return cfg
}

export async function status() {
  const { loadModels } = await import('./models.js')
  const { getModelInstance } = await import('./provider.js')
  const { generateText }     = await import('ai')

  const srcDir = dirname(fileURLToPath(import.meta.url))

  process.stdout.write(`\n  ${CYAN}sysai${RESET} v${VERSION}\n\n`)
  process.stdout.write(`  ${DIM}source:${RESET}  ${srcDir}\n\n`)

  const data = loadModels()
  const models = data?.models ?? []

  if (models.length === 0) {
    // Legacy flat config fallback
    const configPath = `${homedir()}/.sysai/config`
    if (!existsSync(configPath)) {
      process.stdout.write(`  ${YELLOW}No models configured — run: sysai setup${RESET}\n\n`)
      return
    }
    process.stdout.write(`  ${DIM}(legacy config — run 'sysai setup' to migrate to named models)${RESET}\n\n`)
    return
  }

  // Ping all models in parallel with 8s timeout
  process.stdout.write(`  ${DIM}checking models…${RESET}\n\n`)

  const TIMEOUT = 30_000
  const ping = async (cfg) => {
    try {
      const mdl = getModelInstance(cfg)
      await Promise.race([
        generateText({ model: mdl, prompt: 'Reply: ok', maxTokens: 4 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT)),
      ])
      return { ok: true }
    } catch (err) {
      return { ok: false, err: formatApiError(err) }
    }
  }

  const results = await Promise.all(models.map(m => ping(m)))

  // Column widths
  const maxName  = Math.max(...models.map(m => m.name.length), 4)
  const maxProv  = Math.max(...models.map(m => m.provider.length), 8)
  const DEFAULTS = { anthropic: 'claude-sonnet-4-6', openai: 'gpt-4o', llamacpp: 'local' }

  for (let i = 0; i < models.length; i++) {
    const m = models[i]
    const r = results[i]
    const isActive = m.name === data.active
    const dot = r.ok ? `${GREEN}●${RESET}` : `${RED}●${RESET}`
    const modelId = m.model || `${DIM}${DEFAULTS[m.provider] ?? '?'}${RESET}`
    const activeMark = isActive ? `  ${GREEN}${BOLD}← active${RESET}` : ''
    const errNote = !r.ok ? `  ${RED}${DIM}${r.err}${RESET}` : ''
    const name = isActive ? `${BOLD}${m.name.padEnd(maxName)}${RESET}` : m.name.padEnd(maxName)
    process.stdout.write(`  ${dot}  ${name}  ${m.provider.padEnd(maxProv)}  ${modelId}${activeMark}${errNote}\n`)
  }

  process.stdout.write('\n')

  const maxTurns = process.env.SYSAI_MAX_TURNS || '20 (default)'
  process.stdout.write(`  ${DIM}max turns:${RESET}  ${maxTurns}\n`)
  process.stdout.write(`\n  ${DIM}sysai model <name>${RESET}   switch active model\n`)
  process.stdout.write(`  ${DIM}sysai setup${RESET}           add / remove models\n\n`)
}

export async function listModels() {
  const { loadModels } = await import('./models.js')
  const DEFAULTS = { anthropic: 'claude-sonnet-4-6', openai: 'gpt-4o', llamacpp: 'local' }

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

export async function switchModel(name) {
  const { loadModels, switchActive } = await import('./models.js')
  const DEFAULTS = { anthropic: 'claude-sonnet-4-6', openai: 'gpt-4o', llamacpp: 'local' }

  const data = loadModels()
  if (!data?.models?.length) {
    process.stderr.write(`sysai: No models configured. Run: sysai setup\n`)
    process.exit(1)
  }

  if (!name) {
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
    const answer = await new Promise(resolve => rl.question('  Switch to (name or number): ', resolve))
    rl.close()
    const num = parseInt(answer.trim())
    name = (!isNaN(num) && num >= 1 && num <= models.length)
      ? models[num - 1].name
      : answer.trim()
  }

  try {
    switchActive(name)
    process.stdout.write(`${GREEN}  ✓ Active model: ${BOLD}${name}${RESET}\n\n`)
  } catch (err) {
    process.stderr.write(`${RED}sysai: ${err.message}${RESET}\n`)
    process.exit(1)
  }
}

export async function editInstructions() {
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
