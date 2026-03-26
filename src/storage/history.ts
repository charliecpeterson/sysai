/**
 * history.ts — session-based conversation history
 *
 * Each session is a separate JSONL file in ~/.sysai/history/.
 * First line: JSON metadata (timestamp, hostname, title, turn count).
 * Subsequent lines: {role, content} message pairs.
 *
 * Updating metadata rewrites the whole file — sessions are small and
 * bounded, so this is simpler and more robust than a fixed-size header.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync, unlinkSync, renameSync, mkdirSync, openSync, readSync, closeSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Session, SessionMeta, SessionSummary } from '../types.js'

const HISTORY_DIR  = join(homedir(), '.sysai', 'history')
const MAX_SESSIONS = 50   // keep at most this many session files
const MAX_TURNS    = 20   // turns to load when resuming

/**
 * Create a new session. Returns a session object used by other functions.
 */
export function createSession(hostname = 'unknown'): Session {
  ensureDir()
  const ts = new Date().toISOString()
  const safe = ts.replace(/[:.]/g, '-').slice(0, 19)  // 2026-03-23T14-30-00
  const file = join(HISTORY_DIR, `${safe}.jsonl`)

  const meta: SessionMeta = { ts, hostname, title: null, turns: 0 }
  writeFileSync(file, JSON.stringify(meta) + '\n', 'utf8')

  return { file, meta }
}

/**
 * Append a turn (user question + assistant response) to a session.
 * Updates the title (from first question) and turn count in metadata.
 */
export function appendTurn(session: Session, { question, response }: { question: string; response: string }): void {
  if (!session?.file) return

  try {
    appendFileSync(session.file, JSON.stringify({ role: 'user', content: question }) + '\n', 'utf8')
    appendFileSync(session.file, JSON.stringify({ role: 'assistant', content: response }) + '\n', 'utf8')

    session.meta.turns++
    if (!session.meta.title) {
      session.meta.title = question.slice(0, 100)
    }

    rewriteMeta(session)
  } catch {
    // Non-fatal
  }
}

/**
 * List all sessions, newest first.
 */
export function listSessions(): SessionSummary[] {
  ensureDir()
  try {
    const files = readdirSync(HISTORY_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
      .reverse()

    return files.map(f => {
      try {
        const filePath = join(HISTORY_DIR, f)
        const meta = JSON.parse(readFirstLine(filePath)) as SessionMeta
        return { file: filePath, ts: meta.ts, hostname: meta.hostname, title: meta.title, turns: meta.turns || 0 }
      } catch {
        return null
      }
    }).filter((s): s is SessionSummary => s !== null)
  } catch {
    return []
  }
}

/**
 * Load a session's messages as a history array for the agent.
 */
export function loadSession(filePath: string, n = MAX_TURNS): unknown[] {
  try {
    const lines = readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean)
    const messageLines = lines.slice(1)
    const recent = messageLines.slice(-(n * 2))  // 2 lines per turn (user + assistant)
    const messages: unknown[] = []

    for (const line of recent) {
      try {
        const entry = JSON.parse(line) as { role: string; content: string }
        if (entry.role && entry.content) {
          messages.push({ role: entry.role, content: entry.content })
        }
      } catch {}
    }

    return messages
  } catch {
    return []
  }
}

/**
 * Load session metadata from a file path.
 */
export function loadSessionMeta(filePath: string): SessionMeta | null {
  try {
    return JSON.parse(readFirstLine(filePath)) as SessionMeta
  } catch {
    return null
  }
}

/**
 * Overwrite a session file with a compacted message set.
 * Tool-call messages are dropped since they can't survive reload anyway.
 */
export function writeCompactedSession(session: Session, messages: unknown[]): void {
  if (!session?.file) return
  try {
    const msgLines = (messages as Array<{ role: string; content: unknown }>)
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => JSON.stringify({ role: m.role, content: typeof m.content === 'string' ? m.content : '[compacted]' }) + '\n')
      .join('')

    writeFileSync(session.file, JSON.stringify(session.meta) + '\n' + msgLines, 'utf8')
  } catch {
    // Non-fatal — in-memory compact still works
  }
}

export function deleteSession(filePath: string): boolean {
  try {
    unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}

export function lastSession(): SessionSummary | null {
  const sessions = listSessions()
  return sessions.length > 0 ? sessions[0] : null
}

export function pruneHistory(): void {
  const sessions = listSessions()
  if (sessions.length <= MAX_SESSIONS) return
  const toDelete = sessions.slice(MAX_SESSIONS)
  for (const s of toDelete) {
    try { unlinkSync(s.file) } catch {}
  }
}

// ── migration ────────────────────────────────────────────────────────────────

export function migrateOldHistory(): void {
  const oldPath = join(homedir(), '.sysai', 'history.jsonl')
  if (!existsSync(oldPath)) return

  ensureDir()
  try {
    const lines = readFileSync(oldPath, 'utf8').trim().split('\n').filter(Boolean)
    if (lines.length === 0) return

    let currentSession: Session | null = null
    let lastTs: number | null = null

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { ts: string; hostname?: string; question?: string; response?: string }
        const entryTs = new Date(entry.ts).getTime()

        if (!lastTs || entryTs - lastTs > 30 * 60 * 1000) {
          currentSession = createSession(entry.hostname || 'unknown')
          currentSession.meta.ts = entry.ts
          rewriteMeta(currentSession)
        }

        if (entry.question && entry.response && currentSession) {
          appendTurn(currentSession, { question: entry.question, response: entry.response })
        }

        lastTs = entryTs
      } catch {}
    }

    renameSync(oldPath, oldPath + '.migrated')
  } catch {}
}

// ── internal helpers ──────────────────────────────────────────────────────────

function ensureDir(): void {
  mkdirSync(HISTORY_DIR, { recursive: true })
}

/**
 * Read the first line of a file efficiently without loading the whole file.
 */
function readFirstLine(filePath: string): string {
  const fd = openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(512)
    const bytesRead = readSync(fd, buf, 0, 512, 0)
    const chunk = buf.toString('utf8', 0, bytesRead)
    const newlineIdx = chunk.indexOf('\n')
    return newlineIdx >= 0 ? chunk.slice(0, newlineIdx) : chunk
  } finally {
    closeSync(fd)
  }
}

/**
 * Rewrite the metadata first line, preserving all message lines after it.
 */
function rewriteMeta(session: Session): void {
  try {
    const content = readFileSync(session.file, 'utf8')
    const newlineIdx = content.indexOf('\n')
    const rest = newlineIdx >= 0 ? content.slice(newlineIdx + 1) : ''
    writeFileSync(session.file, JSON.stringify(session.meta) + '\n' + rest, 'utf8')
  } catch {}
}
