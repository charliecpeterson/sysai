/**
 * kb.ts — knowledge base management commands
 *
 * sysai kb add <name> --desc "..."   create a KB (active by default)
 * sysai kb list                      show all KBs with status/size
 * sysai kb index <name>              (re)index docs/ contents
 * sysai kb on <name>                 activate a KB
 * sysai kb off <name>                deactivate a KB
 * sysai kb delete <name>             remove entirely
 */

import { createInterface } from 'readline'
import { createKb, deleteKb, setKbActive, listKbs, indexKb } from '../storage/kb.js'
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

    process.stdout.write(`\n  ${CYAN}Create knowledge base${RESET}\n\n`)
    name = (await ask('  Name: ')).trim()
    if (!name) { process.stdout.write(`${RED}  No name provided.${RESET}\n`); rl.close(); return }
    if (!description) {
      description = (await ask('  Description (what is this KB about?): ')).trim()
    }
    rl.close()
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

export function listKb(): void {
  const kbs = listKbs()

  if (kbs.length === 0) {
    process.stdout.write(`\n  ${YELLOW}No knowledge bases configured.${RESET}\n`)
    process.stdout.write(`  Create one with: ${CYAN}sysai kb add <name> --desc "..."${RESET}\n\n`)
    return
  }

  process.stdout.write('\n')
  const maxName = Math.max(...kbs.map(k => k.name.length), 4)

  process.stdout.write(`  ${DIM}${'NAME'.padEnd(maxName)}  DOCS  TOKENS    STATUS${RESET}\n`)
  process.stdout.write(`  ${DIM}${'-'.repeat(maxName + 35)}${RESET}\n`)

  for (const k of kbs) {
    const status = k.active ? `${GREEN}● active${RESET}` : `${DIM}○ inactive${RESET}`
    const docs   = String(k.docCount).padStart(4)
    const tokens = k.tokenEstimate > 0 ? formatTokens(k.tokenEstimate).padStart(8) : `${DIM}     n/a${RESET}`
    const indexed = k.lastIndexed ? '' : `  ${YELLOW}(not indexed)${RESET}`
    process.stdout.write(`  ${BOLD}${k.name.padEnd(maxName)}${RESET}  ${docs}  ${tokens}  ${status}${indexed}\n`)
  }
  process.stdout.write('\n')
}

export function indexKbCmd(name?: string): void {
  if (!name) {
    process.stderr.write(`${RED}sysai: specify a KB name to index. Run: sysai kb list${RESET}\n`)
    process.exit(1)
  }

  process.stdout.write(`${DIM}  indexing "${name}"...${RESET}`)

  try {
    const { docCount, tokenEstimate } = indexKb(name)
    process.stdout.write(`\r${GREEN}  ✓ Indexed "${name}": ${docCount} file${docCount === 1 ? '' : 's'}, ~${formatTokens(tokenEstimate)} tokens${RESET}\n`)
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
