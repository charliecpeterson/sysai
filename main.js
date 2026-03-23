#!/usr/bin/env node
/**
 * main.js — unified entry point for the sysai binary
 *
 * Usage:
 *   sysai repl          — start interactive agentic REPL (ai-pane)
 *   sysai ask <q>       — one-shot query
 *   sysai --setup-shell — print shell integration block (for remote install)
 */

export const VERSION = '0.1.0'

const [, , cmd, ...rest] = process.argv

switch (cmd) {
  case 'repl':
  case 'pane':
    await import('./server.js')
    break

  case 'ask':
    process.argv = [process.argv[0], process.argv[1], ...rest]
    await import('./cli.js')
    break

  case '--version':
    process.stdout.write(VERSION + '\n')
    break

  case 'install':
    await install()
    break

  case 'setup':
    await setup()
    break

  case '--setup-shell':
    await setupShell()
    break

  default:
    // No subcommand — if args given treat as one-shot, otherwise show usage
    if (process.argv.length > 2) {
      await import('./cli.js')
    } else {
      console.error('Usage:')
      console.error('  sysai repl            — start interactive AI assistant')
      console.error('  sysai ask <question>  — one-shot query')
      console.error('  sysai install         — set up ~/.sysai, shell integration, and provider')
      console.error('  sysai setup           — reconfigure provider and API key')
      console.error('  sysai --version       — print version')
      process.exit(1)
    }
}

async function install() {
  const { writeFileSync, readFileSync, mkdirSync, existsSync, copyFileSync, chmodSync, symlinkSync, unlinkSync } = await import('fs')
  const { homedir } = await import('os')
  const { dirname, join } = await import('path')
  const { fileURLToPath } = await import('url')
  const { execSync } = await import('child_process')

  const DIM = '\x1b[2m', RESET = '\x1b[0m', GREEN = '\x1b[32m', CYAN = '\x1b[36m'
  const home = homedir()
  const dir = `${home}/.sysai`
  const binDir = `${dir}/bin`
  const binPath = `${binDir}/sysai`

  process.stdout.write(`\n  ${CYAN}sysai${RESET} — terminal-native AI assistant\n\n`)

  // 1. Create directory structure
  mkdirSync(binDir, { recursive: true })
  mkdirSync(`${dir}/history`, { recursive: true })
  chmodSync(dir, 0o700)
  process.stdout.write(`${GREEN}  ✓${RESET} Created ~/.sysai/\n`)

  // 2. Install binary — figure out where we're running from
  const selfPath = process.argv[1]
  const srcDir = dirname(fileURLToPath(import.meta.url))

  // If running from a compiled binary, copy it
  // If running via node from source, symlink main.js
  const isBundled = !selfPath.endsWith('.js')

  if (isBundled) {
    // Compiled binary — copy ourselves to ~/.sysai/bin/sysai
    copyFileSync(selfPath, binPath)
    chmodSync(binPath, 0o755)
    process.stdout.write(`${GREEN}  ✓${RESET} Installed binary to ~/.sysai/bin/sysai\n`)
  } else {
    // Running from source — check for prebuilt binary first
    const os = process.platform === 'darwin' ? 'darwin' : 'linux'
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const prebuilt = join(srcDir, 'dist', `sysai-${os}-${arch}`)

    if (existsSync(prebuilt)) {
      copyFileSync(prebuilt, binPath)
      chmodSync(binPath, 0o755)
      process.stdout.write(`${GREEN}  ✓${RESET} Installed binary to ~/.sysai/bin/sysai\n`)
    } else {
      // Symlink to source main.js
      const mainJs = join(srcDir, 'main.js')
      try { unlinkSync(binPath) } catch {}
      symlinkSync(mainJs, binPath)
      chmodSync(mainJs, 0o755)
      process.stdout.write(`${GREEN}  ✓${RESET} Linked ~/.sysai/bin/sysai → ${mainJs}\n`)
    }
  }

  // 3. Ensure ~/.local/bin is available and has sysai
  const localBin = `${home}/.local/bin`
  mkdirSync(localBin, { recursive: true })
  const localLink = `${localBin}/sysai`
  try { unlinkSync(localLink) } catch {}
  symlinkSync(binPath, localLink)
  process.stdout.write(`${GREEN}  ✓${RESET} Linked ~/.local/bin/sysai\n`)

  // 4. Write shell.bash
  let shellContent
  try {
    shellContent = readFileSync(join(srcDir, 'shell.bash'), 'utf8')
  } catch {
    // Fallback: inline minimal shell.bash
    shellContent = [
      '# sysai shell integration — managed by sysai, do not edit manually',
      'SYSAI_BIN="$HOME/.sysai/bin/sysai"',
      '? () { if [ -t 0 ]; then "$SYSAI_BIN" ask "$@"; else cat | "$SYSAI_BIN" ask "$@"; fi; }',
      'ai-pane () { "$SYSAI_BIN" repl; }',
    ].join('\n') + '\n'
  }
  writeFileSync(`${dir}/shell.bash`, shellContent, { mode: 0o644 })
  process.stdout.write(`${GREEN}  ✓${RESET} Wrote ~/.sysai/shell.bash\n`)

  // 5. Add source line to shell rc file
  const shell = (process.env.SHELL || 'bash').split('/').pop()
  const rcFile = shell === 'zsh' ? `${home}/.zshrc` : `${home}/.bashrc`
  const sourceLine = '[ -f ~/.sysai/shell.bash ] && source ~/.sysai/shell.bash'

  let rcContent = ''
  try { rcContent = readFileSync(rcFile, 'utf8') } catch {}

  if (rcContent.includes('source ~/.sysai/shell.bash')) {
    process.stdout.write(`${GREEN}  ✓${RESET} Shell integration already in ${rcFile}\n`)
  } else {
    // Remove old inline block if present
    if (rcContent.includes('# sysai shell integration')) {
      rcContent = rcContent.replace(/# sysai shell integration[\s\S]*?# END_SYSAI\n?/, '')
      writeFileSync(rcFile, rcContent, 'utf8')
      process.stdout.write(`${GREEN}  ✓${RESET} Removed old inline integration from ${rcFile}\n`)
    }
    writeFileSync(rcFile, rcContent.trimEnd() + '\n\n' + sourceLine + '\n', 'utf8')
    process.stdout.write(`${GREEN}  ✓${RESET} Added source line to ${rcFile}\n`)
  }

  // 6. Run setup if no config exists
  process.stdout.write('\n')
  if (existsSync(`${dir}/config`)) {
    process.stdout.write(`${GREEN}  ✓${RESET} Config already exists\n\n`)
    process.stdout.write(`  Done! Run ${CYAN}source ${rcFile}${RESET} then ${CYAN}? hello${RESET}\n`)
    process.stdout.write(`  To reconfigure: ${CYAN}sysai setup${RESET}\n\n`)
  } else {
    process.stdout.write(`${DIM}  Now let's configure your AI provider:${RESET}\n\n`)
    await setup()
    process.stdout.write(`  Done! Run ${CYAN}source ${rcFile}${RESET} then ${CYAN}? hello${RESET}\n\n`)
  }
}

async function setup() {
  const readline = await import('readline')
  const { writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync } = await import('fs')
  const { homedir } = await import('os')

  const dir = `${homedir()}/.sysai`
  const configPath = `${dir}/config`
  mkdirSync(dir, { recursive: true })

  const DIM = '\x1b[2m', RESET = '\x1b[0m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', YELLOW = '\x1b[33m'

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q) => new Promise(resolve => rl.question(q, resolve))

  // Show current config if exists
  if (existsSync(configPath)) {
    try {
      const current = readFileSync(configPath, 'utf8')
      const provider = current.match(/^SYSAI_PROVIDER=(.+)$/m)?.[1]
      const model = current.match(/^SYSAI_MODEL=(.+)$/m)?.[1]
      const hasKey = /API_KEY=.+/.test(current)
      const baseURL = current.match(/^SYSAI_BASE_URL=(.+)$/m)?.[1]
      process.stdout.write(`\n${DIM}Current config:${RESET}\n`)
      process.stdout.write(`  provider: ${provider || '(none)'}\n`)
      if (model) process.stdout.write(`  model:    ${model}\n`)
      if (hasKey) process.stdout.write(`  api key:  ${DIM}configured${RESET}\n`)
      if (baseURL) process.stdout.write(`  base url: ${baseURL}\n`)
      process.stdout.write('\n')
    } catch {}
  }

  process.stdout.write(`  Which AI provider?\n\n`)
  process.stdout.write(`    1) Anthropic  ${DIM}(Claude)${RESET}\n`)
  process.stdout.write(`    2) OpenAI     ${DIM}(GPT-4o, o3, etc.)${RESET}\n`)
  process.stdout.write(`    3) Local      ${DIM}(llama.cpp, Ollama, or any OpenAI-compatible endpoint)${RESET}\n\n`)

  const choice = (await ask('  Choose [1/2/3]: ')).trim()

  const config = {}

  switch (choice) {
    case '1':
      config.SYSAI_PROVIDER = 'anthropic'
      config.ANTHROPIC_API_KEY = (await ask('  Anthropic API key: ')).trim()
      if (!config.ANTHROPIC_API_KEY) { process.stdout.write(`${RED}  No API key provided.${RESET}\n`); rl.close(); return }
      const aBase = (await ask(`  Base URL ${DIM}(Enter for default)${RESET}: `)).trim()
      if (aBase) config.ANTHROPIC_BASE_URL = aBase
      const aModel = (await ask(`  Model ${DIM}(Enter for claude-sonnet-4-6)${RESET}: `)).trim()
      if (aModel) config.SYSAI_MODEL = aModel
      break

    case '2':
      config.SYSAI_PROVIDER = 'openai'
      config.OPENAI_API_KEY = (await ask('  OpenAI API key: ')).trim()
      if (!config.OPENAI_API_KEY) { process.stdout.write(`${RED}  No API key provided.${RESET}\n`); rl.close(); return }
      const oBase = (await ask(`  Base URL ${DIM}(Enter for default)${RESET}: `)).trim()
      if (oBase) config.OPENAI_BASE_URL = oBase
      const oModel = (await ask(`  Model ${DIM}(Enter for gpt-4o)${RESET}: `)).trim()
      if (oModel) config.SYSAI_MODEL = oModel
      break

    case '3':
      config.SYSAI_PROVIDER = 'llamacpp'
      config.SYSAI_BASE_URL = (await ask('  Base URL (e.g. http://localhost:11434/v1): ')).trim()
      if (!config.SYSAI_BASE_URL) { process.stdout.write(`${RED}  No base URL provided.${RESET}\n`); rl.close(); return }
      const lKey = (await ask(`  API key ${DIM}(Enter to skip)${RESET}: `)).trim()
      if (lKey) config.SYSAI_API_KEY = lKey
      const lModel = (await ask(`  Model name ${DIM}(Enter for default)${RESET}: `)).trim()
      if (lModel) config.SYSAI_MODEL = lModel
      break

    default:
      process.stdout.write(`${RED}  Invalid choice.${RESET}\n`)
      rl.close()
      return
  }

  // Write config
  const configContent = Object.entries(config).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
  writeFileSync(configPath, configContent, { mode: 0o600 })
  process.stdout.write(`\n${GREEN}  ✓${RESET} Config saved to ~/.sysai/config\n`)

  // Health check
  process.stdout.write(`${DIM}  Testing connection...${RESET}`)

  // Load the new config into env
  for (const [k, v] of Object.entries(config)) {
    process.env[k] = v
  }

  try {
    const { generateText } = await import('ai')
    const { getModel } = await import('./provider.js')
    const model = getModel()
    const { text } = await generateText({
      model,
      prompt: 'Reply with exactly: ok',
      maxTokens: 10,
    })
    if (text.toLowerCase().includes('ok')) {
      process.stdout.write(`\r${GREEN}  ✓ Connection works!${RESET}          \n\n`)
    } else {
      process.stdout.write(`\r${GREEN}  ✓ Got response: ${text.slice(0, 30)}${RESET}          \n\n`)
    }
  } catch (err) {
    const msg = err.message || String(err)
    process.stdout.write(`\r${RED}  ✗ Connection failed: ${msg.slice(0, 80)}${RESET}          \n`)
    process.stdout.write(`${DIM}  Config saved — fix the issue and run 'sysai setup' again.${RESET}\n\n`)
  }

  rl.close()
}

async function setupShell() {
  const { writeFileSync, readFileSync, mkdirSync } = await import('fs')
  const { homedir } = await import('os')
  const dir = `${homedir()}/.sysai`
  mkdirSync(dir, { recursive: true })

  // Copy shell.bash from the source directory next to this script
  const { dirname } = await import('path')
  const { fileURLToPath } = await import('url')
  let shellContent
  try {
    // Try bundled location first (same dir as main.js)
    const srcDir = dirname(fileURLToPath(import.meta.url))
    shellContent = readFileSync(`${srcDir}/shell.bash`, 'utf8')
  } catch {
    // Fallback: read from installed location
    shellContent = readFileSync(`${dir}/shell.bash`, 'utf8')
  }

  writeFileSync(`${dir}/shell.bash`, shellContent, { mode: 0o644 })
  process.stderr.write(`Wrote ${dir}/shell.bash\n`)
  process.stderr.write(`Add this line to your shell rc file:\n\n`)
  // Print the source line to stdout (so `>> ~/.bashrc` works)
  process.stdout.write(`[ -f ~/.sysai/shell.bash ] && source ~/.sysai/shell.bash\n`)
}
