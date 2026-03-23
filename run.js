/**
 * run.js — shared approval + agent-with-UI helpers
 *
 * makeApproval(rl, opts) → async onToolApproval function
 * runAgentWithUI(opts)   → { text, messages }
 */

import { runAgent }       from './agent.js'
import { createSpinner, StreamRenderer, renderWriteDiff, DIM, RESET } from './render.js'

const YELLOW = '\x1b[33m'
const RED    = '\x1b[31m'
const GREEN  = '\x1b[32m'
const BOLD   = '\x1b[1m'

/**
 * Build an onToolApproval function.
 *
 * @param {import('readline').Interface} rl
 * @param {object} opts
 * @param {boolean} [opts.autoApprove=false]       — auto-approve bash + write_file
 * @param {Function} [opts.writeFn]                — where approval UI output goes (default: process.stderr.write)
 * @param {boolean} [opts.autoApproveWrite=false]  — always auto-approve write_file (used by taskDesigner)
 */
export function makeApproval(rl, {
  autoApprove      = false,
  writeFn          = (s) => process.stderr.write(s),
  autoApproveWrite = false,
} = {}) {
  return async function onToolApproval(toolUse) {
    const name = toolUse.toolName
    const raw  = toolUse.input ?? toolUse.args
    const args = typeof raw === 'string'
      ? (() => { try { return JSON.parse(raw) } catch { return {} } })()
      : (raw ?? {})

    if (name === 'read_file') {
      writeFn(`${DIM}  read: ${args.path ?? '?'}${RESET}\n`)
      return 'approved'
    }

    if (name === 'bash') {
      if (autoApprove) {
        writeFn(`\n${YELLOW}  ⚡ bash${RESET}  ${args.command}  ${DIM}(auto)${RESET}\n`)
        return 'approved'
      }
      writeFn(`\n${YELLOW}  ⚡ bash${RESET}  ${args.command}\n`)
      return new Promise((resolve) => {
        rl.question(`${DIM}  run? [Y/n/e(dit)]: ${RESET}`, (answer) => {
          const a = answer.trim().toLowerCase()
          if (a === 'n' || a === 'no') return resolve('rejected')
          if (a === 'e' || a === 'edit') {
            rl.question(`${DIM}  edit: ${RESET}`, (edited) => resolve(edited.trim() || 'rejected'))
            return
          }
          resolve('approved')
        })
      })
    }

    if (name === 'write_file') {
      writeFn(`\n${RED}  ✎ write${RESET}  ${args.path}\n`)
      renderWriteDiff(args.path, args.content ?? '', (line) => writeFn(line + '\n'))
      if (autoApprove || autoApproveWrite) {
        writeFn(`${DIM}  (auto-approved)${RESET}\n`)
        return 'approved'
      }
      return new Promise((resolve) => {
        rl.question(`${DIM}  write? [Y/n]: ${RESET}`, (answer) => {
          const a = answer.trim().toLowerCase()
          resolve(a === 'n' || a === 'no' ? 'rejected' : 'approved')
        })
      })
    }

    return 'approved'
  }
}

/**
 * Run the agent with spinner + stream renderer wired to the given streams.
 * Always flushes renderer and stops spinner (in finally). Re-throws errors.
 *
 * @param {object} opts
 * @param {string}  opts.systemPrompt
 * @param {Array}   opts.messages
 * @param {boolean} [opts.autoApprove=false]
 * @param {AbortSignal} [opts.abortSignal]
 * @param {import('readline').Interface} opts.rl
 * @param {NodeJS.WriteStream} [opts.contentStream=process.stdout]  — AI text output
 * @param {NodeJS.WriteStream} [opts.uiStream=process.stderr]       — spinner / approval prompts
 * @returns {Promise<{ text: string, messages: Array }>}
 */
export async function runAgentWithUI({
  systemPrompt,
  messages,
  autoApprove   = false,
  abortSignal,
  rl,
  contentStream = process.stdout,
  uiStream      = process.stderr,
}) {
  const contentIsTTY = contentStream.isTTY
  const uiIsTTY      = uiStream.isTTY

  const spinner  = uiIsTTY      ? createSpinner((s) => uiStream.write(s)) : null
  const renderer = contentIsTTY ? new StreamRenderer((s) => contentStream.write(s)) : null

  const writeFn       = (s) => uiStream.write(s)
  const onToolApproval = makeApproval(rl, { autoApprove, writeFn })

  try {
    const result = await runAgent({
      systemPrompt,
      messages,
      onThinking:     () => spinner?.start(),
      onThinkingDone: () => spinner?.stop(),
      onToken:        contentIsTTY
        ? (token) => renderer.write(token)
        : (token) => contentStream.write(token),
      onToolApproval,
      onToolResult:   (_call, _result, elapsedMs) => {
        if (uiIsTTY) uiStream.write(`${DIM}  ✓ ${(elapsedMs / 1000).toFixed(1)}s${RESET}\n`)
      },
      abortSignal,
    })
    renderer?.flush()
    return result
  } catch (err) {
    throw err
  } finally {
    spinner?.stop()
    renderer?.flush()
  }
}
