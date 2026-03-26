import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { McpConfig, McpServerConfig } from '../types.js'

const MCP_CONFIG_PATH = join(homedir(), '.sysai', 'mcp.json')

export function loadMcpConfig(): McpConfig {
  try {
    if (existsSync(MCP_CONFIG_PATH)) {
      return JSON.parse(readFileSync(MCP_CONFIG_PATH, 'utf8')) as McpConfig
    }
  } catch {}
  return { servers: {} }
}

export function saveMcpConfig(config: McpConfig): void {
  mkdirSync(join(homedir(), '.sysai'), { recursive: true })
  writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8')
}

export function addMcpServer(name: string, server: McpServerConfig): void {
  const config = loadMcpConfig()
  config.servers[name] = server
  saveMcpConfig(config)
}

export function removeMcpServer(name: string): boolean {
  const config = loadMcpConfig()
  if (!config.servers[name]) return false
  delete config.servers[name]
  saveMcpConfig(config)
  return true
}

export function listMcpServers(): Array<{ name: string } & McpServerConfig> {
  const config = loadMcpConfig()
  return Object.entries(config.servers).map(([name, server]) => ({ name, ...server }))
}
