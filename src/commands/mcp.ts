/**
 * mcp.ts — MCP server management commands
 *
 * sysai mcp list            — show all configured MCP servers
 * sysai mcp add             — interactive wizard to add a server
 * sysai mcp remove <name>   — remove a server by name
 */

import { createInterface } from 'readline'
import { addMcpServer, removeMcpServer, listMcpServers } from '../storage/mcp.js'
import { RESET, BOLD, DIM, RED, GREEN, CYAN, YELLOW } from '../ui/colors.js'
import type { McpServerConfig } from '../types.js'

export async function listMcps(): Promise<void> {
  const servers = listMcpServers()

  if (servers.length === 0) {
    process.stdout.write(`\n  ${YELLOW}No MCP servers configured.${RESET}\n`)
    process.stdout.write(`  Add one with: ${CYAN}sysai mcp add${RESET}\n\n`)
    return
  }

  process.stdout.write('\n')
  const maxName = Math.max(...servers.map(s => s.name.length), 4)
  const maxCmd  = Math.max(...servers.map(s => s.command.length), 7)

  process.stdout.write(`  ${DIM}${'NAME'.padEnd(maxName)}  ${'COMMAND'.padEnd(maxCmd)}  ARGS${RESET}\n`)
  process.stdout.write(`  ${DIM}${'-'.repeat(maxName + maxCmd + 22)}${RESET}\n`)

  for (const s of servers) {
    const argsStr = s.args?.join(' ') ?? ''
    const envKeys = s.env ? `  ${DIM}[${Object.keys(s.env).map(k => `${k}=***`).join(' ')}]${RESET}` : ''
    const desc    = s.description ? `  ${DIM}# ${s.description}${RESET}` : ''
    process.stdout.write(
      `  ${BOLD}${s.name.padEnd(maxName)}${RESET}  ${s.command.padEnd(maxCmd)}  ${DIM}${argsStr}${RESET}${envKeys}${desc}\n`
    )
  }
  process.stdout.write('\n')
}

export async function addMcp(): Promise<void> {
  const rl  = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string) => new Promise<string>(resolve => rl.question(q, resolve))

  process.stdout.write(`\n  ${CYAN}Add MCP server${RESET}\n\n`)

  const name = (await ask('  Name: ')).trim()
  if (!name) { process.stdout.write(`${RED}  No name provided.${RESET}\n`); rl.close(); return }

  const command = (await ask('  Command (e.g. npx, python): ')).trim()
  if (!command) { process.stdout.write(`${RED}  No command provided.${RESET}\n`); rl.close(); return }

  const argsRaw = (await ask(`  Args ${DIM}(e.g. -y @example/weather-mcp, enter to skip)${RESET}: `)).trim()
  const args = argsRaw ? argsRaw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(a => a.replace(/^['"]|['"]$/g, '')) : undefined

  const envRaw = (await ask(`  Env vars ${DIM}(KEY=val KEY2=val2, enter to skip)${RESET}: `)).trim()
  let env: Record<string, string> | undefined
  if (envRaw) {
    env = {}
    for (const pair of envRaw.split(/\s+/)) {
      const eq = pair.indexOf('=')
      if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
  }

  const description = (await ask(`  Description ${DIM}(optional, shown in list)${RESET}: `)).trim() || undefined

  rl.close()

  const cfg: McpServerConfig = {
    command,
    ...(args       && { args }),
    ...(env        && { env }),
    ...(description && { description }),
  }

  addMcpServer(name, cfg)
  process.stdout.write(`\n${GREEN}  ✓ Added MCP server "${name}"${RESET}\n\n`)
  process.stdout.write(`  ${DIM}Run: sysai mcp list${RESET}\n\n`)
}

export function removeMcp(name?: string): void {
  if (!name) {
    process.stderr.write(`${RED}sysai: specify a name to remove. Run: sysai mcp list${RESET}\n`)
    process.exit(1)
  }

  const removed = removeMcpServer(name)
  if (!removed) {
    process.stderr.write(`${RED}sysai: MCP "${name}" not found. Run: sysai mcp list${RESET}\n`)
    process.exit(1)
  }

  process.stdout.write(`${GREEN}  ✓ Removed MCP "${name}"${RESET}\n`)
}
