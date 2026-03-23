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
import { buildContext }   from './context.js'
import { buildMessages, getSystemPrompt } from './prompt.js'
import { makeApproval, runAgentWithUI } from './run.js'
import {
  createSession, appendTurn, listSessions, loadSession,
  lastSession, deleteSession, migrateOldHistory, pruneHistory,
} from './history.js'
import { formatApiError } from './errors.js'

const CYAN   = '\x1b[36m'
const RESET  = '\x1b[0m'
const BOLD   = '\x1b[1m'
const DIM    = '\x1b[2m'
const YELLOW = '\x1b[33m'
const RED    = '\x1b[31m'
const GREEN  = '\x1b[32m'

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
        chatCmd,
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

  process.stdout.write(`${DIM}sysai — terminal assistant${RESET}\n`)
  process.stdout.write(`${DIM}Ctrl-C or /exit to quit  |  /sessions to browse  |  /help for commands${RESET}\n\n`)

  // Offer to resume last session
  const last = lastSession()
  if (last && last.turns > 0) {
    const when = new Date(last.ts).toLocaleString()
    const title = last.title ? `  "${last.title.slice(0, 60)}"` : ''
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
    try {
      const result = await runAgentWithUI({
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

    sessionHistory.push({ role: 'user',      content: messages[messages.length - 1].content })
    sessionHistory.push({ role: 'assistant',  content: fullResponse })

    const maxTurns = parseInt(process.env.SYSAI_MAX_TURNS || '20')
    if (sessionHistory.length > maxTurns * 2) sessionHistory = sessionHistory.slice(-(maxTurns * 2))

    if (fullResponse) {
      appendTurn(currentSession, { question, response: fullResponse })
    }

    rl.prompt()
  })

  rl.on('close', () => {
    process.stdout.write(`\n${DIM}sysai: session ended.${RESET}\n`)
    process.exit(0)
  })

  let activeAbort = null

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
      history.length = 0
      process.stdout.write(`${DIM}Conversation cleared.${RESET}\n`)
      break

    case '/new': {
      history.length = 0
      return buildContext().then(ctx => {
        const session = createSession(ctx.hostname)
        setSession([], session)
        process.stdout.write(`${DIM}Started new session.${RESET}\n`)
      })
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
      const sess    = getCurrentSession()
      const turns   = Math.floor(history.length / 2)
      const maxTurns = parseInt(process.env.SYSAI_MAX_TURNS || '20')
      const tokens  = Math.round(
        history.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 200), 0) / 4
      )
      const { existsSync: ex } = await import('fs')
      const { homedir: hd }    = await import('os')
      const hasInstr = ex(`${hd()}/.sysai/instructions.md`)
      process.stdout.write('\n')
      process.stdout.write(`  ${DIM}provider:${RESET}      ${process.env.SYSAI_PROVIDER || '?'}\n`)
      process.stdout.write(`  ${DIM}model:${RESET}         ${process.env.SYSAI_MODEL || '(default)'}\n`)
      process.stdout.write(`  ${DIM}turns:${RESET}         ${turns} / ${maxTurns}\n`)
      process.stdout.write(`  ${DIM}~tokens:${RESET}       ~${tokens.toLocaleString()}\n`)
      process.stdout.write(`  ${DIM}instructions:${RESET}  ${hasInstr ? '✓ loaded' : 'none'}\n`)
      process.stdout.write('\n')
      break
    }

    case '/compact': {
      const KEEP = 6
      if (history.length <= KEEP * 2) {
        process.stdout.write(`${DIM}Nothing to compact — only ${Math.floor(history.length / 2)} turns.${RESET}\n`)
        break
      }
      const older  = history.slice(0, history.length - KEEP * 2)
      const recent = history.slice(-KEEP * 2)
      process.stdout.write(`${DIM}  Summarising ${Math.floor(older.length / 2)} older turns…${RESET}`)
      try {
        const { generateText } = await import('ai')
        const { getModel }     = await import('./provider.js')
        const transcript = older.map(m =>
          `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 600) : '[tool output]'}`
        ).join('\n')
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
        setSession(summarised, getCurrentSession())
        process.stdout.write(`\r${GREEN}✓${RESET} Compacted to summary + last ${KEEP} turns.${' '.repeat(20)}\n`)
      } catch (err) {
        process.stdout.write(`\r${RED}Compact failed: ${formatApiError(err)}${RESET}\n`)
      }
      break
    }

    case '/instructions': {
      const { existsSync, writeFileSync } = await import('fs')
      const { spawnSync: sp } = await import('child_process')
      const { homedir } = await import('os')
      const ipath = `${homedir()}/.sysai/instructions.md`
      if (!existsSync(ipath)) {
        writeFileSync(ipath, '# Machine-specific instructions for sysai\n', 'utf8')
      }
      const editor = process.env.VISUAL || process.env.EDITOR || 'vi'
      sp(editor, [ipath], { stdio: 'inherit' })
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
      const DEFAULTS = { anthropic: 'claude-sonnet-4-6', openai: 'gpt-4o', llamacpp: 'local' }
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
