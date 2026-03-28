#!/usr/bin/env bun
/**
 * main.ts — unified entry point for the sysai binary
 *
 * Usage:
 *   sysai chat          — interactive chat (tmux split pane)
 *   sysai ask <q>       — one-shot query
 *   sysai --setup-shell — print shell integration block
 */

export { VERSION } from './src/version.js'
import { VERSION } from './src/version.js'

import { RESET, BOLD, DIM, RED, GREEN, CYAN } from './src/ui/colors.js'

const [, , cmd, ...rest] = process.argv

switch (cmd) {
  case 'chat':
    await import('./src/commands/chat.js')
    break

  case 'ask':
    process.argv = [process.argv[0], process.argv[1], ...rest]
    await import('./src/commands/ask.js')
    break

  case '--version':
    process.stdout.write(VERSION + '\n')
    break

  case 'install':
    await install()
    process.exit(0)

  case 'setup': {
    const { setup } = await import('./src/commands/setup.js')
    await setup()
    process.exit(0)
  }

  case 'status': {
    const { status } = await import('./src/commands/setup.js')
    await status()
    process.exit(0)
  }

  case 'models': {
    const { listModels } = await import('./src/commands/setup.js')
    await listModels()
    process.exit(0)
  }

  case 'model': {
    const { switchModel } = await import('./src/commands/setup.js')
    await switchModel(rest[0])
    process.exit(0)
  }

  case 'instructions': {
    const { editInstructions } = await import('./src/commands/setup.js')
    await editInstructions()
    process.exit(0)
  }

  case 'mcp': {
    const subCmd = rest[0]
    const { listMcps, addMcp, editMcp, removeMcp, testMcp } = await import('./src/commands/mcp.js')
    if (!subCmd || subCmd === 'list') {
      await listMcps()
    } else if (subCmd === 'add') {
      await addMcp()
    } else if (subCmd === 'edit') {
      await editMcp(rest[1])
    } else if (subCmd === 'remove' || subCmd === 'rm') {
      removeMcp(rest[1])
    } else if (subCmd === 'test') {
      await testMcp(rest[1])
    } else {
      process.stderr.write(`sysai: unknown mcp subcommand "${subCmd}". Try: list, add, edit, remove, test\n`)
      process.exit(1)
    }
    process.exit(0)
  }

  case 'kb': {
    const subCmd = rest[0]
    const { addKb, listKb, indexKbCmd, activateKb, deactivateKb, deleteKbCmd, addFileCmd } = await import('./src/commands/kb.js')
    if (!subCmd || subCmd === 'list') {
      await listKb()
    } else if (subCmd === 'add') {
      await addKb(rest.slice(1))
    } else if (subCmd === 'index') {
      await indexKbCmd(rest[1])
    } else if (subCmd === 'on') {
      activateKb(rest[1])
    } else if (subCmd === 'off') {
      deactivateKb(rest[1])
    } else if (subCmd === 'add-file') {
      await addFileCmd(rest[1], rest[2])
    } else if (subCmd === 'delete' || subCmd === 'rm') {
      await deleteKbCmd(rest[1])
    } else {
      process.stderr.write(`sysai: unknown kb subcommand "${subCmd}". Try: list, add, add-file, index, on, off, delete\n`)
      process.exit(1)
    }
    process.exit(0)
  }

  case 'tasks': {
    const { listTasksCmd } = await import('./src/task/task.js')
    await listTasksCmd()
    process.exit(0)
  }

  case 'task': {
    const { taskCmd } = await import('./src/task/task.js')
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
      const { loadTask, runTaskCmd } = await import('./src/task/task.js')
      const task = loadTask(cmd)
      if (task) {
        const dryRun = rest.includes('--dry-run')
        await runTaskCmd(task, { dryRun })
        process.exit(0)
      }
    }
    // No subcommand — if args given treat as one-shot question, otherwise show help
    if (process.argv.length > 2) {
      await import('./src/commands/ask.js')
    } else {
      printHelp()
      process.exit(1)
    }
  }
}

function printHelp(): void {
  process.stdout.write(`\n  ${CYAN}${BOLD}sysai${RESET} v${VERSION} — terminal AI assistant\n\n`)
  process.stdout.write(`  ${BOLD}Usage:${RESET}  sysai <command> [args]\n\n`)

  const sections: Array<[string, Array<[string, string]>]> = [
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
    ['MCP', [
      ['mcp list',           'List configured MCP servers'],
      ['mcp add',            'Add an MCP server (interactive wizard)'],
      ['mcp edit <name>',    'Edit a server\'s config in place'],
      ['mcp remove <name>',  'Remove an MCP server'],
      ['mcp test [name]',    'Connect and list tools (all servers if no name)'],
    ]],
    ['Knowledge Base', [
      ['kb list',                   'List knowledge bases with status and size'],
      ['kb add <name>',             'Create a knowledge base'],
      ['kb add-file <name> <path>', 'Copy file or directory into KB and re-index'],
      ['kb index <name>',           '(Re)index docs/ contents'],
      ['kb on <name>',              'Activate a KB for AI use'],
      ['kb off <name>',             'Deactivate a KB'],
      ['kb delete <name>',          'Remove a KB and all its docs'],
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
    for (const [c, desc] of rows) {
      process.stdout.write(`    ${CYAN}sysai ${c.padEnd(22)}${RESET}  ${desc}\n`)
    }
    process.stdout.write('\n')
  }
}

async function install(): Promise<void> {
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
  // If running via bun from source, symlink main.ts
  const isBundled = !selfPath.endsWith('.js') && !selfPath.endsWith('.ts')

  if (isBundled) {
    // Compiled binary — copy ourselves to ~/.sysai/bin/sysai
    // Use process.execPath (real path on disk), not process.argv[1] which
    // resolves to /$bunfs/root/... inside Bun's virtual filesystem
    copyFileSync(process.execPath, binPath)
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
      // Symlink to source main.ts — requires bun at runtime
      try {
        execSync('bun --version', { stdio: 'ignore' })
      } catch {
        process.stderr.write(`${RED}  ✗${RESET} bun is required to run sysai from source but was not found.\n`)
        process.stderr.write(`    Install bun: ${CYAN}curl -fsSL https://bun.sh/install | bash${RESET}\n\n`)
        process.exit(1)
      }

      const mainTs = join(srcDir, 'main.ts')
      try { unlinkSync(binPath) } catch {}
      symlinkSync(mainTs, binPath)
      chmodSync(mainTs, 0o755)
      process.stdout.write(`${GREEN}  ✓${RESET} Linked ~/.sysai/bin/sysai → ${mainTs}\n`)

      // Install npm dependencies if needed
      const nmPath = join(srcDir, 'node_modules')
      if (!existsSync(nmPath)) {
        process.stdout.write(`${DIM}  Installing dependencies...${RESET}`)
        execSync('npm install --silent', { cwd: srcDir })
        process.stdout.write(`\r${GREEN}  ✓${RESET} Dependencies installed          \n`)
      }
    }
  }

  // 3. Verify the installed binary works
  try {
    execSync(`"${binPath}" --version`, { stdio: 'ignore' })
    process.stdout.write(`${GREEN}  ✓${RESET} Binary verified\n`)
  } catch {
    process.stderr.write(`${RED}  ✗${RESET} Installed binary failed to run. Your platform may not be supported.\n`)
    process.exit(1)
  }

  // 4. Write shell integration files
  const shell = (process.env.SHELL || 'bash').split('/').pop()
  const isFish = shell === 'fish'

  // Write shell.bash (used by bash/zsh)
  let bashContent: string
  try {
    bashContent = readFileSync(join(srcDir, 'shell.bash'), 'utf8')
  } catch {
    bashContent = [
      '# sysai shell integration — managed by sysai, do not edit manually',
      'SYSAI_BIN="$HOME/.sysai/bin/sysai"',
      '_sysai_ask () { "$SYSAI_BIN" ask "$@"; }',
      "alias '?'='_sysai_ask'",
    ].join('\n') + '\n'
  }
  writeFileSync(`${dir}/shell.bash`, bashContent, { mode: 0o644 })

  // Write shell.fish (used by fish)
  let fishContent: string
  try {
    fishContent = readFileSync(join(srcDir, 'shell.fish'), 'utf8')
  } catch {
    fishContent = [
      '# sysai shell integration — managed by sysai, do not edit manually',
      'set -gx SYSAI_BIN "$HOME/.sysai/bin/sysai"',
      'function _sysai_ask; $SYSAI_BIN ask $argv; end',
      "abbr -a '?' '_sysai_ask'",
    ].join('\n') + '\n'
  }
  writeFileSync(`${dir}/shell.fish`, fishContent, { mode: 0o644 })
  process.stdout.write(`${GREEN}  ✓${RESET} Wrote shell integration files\n`)

  // 5. Add sysai block to shell rc file (PATH + source)
  let rcFile: string
  if (shell === 'zsh') {
    rcFile = `${home}/.zshrc`
  } else if (isFish) {
    mkdirSync(`${home}/.config/fish`, { recursive: true })
    rcFile = `${home}/.config/fish/config.fish`
  } else if (process.platform === 'darwin') {
    // macOS Terminal.app opens login shells, which read .bash_profile not .bashrc
    rcFile = `${home}/.bash_profile`
  } else {
    rcFile = `${home}/.bashrc`
  }

  const BEGIN_MARKER = '# >>> sysai >>>'
  const END_MARKER   = '# <<< sysai <<<'

  const sysaiBlock = isFish
    ? [
        BEGIN_MARKER,
        'fish_add_path -g "$HOME/.sysai/bin"',
        'if test -f ~/.sysai/shell.fish; source ~/.sysai/shell.fish; end',
        END_MARKER,
      ].join('\n')
    : [
        BEGIN_MARKER,
        'export PATH="$HOME/.sysai/bin:$PATH"',
        '[ -f ~/.sysai/shell.bash ] && source ~/.sysai/shell.bash',
        END_MARKER,
      ].join('\n')

  let rcContent = ''
  try { rcContent = readFileSync(rcFile, 'utf8') } catch {}

  if (rcContent.includes(BEGIN_MARKER)) {
    // Replace existing sysai block
    const blockRe = new RegExp(`${BEGIN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    rcContent = rcContent.replace(blockRe, sysaiBlock)
    writeFileSync(rcFile, rcContent, 'utf8')
    process.stdout.write(`${GREEN}  ✓${RESET} Updated sysai block in ${rcFile}\n`)
  } else {
    // Remove legacy source line / inline block if present
    if (rcContent.includes('source ~/.sysai/shell.bash') || rcContent.includes('# sysai shell integration')) {
      rcContent = rcContent
        .replace(/# sysai shell integration[\s\S]*?# END_SYSAI\n?/g, '')
        .replace(/\[.*~\/.sysai\/shell\.bash.*\].*source.*~\/.sysai\/shell\.bash.*\n?/g, '')
    }
    writeFileSync(rcFile, rcContent.trimEnd() + '\n\n' + sysaiBlock + '\n', 'utf8')
    process.stdout.write(`${GREEN}  ✓${RESET} Added sysai block to ${rcFile}\n`)
  }

  // 6. Copy built-in tasks (skip if user already has one with the same name)
  const tasksDir  = `${dir}/tasks`
  const srcTasks  = join(srcDir, 'tasks')
  mkdirSync(tasksDir, { recursive: true })
  if (existsSync(srcTasks)) {
    const { readdirSync } = await import('fs')
    let copied = 0
    for (const f of readdirSync(srcTasks).filter((f: string) => f.endsWith('.md'))) {
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
  } else if (!process.stdin.isTTY) {
    // Non-interactive install (e.g. curl | bash) — skip setup wizard
    process.stdout.write(`  ${CYAN}sysai${RESET} installed! To configure your AI provider, run:\n\n`)
    process.stdout.write(`    source ${rcFile}\n`)
    process.stdout.write(`    sysai setup\n\n`)
  } else {
    try {
      process.stdout.write(`${DIM}  Now let's configure your AI provider:${RESET}\n\n`)
      const { setup } = await import('./src/commands/setup.js')
      await setup()
      process.stdout.write(`  Done! Run ${CYAN}source ${rcFile}${RESET} then ${CYAN}? hello${RESET}\n\n`)
    } catch (err) {
      process.stderr.write(`\n${RED}  ✗${RESET} Setup failed: ${err instanceof Error ? err.message : err}\n`)
      process.stderr.write(`    Installation is complete — run ${CYAN}sysai setup${RESET} to configure later.\n\n`)
    }
  }
}

async function setupShell(): Promise<void> {
  const { writeFileSync, readFileSync, mkdirSync } = await import('fs')
  const { homedir } = await import('os')
  const dir = `${homedir()}/.sysai`
  mkdirSync(dir, { recursive: true })

  // Copy shell.bash from the source directory next to this script
  const { dirname } = await import('path')
  const { fileURLToPath } = await import('url')
  let shellContent: string
  try {
    // Try bundled location first (same dir as main.ts)
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
