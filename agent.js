/**
 * agent.js — agentic loop using Vercel AI SDK
 *
 * Tools: bash, read_file, write_file
 * Works with any provider (Anthropic, OpenAI, llama.cpp) via provider.js
 */

import { streamText, tool } from 'ai'
import { z }                 from 'zod'
import { spawn }             from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { getModel }          from './provider.js'

const MAX_ITERATIONS = 15
const MAX_FILE_READ  = 20_000  // chars

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
    description: 'Read a file. Prefer bash for large files or when you need line numbers.',
    inputSchema: z.object({
      path: z.string().describe('Absolute or relative file path'),
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
export async function runAgent({ systemPrompt, messages, onToken, onToolApproval, onToolResult }) {
  const model   = getModel()
  const history = [...messages]
  let fullText  = ''
  let iterations = 0

  while (iterations++ < MAX_ITERATIONS) {
    const result = streamText({
      model,
      system:   systemPrompt,
      messages: history,
      tools:    TOOLS,
    })

    // Stream text as it arrives
    for await (const textChunk of result.textStream) {
      if (!textChunk) continue
      fullText += textChunk
      onToken(textChunk)
    }

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
      onToken('\n\x1b[33m[sysai: max iterations reached]\x1b[0m\n')
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

        resultContent = await executeTool(finalCall)
        onToolResult?.(finalCall, resultContent)
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

async function executeTool(call) {
  // Vercel AI SDK uses `input` for tool call arguments
  const raw = call.input ?? call.args
  const args = typeof raw === 'string'
    ? (() => { try { return JSON.parse(raw) } catch { return {} } })()
    : (raw ?? {})

  switch (call.toolName) {
    case 'bash':
      if (!args.command) return 'Error: no command provided'
      return executeBash(args.command)

    case 'read_file': {
      if (!args.path) return 'Error: no path provided'
      try {
        const content = readFileSync(args.path, 'utf8')
        return content.length > MAX_FILE_READ
          ? content.slice(0, MAX_FILE_READ) + '\n[... truncated ...]'
          : content
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

function executeBash(command) {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || 'bash'
    const proc = spawn(shell, ['-c', command], {
      env: process.env,
      cwd: process.cwd(),
    })

    let output = ''

    proc.stdout.on('data', (data) => {
      const text = data.toString()
      output += text
      process.stdout.write(text)
    })

    proc.stderr.on('data', (data) => {
      const text = data.toString()
      output += text
      process.stderr.write(text)
    })

    proc.on('close', (code) => {
      const tail = code !== 0 ? `\n[exit ${code}]` : ''
      resolve((output + tail).trim() || '(no output)')
    })

    proc.on('error', (err) => resolve(`Error: ${err.message}`))
  })
}
