/**
 * agent.js — agentic loop using Vercel AI SDK
 *
 * Tools: bash, read_file, write_file
 * Works with any provider (Anthropic, OpenAI, llama.cpp) via provider.js
 */

import { streamText, tool } from 'ai'
import { z }                 from 'zod'
import { spawn }             from 'child_process'
import { readFileSync, writeFileSync, statSync } from 'fs'
import { getModel }          from './provider.js'
import { DIM, YELLOW, RESET } from './colors.js'

const MAX_ITERATIONS   = parseInt(process.env.SYSAI_MAX_TURNS || '20')
const MAX_FILE_READ    = 20_000  // chars
const BASH_TIMEOUT_MS  = parseInt(process.env.SYSAI_BASH_TIMEOUT || '120') * 1000

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
 *
 * @param {object}   opts
 * @param {string}   opts.systemPrompt
 * @param {Array}    opts.messages         — CoreMessage array
 * @param {function} opts.onToken          — (token: string) => void
 * @param {function} opts.onToolApproval   — async (toolCall) => 'approved' | 'rejected' | '<edited command>'
 * @param {function} [opts.onToolResult]   — (toolCall, result: string) => void
 * @returns {Promise<{text: string, messages: Array}>}
 */
export async function runAgent({ systemPrompt, messages, onToken, onToolApproval, onToolResult, onThinking, onThinkingDone, abortSignal }) {
  const model   = getModel()
  const history = [...messages]
  let fullText  = ''
  let iterations = 0

  while (iterations++ < MAX_ITERATIONS) {
    onThinking?.()
    let thinkingDone = false

    const result = streamText({
      model,
      system:    systemPrompt,
      messages:  history,
      tools:     TOOLS,
      maxTokens: parseInt(process.env.SYSAI_MAX_TOKENS || '8192'),
      ...(abortSignal && { abortSignal }),
    })

    try {
      // Stream text as it arrives
      for await (const textChunk of result.textStream) {
        if (!textChunk) continue
        if (!thinkingDone) { thinkingDone = true; onThinkingDone?.() }
        fullText += textChunk
        onToken(textChunk)
      }
    } catch (err) {
      if (!thinkingDone) onThinkingDone?.()   // always clear spinner on abort/error
      throw err
    }

    // No text tokens — pure tool-call turn: clear spinner before approval prompts
    if (!thinkingDone) { thinkingDone = true; onThinkingDone?.() }

    // Collect results once streaming is done
    const [finishReason, toolCalls, response] = await Promise.all([
      result.finishReason,
      result.toolCalls,
      result.response,
    ])

    // Add assistant message to history.
    // Strip SDK-internal extra fields (providerMetadata, title, etc.) that
    // Zod 4 strict mode rejects when the messages are re-validated on the next turn.
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
              input:      part.input ?? part.args,
            }
          }
          if (part.type === 'text') return { type: 'text', text: part.text }
          return part
        }),
      }
    })
    history.push(...normalized)

    if (finishReason === 'stop' || finishReason === 'end_turn' || toolCalls.length === 0) {
      return { text: fullText, messages: history }
    }

    if (iterations >= MAX_ITERATIONS) {
      onToken(`\n${YELLOW}[sysai: max iterations reached]${RESET}\n`)
      return { text: fullText, messages: history }
    }

    // Handle tool calls with approval
    const toolResultParts = []

    for (const call of toolCalls) {
      const decision = await onToolApproval(call)
      let resultContent

      if (decision === 'rejected') {
        resultContent = 'User rejected this tool call.'
      } else {
        const finalCall = (decision === 'approved' || call.toolName !== 'bash')
          ? call
          : { ...call, input: { command: decision } }

        const t0 = Date.now()
        resultContent = await executeTool(finalCall)
        onToolResult?.(finalCall, resultContent, Date.now() - t0)
      }

      // AI SDK v6: tool results use `output: { type, value }` not `result`
      toolResultParts.push({
        type:       'tool-result',
        toolCallId: call.toolCallId,
        toolName:   call.toolName,
        output:     { type: 'text', value: String(resultContent) },
      })
    }

    history.push({ role: 'tool', content: toolResultParts })
  }
}

// ── tool execution ────────────────────────────────────────────────────────────

export function parseToolArgs(raw) {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return {} }
  }
  return raw ?? {}
}

async function executeTool(call) {
  const args = parseToolArgs(call.input ?? call.args)

  switch (call.toolName) {
    case 'bash':
      if (!args.command) return 'Error: no command provided'
      return executeBash(args.command)

    case 'read_file': {
      if (!args.path) return 'Error: no path provided'
      try {
        const MAX_READ_BYTES = 10 * 1024 * 1024  // 10 MB — refuse to load larger files into memory
        const stat = statSync(args.path)
        if (stat.size > MAX_READ_BYTES) {
          return `Error: file is ${(stat.size / 1024 / 1024).toFixed(1)} MB — too large to read directly. Use bash with tail/grep/awk to read specific sections.`
        }
        const content = readFileSync(args.path, 'utf8')
        const allLines = content.split('\n')
        const totalLines = allLines.length

        const start  = Math.max(0, (args.offset ?? 1) - 1)
        const count  = args.limit ?? totalLines
        const slice  = allLines.slice(start, start + count)
        const end    = start + slice.length

        const header = `[${args.path} — lines ${start + 1}–${end} of ${totalLines.toLocaleString()} total]`
        const body   = slice.join('\n')

        // Warn if a single chunk is still very large
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
        return `Error: ${err.message}`
      }
    }

    case 'write_file': {
      if (!args.path) return 'Error: no path provided'
      try {
        writeFileSync(args.path, args.content ?? '', 'utf8')
        return `Written: ${args.path}`
      } catch (err) {
        return `Error: ${err.message}`
      }
    }

    default:
      return `Unknown tool: ${call.toolName}`
  }
}

const MAX_DISPLAY_LINES = 10
const MAX_BASH_OUTPUT   = 20_000   // chars sent to AI

function executeBash(command) {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || 'bash'
    const proc = spawn(shell, ['-c', command], {
      env: process.env,
      cwd: process.cwd(),
    })

    let output = ''
    let killed = false
    proc.stdout.on('data', (data) => { output += data.toString() })
    proc.stderr.on('data', (data) => { output += data.toString() })

    // Kill hung commands after BASH_TIMEOUT_MS (default 120s, set SYSAI_BASH_TIMEOUT to override)
    const timer = setTimeout(() => {
      killed = true
      proc.kill('SIGTERM')
      // Force-kill after 3s if SIGTERM is ignored
      setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 3000)
    }, BASH_TIMEOUT_MS)

    proc.on('close', (code) => {
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

      // Cap what the AI receives — keep start + end so headers and recent output are both preserved
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

    proc.on('error', (err) => { clearTimeout(timer); resolve(`Error: ${err.message}`) })
  })
}
