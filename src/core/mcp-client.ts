/**
 * mcp-client.ts — minimal MCP stdio client
 *
 * Implements just enough of the Model Context Protocol (JSON-RPC 2.0 over stdio)
 * to connect to MCP servers, discover their tools, and call them.
 * No external dependencies — uses only Node built-ins + jsonSchema from ai.
 */

import { spawn }     from 'child_process'
import { jsonSchema, tool } from 'ai'
import type { JSONSchema7 } from '@ai-sdk/provider'
import type { McpServerConfig } from '../types.js'

const REQUEST_TIMEOUT_MS = 30_000

// ── JSON-RPC types ────────────────────────────────────────────────────────────

interface RpcRequest   { jsonrpc: '2.0'; id: number; method: string; params?: unknown }
interface RpcNotify    { jsonrpc: '2.0'; method: string; params?: unknown }
interface RpcResponse  { jsonrpc: '2.0'; id: number; result?: unknown; error?: { code: number; message: string } }

// ── Tool shape returned by MCP servers ───────────────────────────────────────

interface McpToolDef {
  name:        string
  description: string
  inputSchema: Record<string, unknown>
}

// ── Single server connection ──────────────────────────────────────────────────

class McpServerConnection {
  private nextId  = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private buffer  = ''
  private closed  = false

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private proc: any

  constructor(private readonly config: McpServerConfig) {
    const env = { ...process.env, ...(config.env ?? {}) }
    this.proc = spawn(config.command, config.args ?? [], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.proc.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString()
      const lines = this.buffer.split('\n')
      this.buffer  = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const msg = JSON.parse(trimmed) as RpcResponse
          if (msg.id != null) {
            const h = this.pending.get(msg.id)
            if (h) {
              this.pending.delete(msg.id)
              msg.error ? h.reject(new Error(msg.error.message)) : h.resolve(msg.result)
            }
          }
        } catch { /* ignore non-JSON lines */ }
      }
    })

    this.proc.on('error',  () => {})
    this.proc.on('close',  () => { this.closed = true; this.rejectAll('MCP server closed') })
    this.proc.stderr?.on('data', () => {}) // discard server stderr
  }

  private rejectAll(reason: string): void {
    for (const h of this.pending.values()) h.reject(new Error(reason))
    this.pending.clear()
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('MCP server is closed'))
    const id  = this.nextId++
    const req: RpcRequest = { jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => { this.pending.delete(id); reject(new Error(`MCP request "${method}" timed out`)) },
        REQUEST_TIMEOUT_MS,
      )
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject:  (e) => { clearTimeout(timer); reject(e) },
      })
      this.proc.stdin.write(JSON.stringify(req) + '\n')
    })
  }

  private notify(method: string, params?: unknown): void {
    if (this.closed) return
    const msg: RpcNotify = { jsonrpc: '2.0', method, ...(params !== undefined && { params }) }
    this.proc.stdin.write(JSON.stringify(msg) + '\n')
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities:    { tools: {} },
      clientInfo:      { name: 'sysai', version: '0.1.0' },
    })
    this.notify('notifications/initialized')
  }

  async listTools(): Promise<McpToolDef[]> {
    const res = await this.request('tools/list', {}) as { tools?: McpToolDef[] }
    return res.tools ?? []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.request('tools/call', { name, arguments: args }) as {
      content?: Array<{ type: string; text?: string }>
      isError?: boolean
    }
    const text = (res.content ?? [])
      .filter(c => c.type === 'text')
      .map(c => c.text ?? '')
      .join('\n') || '(no output)'
    return res.isError ? `Error: ${text}` : text
  }

  close(): void {
    if (this.closed) return
    try { this.proc.stdin.end() } catch {}
    try { this.proc.kill() }      catch {}
  }
}

// ── Manager ──────────────────────────────────────────────────────────────────

export class McpClientManager {
  private conns = new Map<string, { conn: McpServerConnection; tools: McpToolDef[] }>()

  async connectAll(servers: Record<string, McpServerConfig>): Promise<void> {
    await Promise.all(
      Object.entries(servers).map(async ([name, cfg]) => {
        try {
          const conn = new McpServerConnection(cfg)
          await conn.initialize()
          const tools = await conn.listTools()
          this.conns.set(name, { conn, tools })
        } catch (err) {
          // Non-fatal: skip servers that fail to start
          process.stderr.write(`sysai: MCP "${name}" failed to connect: ${(err as Error).message}\n`)
        }
      })
    )
  }

  /** Returns the MCP tools in AI SDK tool() format, keyed by mcp__<server>__<tool>. */
  getAiSdkTools(): Record<string, ReturnType<typeof tool>> {
    const out: Record<string, ReturnType<typeof tool>> = {}
    for (const [serverName, { tools }] of this.conns) {
      for (const t of tools) {
        const key = mcpToolKey(serverName, t.name)
        out[key] = tool({
          description: t.description || t.name,
          inputSchema: jsonSchema(t.inputSchema as JSONSchema7),
        })
      }
    }
    return out
  }

  async callTool(toolKey: string, args: Record<string, unknown>): Promise<string> {
    const parsed = parseMcpToolKey(toolKey)
    if (!parsed) return `Error: invalid MCP tool key "${toolKey}"`
    const entry = this.conns.get(parsed.serverName)
    if (!entry)  return `Error: MCP server "${parsed.serverName}" is not connected`
    return entry.conn.callTool(parsed.toolName, args)
  }

  /** Summary of connected servers for display purposes. */
  summary(): Array<{ serverName: string; toolCount: number }> {
    return [...this.conns.entries()].map(([serverName, { tools }]) => ({
      serverName,
      toolCount: tools.length,
    }))
  }

  closeAll(): void {
    for (const { conn } of this.conns.values()) conn.close()
    this.conns.clear()
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _manager: McpClientManager | null = null

/**
 * Returns the shared MCP manager, connecting to all configured servers on first call.
 * Returns null (silently) if no servers are configured.
 */
export async function getMcpManager(): Promise<McpClientManager | null> {
  if (_manager) return _manager

  const { loadMcpConfig } = await import('../storage/mcp.js')
  const config = loadMcpConfig()
  const servers = config.servers ?? {}
  if (Object.keys(servers).length === 0) return null

  const manager = new McpClientManager()
  await manager.connectAll(servers)
  process.once('exit', () => manager.closeAll())

  _manager = manager
  return _manager
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function isMcpTool(toolName: string): boolean {
  return toolName.startsWith(MCP_PREFIX)
}

const MCP_PREFIX = 'mcp__'
const SEP        = '__'

function mcpToolKey(serverName: string, toolName: string): string {
  return `${MCP_PREFIX}${sanitize(serverName)}${SEP}${sanitize(toolName)}`
}

function parseMcpToolKey(key: string): { serverName: string; toolName: string } | null {
  if (!key.startsWith(MCP_PREFIX)) return null
  const rest  = key.slice(MCP_PREFIX.length)
  const idx   = rest.indexOf(SEP)
  if (idx < 0) return null
  return { serverName: rest.slice(0, idx), toolName: rest.slice(idx + SEP.length) }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_')
}
