#!/usr/bin/env node
/**
 * main.js — unified entry point for the sysai binary
 *
 * Usage:
 *   sysai repl          — start interactive agentic REPL (ai-pane)
 *   sysai ask <q>       — one-shot query
 *   sysai --setup-shell — print shell integration block (for remote install)
 */

export { VERSION } from './version.js'
import { VERSION } from './version.js'

import { RESET, BOLD, DIM, GREEN, CYAN } from './colors.js'

const [, , cmd, ...rest] = process.argv

switch (cmd) {
  case 'chat':
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
    process.exit(0)

  case 'setup': {
    const { setup } = await import('./setup.js')
    await setup()
    process.exit(0)
  }

  case 'status': {
    const { status } = await import('./setup.js')
    await status()
    process.exit(0)
  }

  case 'models': {
    const { listModels } = await import('./setup.js')
    await listModels()
    process.exit(0)
  }

  case 'model': {
    const { switchModel } = await import('./setup.js')
    await switchModel(rest[0])
    process.exit(0)
  }

  case 'instructions': {
    const { editInstructions } = await import('./setup.js')
    await editInstructions()
    process.exit(0)
  }

  case 'tasks': {
    const { listTasksCmd } = await import('./task.js')
    await listTasksCmd()
    process.exit(0)
  }

  case 'task': {
    const { taskCmd } = await import('./task.js')
    await taskCmd(rest)
    process.exit(0)
  }

  case '--setup-shell':
    await setupShell()
    break

  case 'help':
  case '--help':
  case '-h':
    printHelp()
    break

  default: {
    // Check if cmd matches a saved task
    if (cmd) {
      const { loadTask, runTaskCmd } = await import('./task.js')
      const task = loadTask(cmd)
      if (task) {
        const dryRun = rest.includes('--dry-run')
        await runTaskCmd(task, { dryRun })
        process.exit(0)
      }
    }
    // No subcommand — if args given treat as one-shot question, otherwise show help
    if (process.argv.length > 2) {
      await import('./cli.js')
    } else {
      printHelp()
      process.exit(1)
    }
  }
}

function printHelp() {
  process.stdout.write(`\n  ${CYAN}${BOLD}sysai${RESET} v${VERSION} — terminal AI assistant\n\n`)
  process.stdout.write(`  ${BOLD}Usage:${RESET}  sysai <command> [args]\n\n`)

  const sections = [
    ['Chat', [
      ['chat',               'Start interactive AI assistant (tmux split pane)'],
      ['ask <question>',     'One-shot query  (also: ? <question>)'],
    ]],
    ['Models', [
      ['models',             'List configured models in a table'],
      ['model [name]',       'Switch active model (interactive if no name given)'],
      ['status',             'Show all models with live health check'],
      ['setup',              'Add / remove / configure model providers'],
    ]],
    ['Tasks', [
      ['tasks',              'List all saved tasks'],
      ['<taskname>',         'Run a saved task'],
      ['task new',           'Create a task with AI assistance'],
      ['task test <name>',   'Dry-run a task — show commands then AI analysis'],
      ['task edit <name>',   'Open task file in $EDITOR'],
      ['task rm <name>',     'Delete a task'],
    ]],
    ['Config', [
      ['instructions',       'Edit ~/.sysai/instructions.md (injected into every query)'],
      ['install',            'Set up ~/.sysai, shell integration, and provider'],
    ]],
    ['Other', [
      ['help',               'Show this help'],
      ['--version',          'Print version'],
    ]],
  ]

  for (const [section, rows] of sections) {
    process.stdout.write(`  ${DIM}── ${section}${RESET}\n`)
    for (const [cmd, desc] of rows) {
      process.stdout.write(`    ${CYAN}sysai ${cmd.padEnd(22)}${RESET}  ${desc}\n`)
    }
    process.stdout.write('\n')
  }
}

async function install() {
  const { writeFileSync, readFileSync, mkdirSync, existsSync, copyFileSync, chmodSync, symlinkSync, unlinkSync } = await import('fs')
  const { homedir } = await import('os')
  const { dirname, join } = await import('path')
  const { fileURLToPath } = await import('url')
  const { execSync } = await import('child_process')

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

      // Install npm dependencies if needed
      const nmPath = join(srcDir, 'node_modules')
      const { existsSync: exists } = await import('fs')
      if (!exists(nmPath)) {
        process.stdout.write(`${DIM}  Installing dependencies...${RESET}`)
        execSync('npm install --silent', { cwd: srcDir })
        process.stdout.write(`\r${GREEN}  ✓${RESET} Dependencies installed          \n`)
      }
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

  // 6. Copy built-in tasks (skip if user already has one with the same name)
  const tasksDir  = `${dir}/tasks`
  const srcTasks  = join(srcDir, 'tasks')
  mkdirSync(tasksDir, { recursive: true })
  if (existsSync(srcTasks)) {
    const { readdirSync } = await import('fs')
    let copied = 0
    for (const f of readdirSync(srcTasks).filter(f => f.endsWith('.md'))) {
      const dest = join(tasksDir, f)
      if (!existsSync(dest)) {
        copyFileSync(join(srcTasks, f), dest)
        copied++
      }
    }
    if (copied > 0)
      process.stdout.write(`${GREEN}  ✓${RESET} Installed ${copied} built-in task(s) to ~/.sysai/tasks/\n`)
  }

  // 7. Run setup if no config exists
  process.stdout.write('\n')
  if (existsSync(`${dir}/models.json`)) {
    process.stdout.write(`${GREEN}  ✓${RESET} Config already exists\n\n`)
    process.stdout.write(`  Done! Run ${CYAN}source ${rcFile}${RESET} then ${CYAN}? hello${RESET}\n`)
    process.stdout.write(`  To reconfigure: ${CYAN}sysai setup${RESET}\n\n`)
  } else {
    process.stdout.write(`${DIM}  Now let's configure your AI provider:${RESET}\n\n`)
    const { setup } = await import('./setup.js')
    await setup()
    process.stdout.write(`  Done! Run ${CYAN}source ${rcFile}${RESET} then ${CYAN}? hello${RESET}\n\n`)
  }
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
