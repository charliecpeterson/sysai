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
import { buildMessages, SYSTEM_PROMPT } from './prompt.js'
import { runAgent }       from './agent.js'

const RESET  = '\x1b[0m'
const DIM    = '\x1b[2m'
const YELLOW = '\x1b[33m'
const RED    = '\x1b[31m'

async function main() {
  const args     = process.argv.slice(2)
  const question = parseFlag(args, '--question') ?? args.join(' ')

  if (!question.trim()) {
    console.error('Usage: ? <question>')
    console.error('       echo "output" | ? <question>')
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

  try {
    await runAgent({
      systemPrompt: SYSTEM_PROMPT,
      messages,
      onToken: (token) => process.stdout.write(token),
      onToolApproval: (toolUse) => askApproval(toolUse, rl),
    })
  } catch (err) {
    process.stderr.write(`\n${RED}sysai error: ${err.message}${RESET}\n`)
    process.exit(1)
  }

  process.stdout.write('\n')
  rl.close()
}

function askApproval(toolUse, rl) {
  return new Promise((resolve) => {
    const name = toolUse.toolName
    const raw  = toolUse.input ?? toolUse.args
    const args = typeof raw === 'string'
      ? (() => { try { return JSON.parse(raw) } catch { return {} } })()
      : (raw ?? {})

    if (name === 'read_file') {
      process.stderr.write(`${DIM}  read: ${args.path ?? '?'}${RESET}\n`)
      return resolve('approved')
    }

    if (name === 'bash') {
      process.stderr.write(`\n${YELLOW}  ⚡ bash${RESET}  ${args.command}\n`)
      rl.question(`${DIM}  run? [Y/n/e(dit)]: ${RESET}`, (answer) => {
        const a = answer.trim().toLowerCase()
        if (a === 'n' || a === 'no') return resolve('rejected')
        if (a === 'e' || a === 'edit') {
          rl.question(`${DIM}  edit: ${RESET}`, (edited) => resolve(edited.trim() || 'rejected'))
          return
        }
        resolve('approved')
      })
      return
    }

    if (name === 'write_file') {
      process.stderr.write(`\n${RED}  ✎ write${RESET}  ${args.path}\n`)
      rl.question(`${DIM}  write? [Y/n]: ${RESET}`, (answer) => {
        const a = answer.trim().toLowerCase()
        resolve(a === 'n' || a === 'no' ? 'rejected' : 'approved')
      })
      return
    }

    resolve('approved')
  })
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
