/**
 * render.js — spinner, streaming markdown renderer, and write diff
 */
import { readFileSync, existsSync, writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from 'fs'
import { tmpdir } from 'os'
import { join }   from 'path'
import { spawnSync } from 'child_process'

export const RESET = '\x1b[0m'
export const BOLD  = '\x1b[1m'
export const DIM   = '\x1b[2m'

const CLEAR_LINE = '\x1b[2K\r'
const FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']

// ── Spinner ───────────────────────────────────────────────────────────────────

export function createSpinner(writeFn) {
  let timer = null
  let frame = 0
  let startedAt = 0

  function tick() {
    const s = ((Date.now() - startedAt) / 1000).toFixed(1)
    writeFn(`${CLEAR_LINE}${DIM}${FRAMES[frame++ % FRAMES.length]}  thinking… ${s}s${RESET}`)
  }

  return {
    start() {
      if (timer) return
      frame = 0
      startedAt = Date.now()
      tick()
      timer = setInterval(tick, 80)
    },
    stop() {
      if (!timer) return
      clearInterval(timer)
      timer = null
      writeFn(CLEAR_LINE)
    },
  }
}

// ── Write diff ────────────────────────────────────────────────────────────────

const GREEN = '\x1b[32m'
const RED   = '\x1b[31m'
const CYAN  = '\x1b[36m'

const DIFF_CAP = 40   // max lines shown

export function renderWriteDiff(filePath, newContent, writeFn) {
  if (!existsSync(filePath)) {
    // New file — show content with green + prefix
    const lines = newContent.split('\n')
    const show = lines.slice(0, DIFF_CAP)
    for (const l of show) writeFn(`${GREEN}+ ${l}${RESET}`)
    if (lines.length > DIFF_CAP)
      writeFn(`${DIM}  … ${lines.length - DIFF_CAP} more lines${RESET}`)
    return
  }

  const tmpDir  = mkdtempSync(join(tmpdir(), 'sysai-'))
  const oldFile = join(tmpDir, 'old')
  const newFile = join(tmpDir, 'new')
  try {
    writeFileSync(oldFile, readFileSync(filePath, 'utf8'))
    writeFileSync(newFile, newContent)
    const r = spawnSync('diff', ['-u', '--label', filePath, '--label', filePath, oldFile, newFile],
      { encoding: 'utf8' })
    const raw = r.stdout || ''
    if (!raw.trim()) {
      writeFn(`${DIM}  (no changes)${RESET}`)
      return
    }
    const lines = raw.split('\n')
      .filter(l => !l.startsWith('--- ') && !l.startsWith('+++ '))
    const show = lines.slice(0, DIFF_CAP)
    for (const l of show) {
      if (l.startsWith('+'))      writeFn(GREEN + l + RESET)
      else if (l.startsWith('-')) writeFn(RED   + l + RESET)
      else if (l.startsWith('@')) writeFn(CYAN  + l + RESET)
      else                        writeFn(DIM   + l + RESET)
    }
    if (lines.length > DIFF_CAP)
      writeFn(`${DIM}  … ${lines.length - DIFF_CAP} more lines${RESET}`)
  } finally {
    try { unlinkSync(oldFile) } catch {}
    try { unlinkSync(newFile) } catch {}
    try { rmdirSync(tmpDir)   } catch {}
  }
}

// ── StreamRenderer ────────────────────────────────────────────────────────────

const H1      = '\x1b[1;4m'
const H2      = '\x1b[1m'
const CODE_BG = '\x1b[48;5;236m\x1b[38;5;252m'

export class StreamRenderer {
  #write
  #buf = ''
  #inCode = false

  constructor(writeFn) { this.#write = writeFn }

  write(token) {
    this.#buf += token
    let nl
    while ((nl = this.#buf.indexOf('\n')) !== -1) {
      this.#line(this.#buf.slice(0, nl))
      this.#write('\n')
      this.#buf = this.#buf.slice(nl + 1)
    }
  }

  flush() {
    if (this.#buf) { this.#line(this.#buf); this.#buf = '' }
  }

  #line(line) {
    if (line.trimStart().startsWith('```')) {
      this.#inCode = !this.#inCode
      this.#write((this.#inCode ? CODE_BG : CODE_BG) + line + RESET)
      return
    }
    if (this.#inCode) { this.#write(CODE_BG + line + RESET); return }

    // headings
    let m
    if ((m = line.match(/^### (.+)/))) { this.#write(H2 + m[1] + RESET); return }
    if ((m = line.match(/^## (.+)/)))  { this.#write(H1 + m[1] + RESET); return }
    if ((m = line.match(/^# (.+)/)))   { this.#write('\n' + H1 + m[1] + RESET); return }

    // bullets
    line = line.replace(/^(\s*)[*-] /, (_, indent) => indent + `${DIM}•${RESET} `)

    // inline bold, code
    line = line.replace(/\*\*([^*\n]+)\*\*/g, `${BOLD}$1${RESET}`)
    line = line.replace(/`([^`\n]+)`/g, `${CYAN}$1${RESET}`)

    this.#write(line)
  }
}
