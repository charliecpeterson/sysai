/**
 * mcp.ts — MCP server management commands
 *
 * sysai mcp list            — show all configured MCP servers
 * sysai mcp add             — interactive wizard to add a server
 * sysai mcp edit <name>     — edit a server's config in place
 * sysai mcp remove <name>   — remove a server by name
 * sysai mcp test [name]     — connect and list tools (all servers if no name given)
 */

import { createInterface } from 'readline'
import { addMcpServer, removeMcpServer, listMcpServers, loadMcpConfig, saveMcpConfig } from '../storage/mcp.js'
import { McpClientManager } from '../core/mcp-client.js'
import { RESET, BOLD, DIM, RED, GREEN, CYAN, YELLOW } from '../ui/colors.js'
import type { McpServerConfig } from '../types.js'

/**
 * Parse a shell-style argument string into an array of tokens.
 * Handles single and double quotes, and escaped characters within quotes.
 * e.g. '-y @some/pkg --key "val with spaces"' → ['-y', '@some/pkg', '--key', 'val with spaces']
 */
function parseShellArgs(raw: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let i = 0

  while (i < raw.length) {
    const ch = raw[i]
    if (inSingle) {
      if (ch === "'") { inSingle = false }
      else { current += ch }
    } else if (inDouble) {
      if (ch === '\\' && i + 1 < raw.length) { current += raw[++i] }
      else if (ch === '"') { inDouble = false }
      else { current += ch }
    } else {
      if (ch === "'") { inSingle = true }
      else if (ch === '"') { inDouble = true }
      else if (ch === '\\' && i + 1 < raw.length) { current += raw[++i] }
      else if (/\s/.test(ch)) {
        if (current) { tokens.push(current); current = '' }
      } else {
        current += ch
      }
    }
    i++
  }
  if (current) tokens.push(current)
  return tokens
}

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
  const args = argsRaw ? parseShellArgs(argsRaw) : undefined

  const envRaw = (await ask(`  Env vars ${DIM}(KEY=val KEY2=val2, enter to skip)${RESET}: `)).trim()
  let env: Record<string, string> | undefined
  if (envRaw) {
    env = {}
    for (const pair of envRaw.split(/\s+/)) {
      const eq = pair.indexOf('=')
      if (eq > 0) {
        const val = pair.slice(eq + 1).replace(/^(['"])(.*)\1$/, '$2')  // strip surrounding quotes
        env[pair.slice(0, eq)] = val
      }
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

export async function testMcp(name?: string): Promise<void> {
  const config = loadMcpConfig()
  const servers = name
    ? (config.servers[name] ? { [name]: config.servers[name] } : null)
    : config.servers

  if (!servers) {
    process.stderr.write(`${RED}sysai: MCP "${name}" not found. Run: sysai mcp list${RESET}\n`)
    process.exit(1)
  }

  const names = Object.keys(servers)
  if (names.length === 0) {
    process.stdout.write(`\n  ${YELLOW}No MCP servers configured.${RESET}\n`)
    process.stdout.write(`  Add one with: ${CYAN}sysai mcp add${RESET}\n\n`)
    return
  }

  process.stdout.write(`\n  ${DIM}connecting…${RESET}\n\n`)

  const manager = new McpClientManager()
  await manager.connectAll(servers)

  const connected = new Set(manager.summary().map(s => s.serverName))

  for (const serverName of names) {
    if (!connected.has(serverName)) {
      process.stdout.write(`  ${RED}●${RESET}  ${BOLD}${serverName}${RESET}  ${RED}failed to connect${RESET}\n`)
      continue
    }
    const group = manager.toolsByServer().find(g => g.serverName === serverName)!
    process.stdout.write(`  ${GREEN}●${RESET}  ${BOLD}${serverName}${RESET}  ${DIM}${group.tools.length} tool${group.tools.length === 1 ? '' : 's'}${RESET}\n`)
    for (const t of group.tools) {
      const desc = t.description ? `  ${DIM}${t.description}${RESET}` : ''
      process.stdout.write(`       ${CYAN}${t.name}${RESET}${desc}\n`)
    }
  }

  manager.closeAll()
  process.stdout.write('\n')
}

export async function editMcp(name?: string): Promise<void> {
  if (!name) {
    process.stderr.write(`${RED}sysai: specify a name to edit. Run: sysai mcp list${RESET}\n`)
    process.exit(1)
  }

  const config = loadMcpConfig()
  const existing = config.servers[name]
  if (!existing) {
    process.stderr.write(`${RED}sysai: MCP "${name}" not found. Run: sysai mcp list${RESET}\n`)
    process.exit(1)
  }

  const rl  = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string) => new Promise<string>(resolve => rl.question(q, resolve))

  process.stdout.write(`\n  ${CYAN}Edit MCP server "${name}"${RESET}  ${DIM}(Enter to keep current value)${RESET}\n\n`)

  const commandRaw = (await ask(`  Command ${DIM}[${existing.command}]${RESET}: `)).trim()
  const command    = commandRaw || existing.command

  const currentArgs = existing.args?.join(' ') ?? ''
  const argsRaw     = (await ask(`  Args ${DIM}[${currentArgs || 'none'}]${RESET}: `)).trim()
  const args        = argsRaw
    ? parseShellArgs(argsRaw)
    : (argsRaw === '' && currentArgs ? existing.args : undefined)

  const currentEnv = existing.env
    ? Object.entries(existing.env).map(([k, v]) => `${k}=${v}`).join(' ')
    : ''
  const envRaw = (await ask(`  Env vars ${DIM}[${currentEnv || 'none'}]${RESET}: `)).trim()
  let env: Record<string, string> | undefined = existing.env
  if (envRaw) {
    env = {}
    for (const pair of envRaw.split(/\s+/)) {
      const eq = pair.indexOf('=')
      if (eq > 0) {
        const val = pair.slice(eq + 1).replace(/^(['"])(.*)\1$/, '$2')
        env[pair.slice(0, eq)] = val
      }
    }
  }

  const currentDesc = existing.description ?? ''
  const descRaw     = (await ask(`  Description ${DIM}[${currentDesc || 'none'}]${RESET}: `)).trim()
  const description = descRaw || existing.description

  rl.close()

  config.servers[name] = {
    command,
    ...(args        && { args }),
    ...(env         && { env }),
    ...(description && { description }),
  }
  saveMcpConfig(config)

  process.stdout.write(`\n${GREEN}  ✓ Updated MCP server "${name}"${RESET}\n\n`)
  process.stdout.write(`  ${DIM}Run: sysai mcp test ${name}${RESET}\n\n`)
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
