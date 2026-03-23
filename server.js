#!/usr/bin/env node
/**
 * server.js — interactive agentic REPL
 *
 * Started by ai-pane. Maintains conversation history in memory.
 * The agent can run bash commands, read files, and write files —
 * all with user approval before execution.
 */

import readline  from 'readline'
import { buildContext }   from './context.js'
import { buildMessages, SYSTEM_PROMPT } from './prompt.js'
import { runAgent }       from './agent.js'
import {
  createSession, appendTurn, listSessions, loadSession,
  lastSession, deleteSession, migrateOldHistory, pruneHistory,
} from './history.js'

const CYAN   = '\x1b[36m'
const RESET  = '\x1b[0m'
const DIM    = '\x1b[2m'
const YELLOW = '\x1b[33m'
const RED    = '\x1b[31m'
const GREEN  = '\x1b[32m'

async function main() {
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

    let fullResponse = ''
    try {
      const result = await runAgent({
        systemPrompt: SYSTEM_PROMPT,
        messages,
        onToken: (token) => process.stdout.write(token),
        onToolApproval: (toolUse) => askApproval(toolUse, rl),
      })
      fullResponse = result.text
    } catch (err) {
      process.stdout.write(`\n${RED}sysai error: ${err.message}${RESET}\n`)
    }

    process.stdout.write('\n\n')

    sessionHistory.push({ role: 'user',      content: messages[messages.length - 1].content })
    sessionHistory.push({ role: 'assistant',  content: fullResponse })

    // Keep last 20 turns in memory
    if (sessionHistory.length > 40) sessionHistory = sessionHistory.slice(-40)

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
    process.stdout.write(`\n${DIM}sysai: use /exit or Ctrl-D to quit.${RESET}\n`)
    rl.prompt()
  })
}

// ── tool approval prompt ──────────────────────────────────────────────────────

function askApproval(toolUse, rl) {
  return new Promise((resolve) => {
    const name = toolUse.toolName
    const raw = toolUse.input ?? toolUse.args
    const args = typeof raw === 'string'
      ? (() => { try { return JSON.parse(raw) } catch { return {} } })()
      : (raw ?? {})

    // Auto-approve reads — no harm
    if (name === 'read_file') {
      process.stdout.write(`\n${DIM}  read: ${args.path ?? '?'}${RESET}\n`)
      return resolve('approved')
    }

    process.stdout.write('\n')

    if (name === 'bash') {
      process.stdout.write(`${YELLOW}  ⚡ bash${RESET}  ${args.command}\n`)
      rl.question(`${DIM}  run? [Y/n/e(dit)]: ${RESET}`, (answer) => {
        const a = answer.trim().toLowerCase()
        if (a === 'n' || a === 'no') return resolve('rejected')
        if (a === 'e' || a === 'edit') {
          rl.question(`${DIM}  edit: ${RESET}`, (edited) => {
            resolve(edited.trim() || 'rejected')
          })
          return
        }
        resolve('approved')
      })
      return
    }

    if (name === 'write_file') {
      process.stdout.write(`${RED}  ✎ write${RESET}  ${args.path}\n`)
      rl.question(`${DIM}  write? [Y/n]: ${RESET}`, (answer) => {
        const a = answer.trim().toLowerCase()
        resolve(a === 'n' || a === 'no' ? 'rejected' : 'approved')
      })
      return
    }

    // Unknown tool — approve by default
    resolve('approved')
  })
}

// ── slash commands ────────────────────────────────────────────────────────────

function handleCommand(input, history, rl, { getCurrentSession, setSession }) {
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

    case '/help':
      process.stdout.write([
        `${DIM}Commands:${RESET}`,
        '  /sessions    — list saved sessions',
        '  /resume N    — resume session N',
        '  /new         — start a fresh session',
        '  /delete N    — delete session N',
        '  /history     — show turns in current session',
        '  /clear       — clear current conversation',
        '  /exit        — quit',
        '  /help        — this message',
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
