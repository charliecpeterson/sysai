#!/usr/bin/env node
/**
 * server.js — interactive agentic REPL
 *
 * Started by ai-pane. Maintains conversation history in memory.
 * The agent can run bash commands, read files, and write files —
 * all with user approval before execution.
 */

import readline  from 'readline'
import { spawnSync } from 'child_process'
import { existsSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { buildContext }   from './context.js'
import { buildMessages, getSystemPrompt } from './prompt.js'
import { makeApproval, runAgentWithUI } from './run.js'
import {
  createSession, appendTurn, listSessions, loadSession,
  lastSession, deleteSession, migrateOldHistory, pruneHistory,
  writeCompactedSession,
} from './history.js'
import { formatApiError } from './errors.js'
import { VERSION } from './version.js'
import { getActiveConfig } from './models.js'
import { DEFAULTS } from './provider.js'
import { RESET, BOLD, DIM, RED, GREEN, YELLOW, CYAN } from './colors.js'

async function main() {
  if (!process.argv.includes('--inline')) {
    const isBundled = !process.argv[1]?.endsWith('.js')
    const chatCmd = isBundled
      ? `${process.argv[1]} chat --inline`
      : `${process.execPath} ${process.argv[1]} chat --inline`
    const quotedCmd = chatCmd.replace(/'/g, `'\\''`)

    if (process.env.TMUX) {
      // Already in tmux — split current window
      const workPane = spawnSync('tmux', ['display-message', '-p', '#{pane_id}'],
        { encoding: 'utf8' }).stdout.trim()
      spawnSync('tmux', [
        'split-window', '-h', '-p', '38',
        '-e', `SYSAI_WORK_PANE=${workPane}`,
        'sh', '-c', quotedCmd,
      ], { stdio: 'inherit' })
      process.exit(0)
    }

    const hasTmux = spawnSync('which', ['tmux'], { encoding: 'utf8' }).status === 0
    if (hasTmux) {
      // Not in tmux but it's available — start a new session with the split
      process.stderr.write(`${DIM}  starting tmux…${RESET}\n`)
      spawnSync('sh', ['-c', [
        `pane=$(tmux new-session -dPF '#{pane_id}')`,
        `tmux split-window -h -p 38 -e "SYSAI_WORK_PANE=$pane" '${quotedCmd}'`,
        `tmux select-pane -t "$pane"`,
        `tmux attach-session`,
      ].join(' && ')], { stdio: 'inherit' })
      process.exit(0)
    }
    // No tmux — fall through to inline
  }

  let sessionHistory = []
  let currentSession = null

  // One-time migration from old history.jsonl
  migrateOldHistory()
  pruneHistory()

  const cfg = getActiveConfig()
  const modelLabel = cfg ? `${cfg.name} ${DIM}(${cfg.provider})${RESET}` : `${RED}no model${RESET}`

  process.stdout.write(`\n${CYAN}  ┌─┐${RESET}\n`)
  process.stdout.write(`${CYAN}  └─┤ ${BOLD}sysai${RESET} ${DIM}v${VERSION}${RESET}\n`)
  process.stdout.write(`${CYAN}    └─${RESET} ${modelLabel}\n`)
  process.stdout.write(`\n${DIM}  /help for commands  ·  /sessions to browse  ·  Ctrl-D to quit${RESET}\n\n`)

  // Offer to resume last session
  const last = lastSession()
  if (last && last.turns > 0) {
    const when = new Date(last.ts).toLocaleString()
    process.stdout.write(`${DIM}Last session: ${when} (${last.turns} turns)${RESET}\n`)
    if (last.title) process.stdout.write(`${DIM}  ${last.title.slice(0, 80)}${RESET}\n`)
    process.stdout.write(`${DIM}Resume? (y/N) ${RESET}`)
    const answer = await readLineOnce()
    if (answer.trim().toLowerCase() === 'y') {
      sessionHistory = loadSession(last.file)
      // Continue the existing session
      currentSession = { file: last.file, meta: { ts: last.ts, hostname: last.hostname, title: last.title, turns: last.turns } }
      process.stdout.write(`${DIM}Loaded ${last.turns} prior turns.${RESET}\n`)
    }
    process.stdout.write('\n')
  }

  // Start new session if not resuming
  if (!currentSession) {
    const ctx = await buildContext()
    currentSession = createSession(ctx.hostname)
  }

  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    prompt: `${CYAN}>${RESET} `,
  })

  let activeAbort = null

  rl.prompt()

  rl.on('line', async (input) => {
    const question = input.trim()

    if (!question) {
      rl.prompt()
      return
    }

    if (question.startsWith('/')) {
      const result = handleCommand(question, sessionHistory, rl, {
        getCurrentSession: () => currentSession,
        setSession: (hist, sess) => { sessionHistory = hist; currentSession = sess },
      })
      if (result instanceof Promise) await result
      rl.prompt()
      return
    }

    const context  = await buildContext({ questionHint: question })
    const messages = buildMessages({ context, question, history: sessionHistory })

    process.stdout.write('\n')

    activeAbort = new AbortController()
    let fullResponse = ''
    let result = null
    try {
      result = await runAgentWithUI({
        systemPrompt:  getSystemPrompt(),
        messages,
        autoApprove:   false,
        abortSignal:   activeAbort.signal,
        rl,
        contentStream: process.stdout,
        uiStream:      process.stdout,
      })
      fullResponse = result.text
    } catch (err) {
      if (activeAbort?.signal.aborted) {
        process.stdout.write(`\n${DIM}  cancelled${RESET}\n`)
      } else {
        process.stdout.write(`\n${RED}sysai: ${formatApiError(err)}${RESET}\n`)
      }
    } finally {
      activeAbort = null
    }

    process.stdout.write('\n\n')

    // Preserve full agent message history (including tool calls/results) for continuity.
    // result.messages already contains the prior sessionHistory + new turns, so just replace.
    if (result?.messages) {
      sessionHistory = result.messages
      // Cap at ~60 messages to stay within context limits (tool calls add extra messages)
      const cap = parseInt(process.env.SYSAI_MAX_TURNS || '20') * 3
      if (sessionHistory.length > cap) sessionHistory = sessionHistory.slice(-cap)
    }

    if (fullResponse) {
      appendTurn(currentSession, { question, response: fullResponse })
    }

    rl.prompt()
  })

  rl.on('close', () => {
    process.stdout.write(`\n${DIM}sysai: session ended.${RESET}\n`)
    process.exit(0)
  })

  process.on('SIGINT', () => {
    if (activeAbort) {
      activeAbort.abort()
    } else {
      process.stdout.write(`\n${DIM}  Ctrl-D or /exit to quit${RESET}\n`)
      rl.prompt()
    }
  })
}

// ── slash commands ────────────────────────────────────────────────────────────

async function handleCommand(input, history, rl, { getCurrentSession, setSession }) {
  const parts = input.split(/\s+/)
  const [cmd, ...args] = parts

  switch (cmd) {
    case '/exit':
    case '/quit':
      process.stdout.write(`${DIM}sysai: goodbye.${RESET}\n`)
      process.exit(0)
      break

    case '/clear':
      setSession([], getCurrentSession())
      process.stdout.write(`${DIM}Conversation cleared.${RESET}\n`)
      break

    case '/new': {
      history.length = 0
      const ctx = await buildContext()
      const session = createSession(ctx.hostname)
      setSession([], session)
      process.stdout.write(`${DIM}Started new session.${RESET}\n`)
      break
    }

    case '/history':
      if (history.length === 0) {
        process.stdout.write(`${DIM}No history this session.${RESET}\n`)
      } else {
        process.stdout.write(`${DIM}${history.length / 2} turns this session.${RESET}\n`)
        for (let i = 0; i < history.length; i += 2) {
          const q = history[i]?.content?.split('\n## Question\n')[1]?.trim() ?? '(unknown)'
          process.stdout.write(`  ${DIM}${Math.floor(i / 2) + 1}. ${q.slice(0, 80)}${RESET}\n`)
        }
      }
      break

    case '/sessions': {
      const sessions = listSessions()
      if (sessions.length === 0) {
        process.stdout.write(`${DIM}No saved sessions.${RESET}\n`)
        break
      }
      const current = getCurrentSession()
      process.stdout.write(`\n${DIM}Saved sessions:${RESET}\n`)
      const show = sessions.slice(0, 20)
      for (let i = 0; i < show.length; i++) {
        const s = show[i]
        const when = new Date(s.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        const title = s.title ? s.title.slice(0, 60) : '(empty)'
        const isCurrent = current?.file === s.file
        const marker = isCurrent ? `${GREEN}*${RESET}` : ' '
        process.stdout.write(`  ${marker}${DIM}${i + 1}.${RESET} ${DIM}[${when}]${RESET} ${title} ${DIM}(${s.turns} turns)${RESET}\n`)
      }
      if (sessions.length > 20) {
        process.stdout.write(`${DIM}  ... and ${sessions.length - 20} more${RESET}\n`)
      }
      process.stdout.write(`\n${DIM}  /resume N to load  |  /delete N to remove${RESET}\n\n`)
      break
    }

    case '/resume': {
      const n = parseInt(args[0])
      const sessions = listSessions()
      if (!n || n < 1 || n > sessions.length) {
        process.stdout.write(`${DIM}Usage: /resume N (use /sessions to see list)${RESET}\n`)
        break
      }
      const target = sessions[n - 1]
      const loaded = loadSession(target.file)
      const session = { file: target.file, meta: { ts: target.ts, hostname: target.hostname, title: target.title, turns: target.turns } }
      setSession(loaded, session)
      process.stdout.write(`${GREEN}Resumed:${RESET} ${target.title || '(untitled)'} ${DIM}(${target.turns} turns)${RESET}\n`)
      break
    }

    case '/delete': {
      const n = parseInt(args[0])
      const sessions = listSessions()
      if (!n || n < 1 || n > sessions.length) {
        process.stdout.write(`${DIM}Usage: /delete N (use /sessions to see list)${RESET}\n`)
        break
      }
      const target = sessions[n - 1]
      const current = getCurrentSession()
      if (current?.file === target.file) {
        process.stdout.write(`${RED}Can't delete the current session.${RESET}\n`)
        break
      }
      deleteSession(target.file)
      process.stdout.write(`${DIM}Deleted: ${target.title || '(untitled)'}${RESET}\n`)
      break
    }

    case '/status': {
      const { getActiveConfig } = await import('./models.js')
      const activeCfg = getActiveConfig()
      const turns   = Math.floor(history.length / 2)
      const maxTurns = parseInt(process.env.SYSAI_MAX_TURNS || '20')
      const tokens  = Math.round(
        history.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 200), 0) / 4
      )
      const hasInstr = existsSync(`${homedir()}/.sysai/instructions.md`)
      const provider = activeCfg?.provider ?? '?'
      const model    = activeCfg?.model ?? '(default)'
      const name     = activeCfg?.name ? ` ${DIM}(${activeCfg.name})${RESET}` : ''
      process.stdout.write('\n')
      process.stdout.write(`  ${DIM}provider:${RESET}      ${provider}\n`)
      process.stdout.write(`  ${DIM}model:${RESET}         ${model}${name}\n`)
      process.stdout.write(`  ${DIM}turns:${RESET}         ${turns} / ${maxTurns}\n`)
      process.stdout.write(`  ${DIM}~tokens:${RESET}       ~${tokens.toLocaleString()}\n`)
      process.stdout.write(`  ${DIM}instructions:${RESET}  ${hasInstr ? '✓ loaded' : 'none'}\n`)
      process.stdout.write('\n')
      break
    }

    case '/compact': {
      const COMPACT_KEEP = parseInt(process.env.SYSAI_COMPACT_KEEP || '6')
      if (history.length <= COMPACT_KEEP * 2) {
        process.stdout.write(`${DIM}Nothing to compact — only ${Math.floor(history.length / 2)} turns.${RESET}\n`)
        break
      }
      const older  = history.slice(0, history.length - COMPACT_KEEP * 2)
      const recent = history.slice(-COMPACT_KEEP * 2)
      process.stdout.write(`${DIM}  Summarising ${Math.floor(older.length / 2)} older turns…${RESET}`)
      try {
        const { generateText } = await import('ai')
        const { getModel }     = await import('./provider.js')

        // Extract readable text from all message types including tool calls/results
        const transcript = older.map(m => {
          let text
          if (typeof m.content === 'string') {
            text = m.content.slice(0, 600)
          } else if (Array.isArray(m.content)) {
            text = m.content.map(p => {
              if (p.type === 'text')        return p.text
              if (p.type === 'tool-call')   return `[ran: ${p.toolName} ${JSON.stringify(p.input ?? {}).slice(0, 120)}]`
              if (p.type === 'tool-result') return `[result: ${String(p.output?.value ?? p.result ?? '').slice(0, 200)}]`
              return `[${p.type}]`
            }).join(' ').slice(0, 600)
          }
          return `${m.role}: ${text}`
        }).join('\n')

        const { text } = await generateText({
          model:     getModel(),
          prompt:    `Summarise this conversation concisely. Preserve key facts, commands run, findings, errors, and decisions:\n\n${transcript}`,
          maxTokens: 600,
        })
        const summarised = [
          { role: 'user',      content: '[Earlier conversation — summarised]' },
          { role: 'assistant', content: text },
          ...recent,
        ]
        const currentSession = getCurrentSession()
        setSession(summarised, currentSession)
        // Persist the compacted history so resume after quit reflects the compact
        writeCompactedSession(currentSession, summarised)
        process.stdout.write(`\r${GREEN}✓${RESET} Compacted to summary + last ${COMPACT_KEEP} turns.${' '.repeat(20)}\n`)
      } catch (err) {
        process.stdout.write(`\r${RED}Compact failed: ${formatApiError(err)}${RESET}\n`)
      }
      break
    }

    case '/instructions': {
      const ipath = `${homedir()}/.sysai/instructions.md`
      if (!existsSync(ipath)) {
        writeFileSync(ipath, '# Machine-specific instructions for sysai\n', 'utf8')
      }
      const editor = process.env.VISUAL || process.env.EDITOR || 'vi'
      spawnSync(editor, [ipath], { stdio: 'inherit' })
      process.stdout.write(`${DIM}Instructions updated. Changes take effect on next query.${RESET}\n`)
      break
    }

    case '/model': {
      const { loadModels, switchActive } = await import('./models.js')
      const data = loadModels()
      const models = data?.models ?? []
      if (models.length === 0) {
        process.stdout.write(`${DIM}No models configured. Run: sysai setup${RESET}\n`)
        break
      }
      const targetName = args[0]
      if (targetName) {
        try {
          switchActive(targetName)
          process.stdout.write(`${GREEN}  ✓ Switched to ${BOLD}${targetName}${RESET}\n`)
        } catch (err) {
          process.stdout.write(`${RED}  ${err.message}${RESET}\n`)
        }
        break
      }
      // Interactive picker
      process.stdout.write('\n')
      for (let i = 0; i < models.length; i++) {
        const m = models[i]
        const active = m.name === data.active ? `  ${GREEN}← active${RESET}` : ''
        const modelId = m.model || `${DIM}${DEFAULTS[m.provider] ?? '?'}${RESET}`
        process.stdout.write(`  ${DIM}${i + 1})${RESET}  ${BOLD}${m.name}${RESET}  ${DIM}${m.provider}${RESET}  ${modelId}${active}\n`)
      }
      process.stdout.write('\n')
      const answer = await new Promise(resolve => rl.question(`${DIM}  Switch to (name or number, Enter to cancel): ${RESET}`, resolve))
      const trimmed = answer.trim()
      if (!trimmed) break
      const num = parseInt(trimmed)
      const name = (!isNaN(num) && num >= 1 && num <= models.length)
        ? models[num - 1].name : trimmed
      try {
        switchActive(name)
        process.stdout.write(`${GREEN}  ✓ Switched to ${BOLD}${name}${RESET} ${DIM}(takes effect on next query)${RESET}\n`)
      } catch (err) {
        process.stdout.write(`${RED}  ${err.message}${RESET}\n`)
      }
      break
    }

    case '/help':
      process.stdout.write([
        `${DIM}Commands:${RESET}`,
        '  /sessions      — list saved sessions',
        '  /resume N      — resume session N',
        '  /new           — start a fresh session',
        '  /delete N      — delete session N',
        '  /history       — show turns in current session',
        '  /clear         — clear current conversation',
        '  /compact       — summarise older turns to free up context',
        '  /status        — show token usage and session info',
        '  /model [name]  — switch active model',
        '  /instructions  — edit ~/.sysai/instructions.md',
        '  /exit          — quit',
        '  /help          — this message',
        '',
      ].join('\n'))
      break

    default:
      process.stdout.write(`${DIM}Unknown command: ${cmd}. Try /help.${RESET}\n`)
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function readLineOnce() {
  return new Promise(resolve => {
    const tmp = readline.createInterface({ input: process.stdin, output: process.stdout })
    tmp.once('line', (line) => { tmp.close(); resolve(line) })
  })
}

main().catch(err => {
  console.error('sysai server error:', err.message)
  process.exit(1)
})
