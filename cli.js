#!/usr/bin/env node
/**
 * cli.js — agentic one-shot query
 *
 * Usage:
 *   ? why is load high
 *   dmesg | tail -20 | ? what do these mean
 */

import { readFileSync, createReadStream } from 'fs'
import readline from 'readline'
import { buildContext }   from './context.js'
import { buildMessages, getSystemPrompt } from './prompt.js'
import { runAgentWithUI } from './run.js'
import { formatApiError } from './errors.js'
import { DIM, RESET, RED } from './colors.js'

async function main() {
  const args        = process.argv.slice(2)
  const autoApprove = args.includes('-y') || args.includes('--yes')
  const cleanArgs   = args.filter(a => a !== '-y' && a !== '--yes')
  const question    = parseFlag(cleanArgs, '--question') ?? cleanArgs.join(' ')

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
  } catch (err) {
    if (abortController.signal.aborted) {
      process.stderr.write(`\n${DIM}  cancelled${RESET}\n`)
      process.exit(0)
    }
    process.stderr.write(`\n${RED}sysai: ${formatApiError(err)}${RESET}\n`)
    process.exit(1)
  }

  process.stdout.write('\n')
  rl.close()
  process.exit(0)
}

function parseFlag(args, flag) {
  const idx = args.indexOf(flag)
  if (idx === -1 || idx + 1 >= args.length) return null
  return args[idx + 1]
}

main().catch(err => {
  console.error('sysai error:', err.message)
  process.exit(1)
})
