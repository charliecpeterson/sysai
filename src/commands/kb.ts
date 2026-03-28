/**
 * kb.ts — knowledge base management commands
 *
 * sysai kb add <name> --desc "..."   create a KB (active by default)
 * sysai kb add-file <name> <path>    copy file/dir into KB and re-index
 * sysai kb list                      show all KBs with status/size
 * sysai kb index <name>              (re)index docs/ contents
 * sysai kb on <name>                 activate a KB
 * sysai kb off <name>                deactivate a KB
 * sysai kb delete <name>             remove entirely
 */

import { createInterface } from 'readline'
import { existsSync, statSync, mkdirSync, copyFileSync, readdirSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { createKb, deleteKb, setKbActive, listKbs, indexKb, loadKbConfig, isKbStale } from '../storage/kb.js'
import { listEmbeddings } from '../storage/models.js'
import { RESET, BOLD, DIM, RED, GREEN, CYAN, YELLOW } from '../ui/colors.js'

export async function addKb(args: string[]): Promise<void> {
  let name = args[0]
  let description = ''

  // Parse --desc flag
  const descIdx = args.indexOf('--desc')
  if (descIdx >= 0 && args[descIdx + 1]) {
    description = args[descIdx + 1]
    if (!name || name === '--desc') name = ''
  }

  if (!name) {
    const rl  = createInterface({ input: process.stdin, output: process.stdout })
    const ask = (q: string) => new Promise<string>(resolve => rl.question(q, resolve))
    try {
      process.stdout.write(`\n  ${CYAN}Create knowledge base${RESET}\n\n`)
      name = (await ask('  Name: ')).trim()
      if (!name) { process.stdout.write(`${RED}  No name provided.${RESET}\n`); return }
      if (!description) {
        description = (await ask('  Description (what is this KB about?): ')).trim()
      }
    } finally {
      rl.close()
    }
  }

  if (!description) {
    description = name
  }

  try {
    createKb(name, description)
  } catch (err) {
    process.stderr.write(`${RED}sysai: ${(err as Error).message}${RESET}\n`)
    process.exit(1)
  }

  const docsDir = `~/.sysai/kb/${name}/docs/`
  process.stdout.write(`\n${GREEN}  ✓ Created KB "${name}" (active)${RESET}\n\n`)
  process.stdout.write(`  Drop files in ${CYAN}${docsDir}${RESET}\n`)
  process.stdout.write(`  Then run: ${CYAN}sysai kb index ${name}${RESET}\n\n`)
}

export async function addFileCmd(kbName?: string, srcPath?: string): Promise<void> {
  if (!kbName) {
    process.stderr.write(`${RED}sysai: specify a KB name. Run: sysai kb list${RESET}\n`)
    process.exit(1)
  }
  if (!srcPath) {
    process.stderr.write(`${RED}sysai: specify a file or directory path${RESET}\n`)
    process.exit(1)
  }

  // Resolve ~ in path
  const resolved = srcPath.startsWith('~/')
    ? join(homedir(), srcPath.slice(2))
    : srcPath

  if (!existsSync(resolved)) {
    process.stderr.write(`${RED}sysai: path not found: ${srcPath}${RESET}\n`)
    process.exit(1)
  }

  // Verify KB exists
  const config = loadKbConfig()
  if (!config.kbs[kbName]) {
    process.stderr.write(`${RED}sysai: KB "${kbName}" not found. Run: sysai kb list${RESET}\n`)
    process.exit(1)
  }

  const docsDir = join(homedir(), '.sysai', 'kb', kbName, 'docs')
  mkdirSync(docsDir, { recursive: true })

  const stat = statSync(resolved)
  let copied = 0

  if (stat.isDirectory()) {
    copied = copyDir(resolved, join(docsDir, basename(resolved)))
    process.stdout.write(`${GREEN}  ✓ Copied directory "${basename(resolved)}" (${copied} file${copied === 1 ? '' : 's'}) into ${kbName}${RESET}\n`)
  } else {
    const dest = join(docsDir, basename(resolved))
    copyFileSync(resolved, dest)
    copied = 1
    process.stdout.write(`${GREEN}  ✓ Copied "${basename(resolved)}" into ${kbName}${RESET}\n`)
  }

  // Auto-index
  await indexKbCmd(kbName)
}

function copyDir(src: string, dest: string): number {
  mkdirSync(dest, { recursive: true })
  let count = 0
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const srcFull  = join(src, entry.name)
    const destFull = join(dest, entry.name)
    if (entry.isDirectory()) {
      count += copyDir(srcFull, destFull)
    } else {
      copyFileSync(srcFull, destFull)
      count++
    }
  }
  return count
}

export async function listKb(): Promise<void> {
  const kbs = listKbs()

  if (kbs.length === 0) {
    process.stdout.write(`\n  ${YELLOW}No knowledge bases configured.${RESET}\n`)
    process.stdout.write(`  Create one with: ${CYAN}sysai kb add <name> --desc "..."${RESET}\n\n`)
    return
  }

  process.stdout.write('\n')
  const maxName = Math.max(...kbs.map(k => k.name.length), 4)

  process.stdout.write(`  ${DIM}${'NAME'.padEnd(maxName)}  DOCS  TOKENS    STATUS         EMBEDDING${RESET}\n`)
  process.stdout.write(`  ${DIM}${'-'.repeat(maxName + 55)}${RESET}\n`)

  const { getEmbeddingConfig } = await import('../storage/models.js')

  for (const k of kbs) {
    const status  = k.active ? `${GREEN}● active${RESET}  ` : `${DIM}○ inactive${RESET}`
    const docs    = String(k.docCount).padStart(4)
    const tokens  = k.tokenEstimate > 0 ? formatTokens(k.tokenEstimate).padStart(8) : `${DIM}     n/a${RESET}`
    const stale   = k.lastIndexed && isKbStale(k.name)
    const indexed = !k.lastIndexed ? `  ${YELLOW}(not indexed)${RESET}` : stale ? `  ${YELLOW}(stale — re-index)${RESET}` : ''

    let embNote = `${DIM}none${RESET}`
    if (k.embeddingModel) {
      const cfg = getEmbeddingConfig(k.embeddingModel)
      embNote = cfg
        ? `${GREEN}${k.embeddingModel}${RESET}`
        : `${YELLOW}${k.embeddingModel} (config removed — re-index)${RESET}`
    }

    process.stdout.write(`  ${BOLD}${k.name.padEnd(maxName)}${RESET}  ${docs}  ${tokens}  ${status}  ${embNote}${indexed}\n`)
  }
  process.stdout.write('\n')
}

export async function indexKbCmd(name?: string): Promise<void> {
  if (!name) {
    process.stderr.write(`${RED}sysai: specify a KB name to index. Run: sysai kb list${RESET}\n`)
    process.exit(1)
  }

  // Prompt for embedding choice if embeddings are configured
  const embeddings = listEmbeddings()
  let embeddingName: string | null = null

  if (embeddings.length > 0) {
    const rl  = createInterface({ input: process.stdin, output: process.stdout })
    const ask = (q: string) => new Promise<string>(resolve => rl.question(q, resolve))

    process.stdout.write(`\n  Embedding models available:\n`)
    embeddings.forEach((e, i) =>
      process.stdout.write(`    ${i + 1}) ${BOLD}${e.name}${RESET}  ${DIM}${e.provider}  ${e.model}${RESET}\n`)
    )
    process.stdout.write(`    0) None ${DIM}(BM25 only — no API calls)${RESET}\n\n`)

    let choice: string
    try {
      choice = (await ask(`  Choose embedding [1]: `)).trim()
    } finally {
      rl.close()
    }
    process.stdout.write('\n')

    if (choice === '0') {
      embeddingName = null
    } else {
      const idx = choice === '' ? 0 : parseInt(choice) - 1
      embeddingName = embeddings[idx]?.name ?? null
    }
  }

  process.stdout.write(`${DIM}  indexing "${name}"...${RESET}`)

  try {
    const { docCount, tokenEstimate, embeddingModel } = await indexKb(name, {
      embeddingName,
      onProgress: (msg) => {
        process.stdout.write(`\r${DIM}  ${msg}${RESET}                    `)
      },
    })
    const embNote = embeddingModel ? `  ${DIM}embeddings: ${embeddingModel}${RESET}` : ''
    process.stdout.write(`\r${GREEN}  ✓ Indexed "${name}": ${docCount} file${docCount === 1 ? '' : 's'}, ~${formatTokens(tokenEstimate)} tokens${RESET}${embNote}\n`)
  } catch (err) {
    process.stdout.write('\n')
    process.stderr.write(`${RED}sysai: ${(err as Error).message}${RESET}\n`)
    process.exit(1)
  }
}

export function activateKb(name?: string): void {
  if (!name) {
    process.stderr.write(`${RED}sysai: specify a KB name. Run: sysai kb list${RESET}\n`)
    process.exit(1)
  }
  try {
    setKbActive(name, true)
    process.stdout.write(`${GREEN}  ✓ KB "${name}" activated${RESET}\n`)
  } catch (err) {
    process.stderr.write(`${RED}sysai: ${(err as Error).message}${RESET}\n`)
    process.exit(1)
  }
}

export function deactivateKb(name?: string): void {
  if (!name) {
    process.stderr.write(`${RED}sysai: specify a KB name. Run: sysai kb list${RESET}\n`)
    process.exit(1)
  }
  try {
    setKbActive(name, false)
    process.stdout.write(`${GREEN}  ✓ KB "${name}" deactivated${RESET}\n`)
  } catch (err) {
    process.stderr.write(`${RED}sysai: ${(err as Error).message}${RESET}\n`)
    process.exit(1)
  }
}

export async function deleteKbCmd(name?: string): Promise<void> {
  if (!name) {
    process.stderr.write(`${RED}sysai: specify a KB name to delete. Run: sysai kb list${RESET}\n`)
    process.exit(1)
  }

  const rl  = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise<string>(resolve =>
    rl.question(`  ${YELLOW}Delete KB "${name}" and all its docs? [y/N]: ${RESET}`, resolve)
  )
  rl.close()

  if (answer.trim().toLowerCase() !== 'y') {
    process.stdout.write(`${DIM}  cancelled${RESET}\n`)
    return
  }

  const removed = deleteKb(name)
  if (!removed) {
    process.stderr.write(`${RED}sysai: KB "${name}" not found${RESET}\n`)
    process.exit(1)
  }

  process.stdout.write(`${GREEN}  ✓ Deleted KB "${name}"${RESET}\n`)
}

// ── helpers ──────────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
