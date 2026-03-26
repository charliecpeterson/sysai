/**
 * history.js — session-based conversation history
 *
 * Each session is a separate JSONL file in ~/.sysai/history/.
 * First line is metadata (timestamp, hostname, title, turn count).
 * Subsequent lines are {role, content} message pairs.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync, unlinkSync, renameSync, mkdirSync, openSync, readSync, writeSync, closeSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const HISTORY_DIR  = join(homedir(), '.sysai', 'history')
const MAX_SESSIONS = 50   // keep at most this many session files
const MAX_TURNS    = 20   // turns to load when resuming

// Metadata is always the first line. We pad it to a fixed byte width so
// rewriteMeta can overwrite exactly those bytes in place without reading
// the rest of the file. 320 bytes fits any realistic metadata line:
// ts(30) + hostname(~50) + title(100) + turns(~3) + JSON overhead(~50) ≈ 233
const HEADER_SIZE = 320

/**
 * Create a new session. Returns a session object used by other functions.
 */
export function createSession(hostname = 'unknown') {
  ensureDir()
  const ts = new Date().toISOString()
  const safe = ts.replace(/[:.]/g, '-').slice(0, 19)  // 2026-03-23T14-30-00
  const file = join(HISTORY_DIR, `${safe}.jsonl`)

  const meta = { type: 'meta', ts, hostname, title: null, turns: 0 }
  const metaBuf = Buffer.from(JSON.stringify(meta), 'utf8')
  const padded  = Buffer.alloc(HEADER_SIZE + 1, 0x20)
  metaBuf.copy(padded, 0, 0, Math.min(metaBuf.length, HEADER_SIZE))
  padded[HEADER_SIZE] = 0x0A
  writeFileSync(file, padded)

  return { file, meta }
}

/**
 * Append a turn (user question + assistant response) to a session.
 * Updates the title (from first question) and turn count in metadata.
 */
export function appendTurn(session, { question, response }) {
  if (!session?.file) return

  try {
    // Append the exchange
    appendFileSync(session.file, JSON.stringify({ role: 'user', content: question }) + '\n', 'utf8')
    appendFileSync(session.file, JSON.stringify({ role: 'assistant', content: response }) + '\n', 'utf8')

    // Update metadata
    session.meta.turns++
    if (!session.meta.title) {
      session.meta.title = question.slice(0, 100)
    }

    // Rewrite first line with updated meta
    rewriteMeta(session)
  } catch {
    // Non-fatal
  }
}

/**
 * List all sessions, newest first.
 * Returns [{file, ts, hostname, title, turns}]
 */
export function listSessions() {
  ensureDir()
  try {
    const files = readdirSync(HISTORY_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
      .reverse()

    return files.map(f => {
      try {
        const filePath = join(HISTORY_DIR, f)
        const meta = JSON.parse(readFirstLine(filePath))
        return { file: filePath, ts: meta.ts, hostname: meta.hostname, title: meta.title, turns: meta.turns || 0 }
      } catch {
        return null
      }
    }).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Load a session's messages as a history array for the agent.
 * @param {string} filePath — path to session JSONL file
 * @param {number} n — max turns to load (from the end)
 * @returns {Array} [{role, content}]
 */
export function loadSession(filePath, n = MAX_TURNS) {
  try {
    const lines = readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean)
    // Skip first line (metadata), take message lines
    const messageLines = lines.slice(1)
    const recent = messageLines.slice(-(n * 2))  // 2 lines per turn (user + assistant)
    const messages = []

    for (const line of recent) {
      try {
        const entry = JSON.parse(line)
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
export function loadSessionMeta(filePath) {
  try {
    return JSON.parse(readFirstLine(filePath))
  } catch {
    return null
  }
}

/**
 * Overwrite a session file with a compacted message set.
 * Rewrites the entire file: header + simplified user/assistant pairs only.
 * Tool-call messages are dropped since they can't survive reload anyway.
 */
export function writeCompactedSession(session, messages) {
  if (!session?.file) return
  try {
    // Rebuild the file: header + one line per user/assistant message
    const meta = { ...session.meta }
    const metaBuf = Buffer.from(JSON.stringify(meta), 'utf8')
    const header  = Buffer.alloc(HEADER_SIZE + 1, 0x20)
    metaBuf.copy(header, 0, 0, Math.min(metaBuf.length, HEADER_SIZE))
    header[HEADER_SIZE] = 0x0A

    const msgLines = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => JSON.stringify({ role: m.role, content: typeof m.content === 'string' ? m.content : '[compacted]' }) + '\n')
      .join('')

    writeFileSync(session.file, Buffer.concat([header, Buffer.from(msgLines, 'utf8')]))
  } catch {
    // Non-fatal — in-memory compact still works
  }
}

/**
 * Delete a session file.
 */
export function deleteSession(filePath) {
  try {
    unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Get the most recent session (for the resume prompt).
 * Returns {file, ts, hostname, title, turns} or null.
 */
export function lastSession() {
  const sessions = listSessions()
  return sessions.length > 0 ? sessions[0] : null
}

/**
 * Prune old sessions if we're over the limit.
 */
export function pruneHistory() {
  const sessions = listSessions()
  if (sessions.length <= MAX_SESSIONS) return

  const toDelete = sessions.slice(MAX_SESSIONS)
  for (const s of toDelete) {
    try { unlinkSync(s.file) } catch {}
  }
}

// ── migration ────────────────────────────────────────────────────────────────

/**
 * Migrate old history.jsonl to session-based format (one-time).
 */
export function migrateOldHistory() {
  const oldPath = join(homedir(), '.sysai', 'history.jsonl')
  if (!existsSync(oldPath)) return

  ensureDir()
  try {
    const lines = readFileSync(oldPath, 'utf8').trim().split('\n').filter(Boolean)
    if (lines.length === 0) return

    // Group by rough time proximity (entries within 30 min = same session)
    let currentSession = null
    let lastTs = null

    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        const entryTs = new Date(entry.ts).getTime()

        // Start new session if >30 min gap or first entry
        if (!lastTs || entryTs - lastTs > 30 * 60 * 1000) {
          currentSession = createSession(entry.hostname || 'unknown')
          // Backdate the metadata
          currentSession.meta.ts = entry.ts
          rewriteMeta(currentSession)
        }

        if (entry.question && entry.response) {
          appendTurn(currentSession, { question: entry.question, response: entry.response })
        }

        lastTs = entryTs
      } catch {}
    }

    // Rename old file so we don't migrate again
    renameSync(oldPath, oldPath + '.migrated')
  } catch {}
}

// ── internal helpers ─────────────────────────────────────────────────────────

function ensureDir() {
  mkdirSync(HISTORY_DIR, { recursive: true })
}

// Read just the first line of a file without loading the whole thing into memory.
// Session metadata is always the first line; JSONL files can be many MB.
function readFirstLine(filePath) {
  const fd = openSync(filePath, 'r')
  try {
    // Read enough bytes to cover the padded header (HEADER_SIZE + newline + a small margin)
    const readSize = HEADER_SIZE + 64
    const buf = Buffer.alloc(readSize)
    const bytesRead = readSync(fd, buf, 0, readSize, 0)
    const chunk    = buf.toString('utf8', 0, bytesRead)
    const newlineIdx = chunk.indexOf('\n')
    return newlineIdx >= 0 ? chunk.slice(0, newlineIdx) : chunk
  } finally {
    closeSync(fd)
  }
}

function rewriteMeta(session) {
  try {
    // Work in bytes, not characters — non-ASCII (emoji, accented chars) can make
    // padEnd(HEADER_SIZE) produce more bytes than HEADER_SIZE, overwriting message data.
    const jsonBuf = Buffer.from(JSON.stringify(session.meta), 'utf8')
    // Allocate exactly HEADER_SIZE + 1 bytes (newline), filled with spaces
    const padded = Buffer.alloc(HEADER_SIZE + 1, 0x20)
    jsonBuf.copy(padded, 0, 0, Math.min(jsonBuf.length, HEADER_SIZE))
    padded[HEADER_SIZE] = 0x0A  // newline
    const fd = openSync(session.file, 'r+')
    try { writeSync(fd, padded, 0, padded.length, 0) }
    finally { closeSync(fd) }
  } catch {}
}
