/**
 * approval.ts — shared approval + agent-with-UI helpers
 *
 * makeApproval(rl, opts) → async onToolApproval function
 * runAgentWithUI(opts)   → { text, messages }
 */

import type { Interface as RLInterface } from 'readline'
import { runAgent, parseToolArgs } from '../core/agent.js'
import { createSpinner, StreamRenderer, renderWriteDiff } from './render.js'
import { RESET, DIM, RED, GREEN, YELLOW } from './colors.js'
import type { AgentResult, ApprovalOptions, RunAgentWithUIOptions, ToolDecision } from '../types.js'

// Paths that require explicit user confirmation even in auto-approve mode.
const SENSITIVE_PATH_RE = /\.ssh\/|\.gnupg\/|\.bashrc|\.zshrc|\.bash_profile|\.zprofile|\.profile|\.bash_logout|authorized_keys|known_hosts|id_rsa|id_ed25519|\/etc\/|sudoers/i

/**
 * Build an onToolApproval function.
 */
export function makeApproval(rl: RLInterface, {
  autoApprove      = false,
  writeFn          = (s: string) => process.stderr.write(s),
  autoApproveWrite = false,
}: ApprovalOptions = {}): (toolUse: unknown) => Promise<ToolDecision> {
  return async function onToolApproval(toolUse: unknown): Promise<ToolDecision> {
    const tu = toolUse as { toolName: string; input?: unknown; args?: unknown }
    const name = tu.toolName
    const args = parseToolArgs(tu.input ?? tu.args)

    if (name === 'read_file') {
      writeFn(`${DIM}  ○ read  ${args.path ?? '?'}${RESET}\n`)
      return 'approved'
    }

    if (name === 'bash') {
      if (autoApprove) {
        writeFn(`\n${YELLOW}  ● run${RESET}   ${args.command}  ${DIM}(auto)${RESET}\n`)
        return 'approved'
      }
      writeFn(`\n${YELLOW}  ● run${RESET}   ${args.command}\n`)
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
      const isSensitive = SENSITIVE_PATH_RE.test((args.path as string) ?? '')
      writeFn(`\n${RED}  ● write${RESET}  ${args.path}${isSensitive ? `  ${YELLOW}(sensitive path)${RESET}` : ''}\n`)
      renderWriteDiff(args.path as string, (args.content as string) ?? '', (line) => writeFn(line + '\n'))
      if ((autoApprove || autoApproveWrite) && !isSensitive) {
        writeFn(`${DIM}  (auto-approved)${RESET}\n`)
        return 'approved'
      }
      if (isSensitive && (autoApprove || autoApproveWrite)) {
        writeFn(`${YELLOW}  sensitive path — confirmation required regardless of -y${RESET}\n`)
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
 */
export async function runAgentWithUI({
  systemPrompt,
  messages,
  autoApprove   = false,
  abortSignal,
  rl,
  contentStream = process.stdout,
  uiStream      = process.stderr,
}: RunAgentWithUIOptions): Promise<AgentResult> {
  const contentIsTTY = contentStream.isTTY
  const uiIsTTY      = uiStream.isTTY

  const spinner  = uiIsTTY      ? createSpinner((s) => uiStream.write(s)) : null
  const renderer = contentIsTTY ? new StreamRenderer((s) => contentStream.write(s)) : null

  const writeFn        = (s: string) => uiStream.write(s)
  const onToolApproval = makeApproval(rl, { autoApprove, writeFn })

  try {
    const result = await runAgent({
      systemPrompt,
      messages,
      onThinking:     () => spinner?.start(),
      onThinkingDone: () => spinner?.stop(),
      onToken:        contentIsTTY
        ? (token) => renderer!.write(token)
        : (token) => contentStream.write(token),
      onToolApproval,
      onToolResult:   (_call, _result, elapsedMs) => {
        if (uiIsTTY) uiStream.write(`${DIM}  ✓ ${(elapsedMs / 1000).toFixed(1)}s${RESET}\n`)
      },
      abortSignal,
    })
    renderer?.flush()
    return result
  } finally {
    spinner?.stop()
    renderer?.flush()
  }
}
