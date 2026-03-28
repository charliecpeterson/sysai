#!/usr/bin/env bun
/**
 * ask.ts — agentic one-shot query
 *
 * Usage:
 *   ? why is load high
 *   dmesg | tail -20 | ? what do these mean
 */

import { readFileSync, createReadStream } from 'fs'
import readline from 'readline'
import { buildContext }   from '../env/context.js'
import { buildMessages, getSystemPrompt } from '../core/prompt.js'
import { runAgentWithUI } from '../ui/approval.js'
import { formatApiError } from '../ui/errors.js'
import { getActiveConfig } from '../storage/models.js'
import { BOLD, DIM, CYAN, RESET, RED } from '../ui/colors.js'

async function main(): Promise<void> {
  const args        = process.argv.slice(2)
  const autoApprove = args.includes('-y') || args.includes('--yes')
  // Strip flags before joining remaining args as the question
  const questionFlag = parseFlag(args, '--question')
  const cleanArgs    = stripFlag(args.filter(a => a !== '-y' && a !== '--yes'), '--question')
  const question     = questionFlag ?? cleanArgs.join(' ')

  if (!question.trim()) {
    console.error('Usage: ? [-y] <question>')
    console.error('       echo "output" | ? <question>')
    console.error('       -y  auto-approve all tool calls')
    process.exit(1)
  }

  let stdinContent = ''
  if (!process.stdin.isTTY) {
    try { stdinContent = readFileSync('/dev/stdin', 'utf8') } catch {}
  }

  // Use /dev/tty for approval prompts so they work even when stdin is piped
  const ttyInput = process.stdin.isTTY
    ? process.stdin
    : (() => { try { return createReadStream('/dev/tty') } catch { return process.stdin } })()

  const rl = readline.createInterface({ input: ttyInput, output: process.stderr, terminal: true })

  const context  = await buildContext({ stdinContent, questionHint: question })
  const messages = buildMessages({ context, question })

  const cfg = getActiveConfig()
  if (process.stderr.isTTY) {
    const model = cfg?.name ?? '?'
    process.stderr.write(`${DIM}  sysai ${CYAN}●${RESET}${DIM} ${model}${RESET}\n`)
  }
  process.stdout.write('\n')

  const abortController = new AbortController()
  process.once('SIGINT', () => abortController.abort())

  try {
    await runAgentWithUI({
      systemPrompt:  getSystemPrompt(),
      messages,
      autoApprove,
      abortSignal:   abortController.signal,
      rl,
      contentStream: process.stdout,
      uiStream:      process.stderr,
    })
    process.stdout.write('\n')
  } catch (err) {
    if (abortController.signal.aborted) {
      process.stderr.write(`\n${DIM}  cancelled${RESET}\n`)
      process.exit(0)
    }
    process.stderr.write(`\n${RED}sysai: ${formatApiError(err)}${RESET}\n`)
    process.exit(1)
  } finally {
    rl.close()
  }

  process.exit(0)
}

function parseFlag(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag)
  if (idx === -1 || idx + 1 >= args.length) return null
  return args[idx + 1]
}

// Remove a --flag and its value from an args array
function stripFlag(args: string[], flag: string): string[] {
  const idx = args.indexOf(flag)
  if (idx === -1) return args
  return [...args.slice(0, idx), ...args.slice(idx + 2)]
}

main().catch(err => {
  console.error('sysai error:', (err as Error).message)
  process.exit(1)
})
