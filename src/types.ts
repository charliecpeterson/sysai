import type { ModelMessage } from 'ai'
export type { ModelMessage }

// ── Model configuration ───────────────────────────────────────────────────────

export type Provider = 'anthropic' | 'openai' | 'llamacpp' | 'openai-compatible'

export interface ModelConfig {
  name: string
  provider: Provider
  model?: string
  apiKey?: string
  baseUrl?: string
}

export interface ModelsData {
  active: string | null
  models: ModelConfig[]
}

// ── Session / History ─────────────────────────────────────────────────────────

export interface SessionMeta {
  ts: string
  hostname: string
  title: string | null
  turns: number
}

export interface Session {
  file: string
  meta: SessionMeta
}

export interface SessionSummary {
  file: string
  ts: string
  hostname: string
  title: string | null
  turns: number
}

// ── Environment context ───────────────────────────────────────────────────────

export interface SSHInfo {
  active: boolean
  client?: string
}

export interface SlurmInfo {
  active: boolean
  job_id?: string
  job_name?: string | null
  nodelist?: string | null
  partition?: string | null
  ntasks?: string | null
  cpus?: string | null
}

export interface ContainerInfo {
  active: boolean
  type?: string
  image?: string
}

export interface Context {
  hostname: string
  user: string
  shell: string
  os: string
  distro: string | null
  ssh: SSHInfo
  slurm: SlurmInfo
  container: ContainerInfo
  sudo: string | null
  cwd: string
  terminal_buffer: string | null
  stdin_pipe: string | null
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

export interface Task {
  name: string
  description: string
  model: string | null
  auto_run: string[]
  prompt: string
}

// ── Agent ─────────────────────────────────────────────────────────────────────

/** 'approved' | 'rejected' | an edited command string */
export type ToolDecision = string

export interface AgentResult {
  text: string
  messages: ModelMessage[]
}

export interface AgentOptions {
  systemPrompt: string
  messages: ModelMessage[]
  onToken: (token: string) => void
  onToolApproval: (toolCall: unknown) => Promise<ToolDecision>
  onToolResult?: (toolCall: unknown, result: string, elapsedMs: number) => void
  onThinking?: () => void
  onThinkingDone?: () => void
  abortSignal?: AbortSignal
}

// ── MCP ───────────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  description?: string
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>
}

// ── UI ────────────────────────────────────────────────────────────────────────

export interface ApprovalOptions {
  autoApprove?: boolean
  writeFn?: (s: string) => void
  autoApproveWrite?: boolean
}

export interface RunAgentWithUIOptions {
  systemPrompt: string
  messages: ModelMessage[]
  autoApprove?: boolean
  abortSignal?: AbortSignal
  rl: import('readline').Interface
  contentStream?: NodeJS.WriteStream
  uiStream?: NodeJS.WriteStream
}
