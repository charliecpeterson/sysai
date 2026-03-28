/**
 * approval.ts — shared approval + agent-with-UI helpers
 *
 * makeApproval(rl, opts) → async onToolApproval function
 * runAgentWithUI(opts)   → { text, messages }
 */

import type { Interface as RLInterface } from 'readline'
import { runAgent, parseToolArgs } from '../core/agent.js'
import { getMcpManager } from '../core/mcp-client.js'
import { loadActiveKbText, activeKbTokenEstimate, listKbs, isKbStale } from '../storage/kb.js'
import { createSpinner, StreamRenderer, renderWriteDiff } from './render.js'
import { RESET, DIM, RED, GREEN, YELLOW, CYAN } from './colors.js'
import type { AgentResult, ApprovalOptions, RunAgentWithUIOptions, ToolDecision } from '../types.js'

// Paths that require explicit user confirmation even in auto-approve mode.
const SENSITIVE_PATH_RE = /\.ssh\/|\.gnupg\/|\.aws\/|\.kube\/|\.docker\/|\/root\/|\.bashrc|\.zshrc|\.bash_profile|\.zprofile|\.profile|\.bash_logout|authorized_keys|known_hosts|id_rsa|id_ed25519|id_ecdsa|id_dsa|\/etc\/|sudoers|\.netrc/i

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

    if (name === 'search_kb') {
      const kb = args.kb ? ` [${args.kb}]` : ''
      writeFn(`${DIM}  ○ search${kb}  ${args.query ?? '?'}${RESET}\n`)
      return 'approved'
    }

    if (name === 'list_kb_files') {
      writeFn(`${DIM}  ○ list kb files${args.kb ? ` [${args.kb}]` : ''}${RESET}\n`)
      return 'approved'
    }

    if (name === 'fetch_url') {
      writeFn(`${DIM}  ○ fetch  ${args.url ?? '?'}${RESET}\n`)
      return 'approved'
    }

    if (name === 'github') {
      writeFn(`${DIM}  ○ github  ${args.url ?? '?'}${RESET}\n`)
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

    // MCP tools — anything that isn't a built-in tool
    const BUILTIN_TOOLS = new Set(['bash', 'read_file', 'write_file', 'search_kb', 'list_kb_files', 'fetch_url', 'github'])
    if (!BUILTIN_TOOLS.has(name)) {
      const argsStr = JSON.stringify(args)
      writeFn(`\n${CYAN}  ● mcp${RESET}   ${name}  ${DIM}${argsStr}${RESET}\n`)
      if (autoApprove) {
        writeFn(`${DIM}  (auto)${RESET}\n`)
        return 'approved'
      }
      return new Promise((resolve) => {
        rl.question(`${DIM}  call? [Y/n]: ${RESET}`, (answer) => {
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

  const mcpManager = await getMcpManager()

  // Announce connected MCP servers (once per session, in TTY mode)
  if (mcpManager && uiIsTTY) {
    for (const { serverName, toolCount } of mcpManager.summary()) {
      uiStream.write(`${DIM}  mcp  ${serverName} (${toolCount} tool${toolCount === 1 ? '' : 's'})${RESET}\n`)
    }
  }

  // CAG: inject active knowledge base text into system prompt
  const CAG_TOKEN_LIMIT = 80_000
  const kbTokens = activeKbTokenEstimate()
  let finalSystemPrompt = systemPrompt
  let enableKbSearch = false

  // Stale warning: any active KB with files newer than lastIndexed
  if (uiIsTTY && kbTokens > 0) {
    const staleKbs = listKbs().filter(k => k.active && isKbStale(k.name))
    for (const k of staleKbs) {
      uiStream.write(`${YELLOW}  ⚠ kb  "${k.name}" has new files — run: sysai kb index ${k.name}${RESET}\n`)
    }
  }

  if (kbTokens > 0 && kbTokens <= CAG_TOKEN_LIMIT) {
    const kbData = loadActiveKbText()
    if (kbData) {
      finalSystemPrompt += `\n\n## Knowledge Base\n\nThe following knowledge base content is available for reference. Use it to answer questions when relevant.\nActive KBs: ${kbData.kbNames.join(', ')}\n\n${kbData.text}`
      if (uiIsTTY) {
        uiStream.write(`${DIM}  kb   ${kbData.kbNames.join(', ')} (~${formatKbTokens(kbTokens)} tokens)${RESET}\n`)
      }
    }
  } else if (kbTokens > CAG_TOKEN_LIMIT) {
    enableKbSearch = true
    finalSystemPrompt += `\n\n## Knowledge Base (search mode)

The user has active knowledge bases that are too large to fit in context. You have two tools to access them:

1. **list_kb_files** — Browse what files exist. File names often reveal topics (e.g. "pricing.md", "gpu-policy.md"). Start here to orient yourself.
2. **search_kb** — Keyword search across all KB content. Returns the most relevant chunks.

**Strategy for answering KB questions:**
- Start with list_kb_files to see what's available
- Search with specific keywords from the user's question
- If results seem incomplete, search again with synonyms or related terms (e.g. "price" → "cost", "purchase", "pricing")
- When you find a promising file, use read_file with the full path to read it directly
- Do 2-3 searches before concluding information isn't available`
    if (uiIsTTY) {
      uiStream.write(`${DIM}  kb   search mode (~${formatKbTokens(kbTokens)} tokens, too large for context)${RESET}\n`)
    }
  }

  try {
    const result = await runAgent({
      systemPrompt: finalSystemPrompt,
      messages,
      onThinking:     () => spinner?.start(),
      onThinkingDone: () => spinner?.stop(),
      onToken:        contentIsTTY
        ? (token) => renderer!.write(token)
        : (token) => contentStream.write(token),
      onToolApproval,
      onToolResult:   (call, result, elapsedMs) => {
        if (!uiIsTTY) return
        const toolName = (call as { toolName: string }).toolName
        const timing   = `${(elapsedMs / 1000).toFixed(1)}s`
        if (mcpManager?.hasTool(toolName)) {
          // Show the raw result so users can see errors (e.g. bad API key, quota exceeded)
          const preview = (result as string).length > 300
            ? (result as string).slice(0, 300) + '…'
            : result as string
          uiStream.write(`${DIM}  ✓ ${timing}  ${preview}${RESET}\n`)
        } else {
          uiStream.write(`${DIM}  ✓ ${timing}${RESET}\n`)
        }
      },
      abortSignal,
      mcpManager: mcpManager ?? undefined,
      enableKbSearch,
    })
    renderer?.flush()
    return result
  } finally {
    spinner?.stop()
    renderer?.flush()
  }
}

function formatKbTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}
