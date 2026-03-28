/**
 * render.ts — spinner, streaming markdown renderer, and write diff
 */
import { readFileSync, existsSync, writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from 'fs'
import { tmpdir } from 'os'
import { join }   from 'path'
import { spawnSync } from 'child_process'
import { RESET, BOLD, DIM, GREEN, RED, CYAN } from './colors.js'

export { RESET, BOLD, DIM }  // re-export for callers that import colors from render.ts

type WriteFn = (s: string) => void

const CLEAR_LINE = '\x1b[2K\r'
const FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']

// ── Spinner ───────────────────────────────────────────────────────────────────

export function createSpinner(writeFn: WriteFn) {
  let timer: ReturnType<typeof setInterval> | null = null
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

const DIFF_CAP = 40   // max lines shown

function showAllGreen(content: string, writeFn: WriteFn): void {
  const lines = content.split('\n')
  const show  = lines.slice(0, DIFF_CAP)
  for (const l of show) writeFn(`${GREEN}+ ${l}${RESET}`)
  if (lines.length > DIFF_CAP)
    writeFn(`${DIM}  … ${lines.length - DIFF_CAP} more lines${RESET}`)
}

export function renderWriteDiff(filePath: string, newContent: string, writeFn: WriteFn): void {
  if (!existsSync(filePath)) {
    showAllGreen(newContent, writeFn)
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

    if (r.status === null) {
      showAllGreen(newContent, writeFn)
      return
    }

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

// Detect bat once at startup — null means unavailable
let batAvailable: boolean | null = null
function hasBat(): boolean {
  if (batAvailable === null) {
    const r = spawnSync('bat', ['--version'], { encoding: 'utf8' })
    batAvailable = r.status === 0
  }
  return batAvailable
}

function highlightCode(code: string, lang: string): string {
  if (hasBat()) {
    const args = ['--color=always', '--paging=never', '--style=plain', '-']
    if (lang) args.push(`--language=${lang}`)
    const r = spawnSync('bat', args, { input: code, encoding: 'utf8' })
    if (r.status === 0 && r.stdout) return r.stdout.trimEnd()
  }
  // Fallback: grey background per line
  return code.split('\n').map(l => CODE_BG + l + RESET).join('\n')
}

export class StreamRenderer {
  #write: WriteFn
  #buf = ''          // token buffer (partial lines)
  #inCode = false
  #lang = ''
  #codeBuf: string[] = []   // lines accumulated inside a code block

  constructor(writeFn: WriteFn) { this.#write = writeFn }

  write(token: string): void {
    this.#buf += token
    let nl: number
    while ((nl = this.#buf.indexOf('\n')) !== -1) {
      this.#line(this.#buf.slice(0, nl))
      this.#write('\n')
      this.#buf = this.#buf.slice(nl + 1)
    }
  }

  flush(): void {
    if (this.#buf) {
      this.#line(this.#buf)
      this.#buf = ''
    }
    // Unclosed code block at end of stream — flush as plain grey
    if (this.#inCode && this.#codeBuf.length > 0) {
      this.#write(this.#codeBuf.map(l => CODE_BG + l + RESET).join('\n'))
      this.#codeBuf = []
    }
  }

  #line(line: string): void {
    const trimmed = line.trimStart()

    // Code fence open/close
    if (trimmed.startsWith('```')) {
      if (!this.#inCode) {
        // Opening fence — extract language hint
        this.#lang = trimmed.slice(3).trim().split(/\s/)[0] ?? ''
        this.#inCode = true
        this.#codeBuf = []
        // Print the fence line itself with grey background
        this.#write(CODE_BG + line + RESET)
      } else {
        // Closing fence — highlight and flush buffered code
        this.#inCode = false
        if (this.#codeBuf.length > 0) {
          const highlighted = highlightCode(this.#codeBuf.join('\n'), this.#lang)
          this.#write(highlighted)
          this.#write('\n')
        }
        this.#codeBuf = []
        this.#write(CODE_BG + line + RESET)
      }
      return
    }

    // Inside a code block — buffer lines for batch highlighting
    if (this.#inCode) {
      this.#codeBuf.push(line)
      return
    }

    // Normal markdown rendering
    let m: RegExpMatchArray | null
    if ((m = line.match(/^### (.+)/))) { this.#write(H2 + m[1] + RESET); return }
    if ((m = line.match(/^## (.+)/)))  { this.#write(H1 + m[1] + RESET); return }
    if ((m = line.match(/^# (.+)/)))   { this.#write('\n' + H1 + m[1] + RESET); return }

    line = line.replace(/^(\s*)[*-] /, (_, indent: string) => indent + `${DIM}•${RESET} `)
    line = line.replace(/\*\*([^*\n]+)\*\*/g, `${BOLD}$1${RESET}`)
    line = line.replace(/`([^`\n]+)`/g, `${CYAN}$1${RESET}`)

    this.#write(line)
  }
}
