/**
 * agent.ts — agentic loop using Vercel AI SDK
 *
 * Tools: bash, read_file, write_file
 * Works with any provider (Anthropic, OpenAI, llama.cpp) via provider.ts
 */

import { streamText, tool } from 'ai'
import type { ModelMessage } from 'ai'
import { z }                 from 'zod'
import { spawn }             from 'child_process'
import { readFileSync, writeFileSync, statSync } from 'fs'
import { getModel }          from './provider.js'
import { isMcpTool }         from './mcp-client.js'
import { DIM, YELLOW, RESET } from '../ui/colors.js'
import type { AgentOptions, AgentResult } from '../types.js'

const MAX_ITERATIONS   = parseInt(process.env.SYSAI_MAX_TURNS || '20')
const MAX_FILE_READ    = 20_000  // chars
const BASH_TIMEOUT_MS  = parseInt(process.env.SYSAI_BASH_TIMEOUT || '120') * 1000
const MAX_RETRIES      = 3
const RETRY_BASE_MS    = 1_000

const TOOLS = {
  bash: tool({
    description: `Run a shell command in the user's environment.
Use for anything: checking system state, reading logs, installing packages,
editing configs, running scripts. Output is shown to the user and returned to you.
The shell inherits the full environment (PATH, SSH context, env vars, etc.).`,
    inputSchema: z.object({
      command: z.string().describe('Shell command to run'),
    }),
  }),

  read_file: tool({
    description: `Read a file. Every response includes total line count so you can plan follow-up reads.
For large files, use offset + limit to read in chunks — start with the first chunk to understand structure,
then request specific sections based on what you find. Never assume truncated output contains everything relevant.`,
    inputSchema: z.object({
      path:   z.string().describe('Absolute or relative file path'),
      offset: z.number().optional().describe('Start line, 1-indexed (default: 1)'),
      limit:  z.number().optional().describe('Number of lines to read (default: all)'),
    }),
  }),

  write_file: tool({
    description: 'Write content to a file, creating or overwriting it.',
    inputSchema: z.object({
      path:    z.string().describe('File path to write'),
      content: z.string().describe('Content to write'),
    }),
  }),
}

/**
 * Run the agentic loop until the model stops with 'stop' or 'end_turn'.
 */
export async function runAgent({
  systemPrompt, messages, onToken, onToolApproval, onToolResult,
  onThinking, onThinkingDone, abortSignal, mcpManager,
}: AgentOptions): Promise<AgentResult> {
  const model   = getModel()
  const history = [...messages] as ModelMessage[]
  let fullText  = ''
  let iterations = 0

  // Merge built-in tools with any MCP tools for this session
  const allTools = {
    ...TOOLS,
    ...(mcpManager ? mcpManager.getAiSdkTools() as typeof TOOLS : {}),
  }

  while (iterations++ < MAX_ITERATIONS) {
    onThinking?.()
    let thinkingDone = false

    // Retry the API call on transient errors, but only before any tokens have
    // been emitted — mid-stream errors are rethrown to avoid duplicating output.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result!: ReturnType<typeof streamText<any, any>>
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1))
      result = streamText({
        model,
        system:    systemPrompt,
        messages:  history,
        tools:     allTools,
        maxOutputTokens: parseInt(process.env.SYSAI_MAX_TOKENS || '8192'),
        ...(abortSignal && { abortSignal }),
      })
      try {
        for await (const textChunk of result.textStream) {
          if (!textChunk) continue
          if (!thinkingDone) { thinkingDone = true; onThinkingDone?.() }
          fullText += textChunk
          onToken(textChunk)
        }
        break  // stream completed successfully
      } catch (err) {
        if (!thinkingDone && isRetryable(err) && attempt < MAX_RETRIES) continue
        if (!thinkingDone) onThinkingDone?.()
        throw err
      }
    }

    if (!thinkingDone) { thinkingDone = true; onThinkingDone?.() }

    const [finishReason, toolCalls, response] = await Promise.all([
      result.finishReason,
      result.toolCalls,
      result.response,
    ])

    // Strip SDK-internal extra fields (providerMetadata, title, etc.) that
    // Zod 4 strict mode rejects when messages are re-validated on the next turn.
    const normalized = response.messages.map(msg => {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) {
        return { role: msg.role, content: msg.content }
      }
      return {
        role: 'assistant',
        content: msg.content.map(part => {
          if (part.type === 'tool-call') {
            return {
              type: 'tool-call',
              toolCallId: part.toolCallId,
              toolName:   part.toolName,
              input:      part.input ?? (part as unknown as Record<string, unknown>)['args'],
            }
          }
          if (part.type === 'text') return { type: 'text', text: part.text }
          return part
        }),
      }
    })
    history.push(...(normalized as ModelMessage[]))

    if (finishReason === 'stop' || toolCalls.length === 0) {
      return { text: fullText, messages: history }
    }

    if (iterations >= MAX_ITERATIONS) {
      onToken(`\n${YELLOW}[sysai: max iterations reached]${RESET}\n`)
      return { text: fullText, messages: history }
    }

    const toolResultParts: unknown[] = []

    for (const call of toolCalls) {
      const decision = await onToolApproval(call)
      let resultContent: string

      if (decision === 'rejected') {
        resultContent = 'User rejected this tool call.'
      } else {
        const finalCall = (decision === 'approved' || call.toolName !== 'bash')
          ? call
          : { ...call, input: { command: decision } }

        const t0 = Date.now()
        resultContent = isMcpTool(call.toolName) && mcpManager
          ? await mcpManager.callTool(call.toolName, parseToolArgs(finalCall.input ?? (finalCall as unknown as Record<string,unknown>).args))
          : await executeTool(finalCall as typeof call)
        onToolResult?.(finalCall, resultContent, Date.now() - t0)
      }

      toolResultParts.push({
        type:       'tool-result',
        toolCallId: call.toolCallId,
        toolName:   call.toolName,
        output:     { type: 'text', value: String(resultContent) },
      })
    }

    history.push({ role: 'tool', content: toolResultParts } as unknown as ModelMessage)
  }

  return { text: fullText, messages: history }
}

// ── tool execution ────────────────────────────────────────────────────────────

export function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return {} }
  }
  return (raw as Record<string, unknown>) ?? {}
}

async function executeTool(call: { toolName: string; input?: unknown; args?: unknown }): Promise<string> {
  const args = parseToolArgs(call.input ?? call.args)

  switch (call.toolName) {
    case 'bash':
      if (!args.command) return 'Error: no command provided'
      return executeBash(args.command as string)

    case 'read_file': {
      if (!args.path) return 'Error: no path provided'
      try {
        const MAX_READ_BYTES = 10 * 1024 * 1024  // 10 MB
        const stat = statSync(args.path as string)
        if (stat.size > MAX_READ_BYTES) {
          return `Error: file is ${(stat.size / 1024 / 1024).toFixed(1)} MB — too large to read directly. Use bash with tail/grep/awk to read specific sections.`
        }
        const content = readFileSync(args.path as string, 'utf8')
        const allLines = content.split('\n')
        const totalLines = allLines.length

        const start  = Math.max(0, ((args.offset as number) ?? 1) - 1)
        const count  = (args.limit as number) ?? totalLines
        const slice  = allLines.slice(start, start + count)
        const end    = start + slice.length

        const header = `[${args.path} — lines ${start + 1}–${end} of ${totalLines.toLocaleString()} total]`
        const body   = slice.join('\n')

        const combined = header + '\n' + body
        if (combined.length > MAX_FILE_READ) {
          const half = MAX_FILE_READ / 2
          return (
            combined.slice(0, half) +
            `\n\n[... chunk too large, ${(combined.length - MAX_FILE_READ).toLocaleString()} chars omitted — use a smaller limit ...]\n\n` +
            combined.slice(-half)
          )
        }
        return combined
      } catch (err) {
        return `Error: ${(err as Error).message}`
      }
    }

    case 'write_file': {
      if (!args.path) return 'Error: no path provided'
      try {
        writeFileSync(args.path as string, (args.content as string) ?? '', 'utf8')
        return `Written: ${args.path}`
      } catch (err) {
        return `Error: ${(err as Error).message}`
      }
    }

    default:
      return `Unknown tool: ${call.toolName}`
  }
}

const MAX_DISPLAY_LINES = 10
const MAX_BASH_OUTPUT   = 20_000   // chars sent to AI

function executeBash(command: string): Promise<string> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || 'bash'
    const proc = spawn(shell, ['-c', command], {
      env: process.env,
      cwd: process.cwd(),
    })

    let output = ''
    let killed = false
    proc.stdout.on('data', (data: Buffer) => { output += data.toString() })
    proc.stderr.on('data', (data: Buffer) => { output += data.toString() })

    const timer = setTimeout(() => {
      killed = true
      proc.kill('SIGTERM')
      setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 3000)
    }, BASH_TIMEOUT_MS)

    proc.on('close', (code: number | null) => {
      clearTimeout(timer)
      const tail = killed
        ? `\n[killed: exceeded ${BASH_TIMEOUT_MS / 1000}s timeout]`
        : (code !== 0 ? `\n[exit ${code}]` : '')
      const full = (output + tail).trim() || '(no output)'

      if (process.stdout.isTTY) {
        const lines = full.split('\n')
        if (lines.length <= MAX_DISPLAY_LINES) {
          process.stdout.write(full + '\n')
        } else {
          process.stdout.write(lines.slice(0, MAX_DISPLAY_LINES).join('\n') + '\n')
          process.stdout.write(`${DIM}  … ${lines.length - MAX_DISPLAY_LINES} more lines${RESET}\n`)
        }
      }

      if (full.length > MAX_BASH_OUTPUT) {
        const half = MAX_BASH_OUTPUT / 2
        resolve(
          full.slice(0, half) +
          `\n\n[... ${(full.length - MAX_BASH_OUTPUT).toLocaleString()} chars omitted — use grep/tail/awk for targeted output ...]\n\n` +
          full.slice(-half)
        )
      } else {
        resolve(full)
      }
    })

    proc.on('error', (err: Error) => { clearTimeout(timer); resolve(`Error: ${err.message}`) })
  })
}

// ── retry helpers ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  // HTTP status codes from AI SDK errors
  const status = (err as unknown as Record<string, unknown>)['status'] as number | undefined
  if (status === 429 || status === 529 || status === 500 || status === 503) return true
  // Network-level errors
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') return true
  return false
}
