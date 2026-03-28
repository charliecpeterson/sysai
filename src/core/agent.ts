/**
 * agent.ts — agentic loop using Vercel AI SDK
 *
 * Tools: bash, read_file, write_file
 * Works with any provider (Anthropic, OpenAI, llama.cpp) via provider.ts
 */

import { streamText, generateText, tool } from 'ai'
import type { ModelMessage } from 'ai'
import { z }                 from 'zod'
import { spawn }             from 'child_process'
import { readFileSync, writeFileSync, statSync } from 'fs'
import { getModel }          from './provider.js'
import { DIM, YELLOW, RESET } from '../ui/colors.js'
import type { AgentOptions, AgentResult } from '../types.js'
import { searchKb, activeKbDescriptions, listKbFiles, getKbFilePath } from '../storage/kb.js'

const MAX_ITERATIONS   = parseInt(process.env.SYSAI_MAX_TURNS || '20')
const MAX_FILE_READ    = 20_000  // chars
const BASH_TIMEOUT_MS  = parseInt(process.env.SYSAI_BASH_TIMEOUT || '120') * 1000
const MAX_RETRIES      = 3
const RETRY_BASE_MS    = 1_000

const TOOLS = {
  bash: tool({
    description: `Run a shell command in the user's environment.
Use for anything: checking system state, reading logs, installing packages,
editing configs, running scripts. Output is shown to the user and returned to you.
The shell inherits the full environment (PATH, SSH context, env vars, etc.).`,
    inputSchema: z.object({
      command: z.string().describe('Shell command to run'),
    }),
  }),

  read_file: tool({
    description: `Read a file. Every response includes total line count so you can plan follow-up reads.
For large files, use offset + limit to read in chunks — start with the first chunk to understand structure,
then request specific sections based on what you find. Never assume truncated output contains everything relevant.`,
    inputSchema: z.object({
      path:   z.string().describe('Absolute or relative file path'),
      offset: z.number().optional().describe('Start line, 1-indexed (default: 1)'),
      limit:  z.number().optional().describe('Number of lines to read (default: all)'),
    }),
  }),

  write_file: tool({
    description: 'Write content to a file, creating or overwriting it.',
    inputSchema: z.object({
      path:    z.string().describe('File path to write'),
      content: z.string().describe('Content to write'),
    }),
  }),

  fetch_url: tool({
    description: `Fetch a URL and return its content as plain text.
Strips HTML tags, scripts, and styles — returns readable text.
Use for: documentation pages, API references, man pages, GitHub raw files, any web content.
For raw files (JSON, YAML, plain text), content is returned as-is.`,
    inputSchema: z.object({
      url: z.string().describe('URL to fetch'),
    }),
  }),

  github: tool({
    description: `Read files or list directories from public GitHub repositories.
Accepts GitHub URLs in any common format:
  https://github.com/owner/repo/blob/main/path/to/file.ts  → file content
  https://github.com/owner/repo/tree/main/src               → directory listing
  https://github.com/owner/repo                             → repo root + README
  owner/repo                                                → shorthand for root
Set GITHUB_TOKEN env var for higher rate limits (60 req/hr anonymous → 5000/hr).`,
    inputSchema: z.object({
      url: z.string().describe('GitHub URL or owner/repo[/path] shorthand'),
    }),
  }),

  web_search: tool({
    description: `Search the web and return full content from the top results.
Uses Jina Search — returns extracted page content, not just snippets.
Use for: current events, documentation, anything not in the knowledge base.
Set SYSAI_NO_JINA=1 to disable (web search will be unavailable).`,
    inputSchema: z.object({
      query: z.string().describe('Search query'),
    }),
  }),
}

/**
 * Run the agentic loop until the model stops with 'stop' or 'end_turn'.
 */
export async function runAgent({
  systemPrompt, messages, onToken, onToolApproval, onToolResult,
  onThinking, onThinkingDone, abortSignal, mcpManager, enableKbSearch,
}: AgentOptions): Promise<AgentResult> {
  const model   = getModel()
  const history = [...messages] as ModelMessage[]
  let fullText  = ''
  let iterations = 0

  // Build search_kb tool dynamically if KB search is enabled
  const kbTools = enableKbSearch ? buildKbSearchTools() : {}

  // Merge built-in tools with KB search and MCP tools
  const allTools = {
    ...TOOLS,
    ...kbTools,
    ...(mcpManager ? mcpManager.getAiSdkTools() as typeof TOOLS : {}),
  }

  while (iterations++ < MAX_ITERATIONS) {
    onThinking?.()
    let thinkingDone = false

    // Retry the API call on transient errors, but only before any tokens have
    // been emitted — mid-stream errors are rethrown to avoid duplicating output.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result!: ReturnType<typeof streamText<any, any>>
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1))
      result = streamText({
        model,
        system:    systemPrompt,
        messages:  history,
        tools:     allTools,
        maxOutputTokens: parseInt(process.env.SYSAI_MAX_TOKENS || '8192'),
        ...(abortSignal && { abortSignal }),
      })
      try {
        for await (const textChunk of result.textStream) {
          if (!textChunk) continue
          if (!thinkingDone) { thinkingDone = true; onThinkingDone?.() }
          fullText += textChunk
          onToken(textChunk)
        }
        break  // stream completed successfully
      } catch (err) {
        if (!thinkingDone && isRetryable(err) && attempt < MAX_RETRIES) continue
        if (!thinkingDone) onThinkingDone?.()
        throw err
      }
    }

    if (!thinkingDone) { thinkingDone = true; onThinkingDone?.() }

    const [finishReason, toolCalls, response] = await Promise.all([
      result.finishReason,
      result.toolCalls,
      result.response,
    ])

    // Strip SDK-internal extra fields (providerMetadata, title, etc.) that
    // Zod 4 strict mode rejects when messages are re-validated on the next turn.
    const normalized = response.messages.map(msg => {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) {
        return { role: msg.role, content: msg.content }
      }
      return {
        role: 'assistant',
        content: msg.content.map(part => {
          if (part.type === 'tool-call') {
            return {
              type: 'tool-call',
              toolCallId: part.toolCallId,
              toolName:   part.toolName,
              input:      part.input ?? (part as unknown as Record<string, unknown>)['args'],
            }
          }
          if (part.type === 'text') return { type: 'text', text: part.text }
          return part
        }),
      }
    })
    history.push(...(normalized as ModelMessage[]))

    if (finishReason === 'stop' || toolCalls.length === 0) {
      return { text: fullText, messages: history }
    }

    if (iterations >= MAX_ITERATIONS) {
      onToken(`\n${YELLOW}[sysai: max iterations reached]${RESET}\n`)
      return { text: fullText, messages: history }
    }

    const toolResultParts: unknown[] = []

    for (const call of toolCalls) {
      const decision = await onToolApproval(call)
      let resultContent: string

      if (decision === 'rejected') {
        resultContent = 'User rejected this tool call.'
      } else {
        const finalCall = (decision === 'approved' || call.toolName !== 'bash')
          ? call
          : { ...call, input: { command: decision } }

        const t0 = Date.now()
        resultContent = mcpManager?.hasTool(call.toolName)
          ? await mcpManager.callTool(call.toolName, parseToolArgs(finalCall.input ?? (finalCall as unknown as Record<string,unknown>).args))
          : await executeTool(finalCall as typeof call)
        onToolResult?.(finalCall, resultContent, Date.now() - t0)

        // If a bash command failed, append a directive so the AI retries rather
        // than stopping to explain the error. The [exit N] marker is easy to miss
        // at the end of long output without this nudge.
        if (call.toolName === 'bash' && /\[exit [^0]\d*\] \(command failed\)|\[killed:/.test(resultContent)) {
          resultContent += '\n\n[Command failed — diagnose the error above and try a corrected approach. Do not give up after one failure.]'
        }
      }

      toolResultParts.push({
        type:       'tool-result',
        toolCallId: call.toolCallId,
        toolName:   call.toolName,
        output:     { type: 'text', value: String(resultContent) },
      })
    }

    history.push({ role: 'tool', content: toolResultParts } as unknown as ModelMessage)
  }

  return { text: fullText, messages: history }
}

// ── tool execution ────────────────────────────────────────────────────────────

export function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return {} }
  }
  return (raw as Record<string, unknown>) ?? {}
}

async function executeTool(call: { toolName: string; input?: unknown; args?: unknown }): Promise<string> {  // eslint-disable-line @typescript-eslint/require-await
  const args = parseToolArgs(call.input ?? call.args)

  switch (call.toolName) {
    case 'bash':
      if (!args.command) return 'Error: no command provided'
      return executeBash(args.command as string)

    case 'read_file': {
      if (!args.path) return 'Error: no path provided'
      try {
        const MAX_READ_BYTES = 10 * 1024 * 1024  // 10 MB
        const stat = statSync(args.path as string)
        if (stat.size > MAX_READ_BYTES) {
          return `Error: file is ${(stat.size / 1024 / 1024).toFixed(1)} MB — too large to read directly. Use bash with tail/grep/awk to read specific sections.`
        }
        const content = readFileSync(args.path as string, 'utf8')
        const allLines = content.split('\n')
        const totalLines = allLines.length

        const start  = Math.max(0, ((args.offset as number) ?? 1) - 1)
        const count  = (args.limit as number) ?? totalLines
        const slice  = allLines.slice(start, start + count)
        const end    = start + slice.length

        const header = `[${args.path} — lines ${start + 1}–${end} of ${totalLines.toLocaleString()} total]`
        const body   = slice.join('\n')

        const combined = header + '\n' + body
        if (combined.length > MAX_FILE_READ) {
          const half = MAX_FILE_READ / 2
          return (
            combined.slice(0, half) +
            `\n\n[... chunk too large, ${(combined.length - MAX_FILE_READ).toLocaleString()} chars omitted — use a smaller limit ...]\n\n` +
            combined.slice(-half)
          )
        }
        return combined
      } catch (err) {
        return `Error: ${(err as Error).message}`
      }
    }

    case 'write_file': {
      if (!args.path) return 'Error: no path provided'
      try {
        writeFileSync(args.path as string, (args.content as string) ?? '', 'utf8')
        return `Written: ${args.path}`
      } catch (err) {
        return `Error: ${(err as Error).message}`
      }
    }

    case 'fetch_url': {
      if (!args.url) return 'Error: no URL provided'
      return fetchUrl(args.url as string)
    }

    case 'github': {
      if (!args.url) return 'Error: no URL provided'
      return githubRead(args.url as string)
    }

    case 'web_search': {
      if (!args.query) return 'Error: no query provided'
      return webSearch(args.query as string)
    }

    case 'search_kb': {
      if (!args.query) return 'Error: no query provided'
      const originalQuery = args.query as string
      const limit = (args.limit as number) ?? 8
      const kbFilter = args.kb as string | undefined

      // Query expansion: generate 2 alternative phrasings silently
      const expandedQueries = [originalQuery]
      try {
        const model = getModel()
        const { text } = await generateText({
          model,
          prompt: `Given this search query for a knowledge base, write 2 alternative phrasings that might find different relevant results. Return only the 2 alternatives, one per line, no numbering or explanation.\n\nQuery: ${originalQuery}`,
          maxOutputTokens: 60,
        })
        const alts = text.trim().split('\n').map(l => l.trim()).filter(Boolean).slice(0, 2)
        expandedQueries.push(...alts)
      } catch {
        // silently fall back to original query only
      }

      // Search all queries and merge by best score per chunk
      const seen = new Map<string, { score: number; r: Awaited<ReturnType<typeof searchKb>>[0] }>()
      for (const q of expandedQueries) {
        const results = await searchKb(q, { limit, kb: kbFilter })
        for (const r of results) {
          const key = `${r.kb}::${r.file}::${r.text.slice(0, 80)}`
          const existing = seen.get(key)
          if (!existing || r.score > existing.score) seen.set(key, { score: r.score, r })
        }
      }

      const merged = [...seen.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ r }) => r)

      if (merged.length === 0) return 'No results found. Try different keywords or use list_kb_files to browse available documents.'
      return merged.map(r => {
        const file = r.file.replace(/.*\/kb\/[^/]+\/docs\//, '')
        return `[${r.kb}] ${file} (score ${r.score.toFixed(2)}):\n${r.text}`
      }).join('\n\n---\n\n')
    }

    case 'list_kb_files': {
      const files = listKbFiles(args.kb as string | undefined)
      if (files.length === 0) return 'No files found in active knowledge bases.'
      const lines = files.map(f => {
        const size = f.size < 1024 ? `${f.size}B`
          : f.size < 1024 * 1024 ? `${(f.size / 1024).toFixed(1)}K`
          : `${(f.size / (1024 * 1024)).toFixed(1)}M`
        const fullPath = getKbFilePath(f.kb, f.file) ?? ''
        return `[${f.kb}] ${f.file}  (${size})  ${fullPath}`
      })
      return `${files.length} files:\n${lines.join('\n')}`
    }

    default:
      return `Unknown tool: ${call.toolName}`
  }
}

const MAX_FETCH_CHARS  = 50_000  // ~12k tokens — enough for most docs pages
const JINA_BASE        = 'https://r.jina.ai/'
const JINA_SEARCH_BASE = 'https://s.jina.ai/'

async function webSearch(query: string): Promise<string> {
  if (process.env.SYSAI_NO_JINA) {
    return 'Web search is disabled (SYSAI_NO_JINA=1). Unset it to enable Jina-powered search.'
  }

  const url = `${JINA_SEARCH_BASE}?q=${encodeURIComponent(query)}`
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'sysai/1.0 (terminal AI assistant)',
        'Accept': 'text/plain',
        'X-Return-Format': 'markdown',
      },
      signal: AbortSignal.timeout(25_000),
    })
    if (!res.ok) return `Search error: HTTP ${res.status} ${res.statusText}`
    const body = await res.text()
    const truncated = body.length > MAX_FETCH_CHARS
      ? body.slice(0, MAX_FETCH_CHARS) + `\n\n[... truncated at ${MAX_FETCH_CHARS} chars — ${body.length} total]`
      : body
    return truncated
  } catch (err) {
    return `Search error: ${(err as Error).message}`
  }
}
const GH_API          = 'https://api.github.com'
const GH_RAW          = 'https://raw.githubusercontent.com'

/**
 * Parse a GitHub URL or shorthand into { owner, repo, ref, path, type }.
 * type: 'file' | 'dir' | 'root' | 'unknown'
 */
function parseGithubUrl(input: string): {
  owner: string; repo: string; ref: string; path: string; type: 'file' | 'dir' | 'root'
} | null {
  // Normalise: strip protocol and www
  let s = input.trim().replace(/^https?:\/\/(www\.)?/, '')

  // raw.githubusercontent.com/owner/repo/ref/path → file
  if (s.startsWith('raw.githubusercontent.com/')) {
    const parts = s.slice('raw.githubusercontent.com/'.length).split('/')
    if (parts.length < 3) return null
    const [owner, repo, ref, ...rest] = parts
    return { owner, repo, ref, path: rest.join('/'), type: 'file' }
  }

  // github.com/owner/repo[/blob|tree/ref/path]
  if (s.startsWith('github.com/')) {
    s = s.slice('github.com/'.length)
  }

  const parts = s.split('/')
  if (parts.length < 2) return null
  const [owner, repo, verb, ref, ...rest] = parts

  if (!verb)        return { owner, repo, ref: 'HEAD', path: '', type: 'root' }
  if (verb === 'blob') return { owner, repo, ref: ref ?? 'HEAD', path: rest.join('/'), type: 'file' }
  if (verb === 'tree') return { owner, repo, ref: ref ?? 'HEAD', path: rest.join('/'), type: 'dir'  }

  // shorthand: owner/repo/path — treat as file attempt
  return { owner, repo, ref: 'HEAD', path: [verb, ref, ...rest].filter(Boolean).join('/'), type: 'file' }
}

async function githubRead(input: string): Promise<string> {
  const parsed = parseGithubUrl(input)
  if (!parsed) return `Error: could not parse GitHub URL: ${input}`

  const { owner, repo, ref, path, type } = parsed
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'sysai/1.0',
  }
  if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`

  // File: fetch raw content directly
  if (type === 'file' && path) {
    const rawUrl = `${GH_RAW}/${owner}/${repo}/${ref}/${path}`
    try {
      const res = await fetch(rawUrl, { headers: { 'User-Agent': 'sysai/1.0' }, signal: AbortSignal.timeout(15_000) })
      if (!res.ok) return `Error: HTTP ${res.status} fetching ${rawUrl}`
      const body = await res.text()
      const truncated = body.length > MAX_FETCH_CHARS
        ? body.slice(0, MAX_FETCH_CHARS) + `\n\n[... truncated — ${body.length} chars total]`
        : body
      return `[${owner}/${repo}  ${path}  (${ref})]\n\n${truncated}`
    } catch (err) {
      return `Error: ${(err as Error).message}`
    }
  }

  // Directory or root: use Contents API
  const apiPath = path ? `/repos/${owner}/${repo}/contents/${path}` : `/repos/${owner}/${repo}/contents`
  const apiUrl  = `${GH_API}${apiPath}${ref !== 'HEAD' ? `?ref=${ref}` : ''}`

  try {
    const res = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return `Error: HTTP ${res.status} — ${body.slice(0, 200)}`
    }

    const data = await res.json() as unknown

    // Single file returned (API returns object, not array)
    if (!Array.isArray(data)) {
      const f = data as { type: string; content?: string; encoding?: string; download_url?: string }
      if (f.type === 'file' && f.content && f.encoding === 'base64') {
        const text = Buffer.from(f.content.replace(/\n/g, ''), 'base64').toString('utf8')
        const truncated = text.length > MAX_FETCH_CHARS
          ? text.slice(0, MAX_FETCH_CHARS) + `\n\n[... truncated — ${text.length} chars total]`
          : text
        return `[${owner}/${repo}  ${path}  (${ref})]\n\n${truncated}`
      }
      return `Error: unexpected response from GitHub API`
    }

    // Directory listing
    const entries = (data as Array<{ name: string; type: string; size: number }>)
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .map(e => {
        const icon = e.type === 'dir' ? '📁' : '📄'
        const size = e.type === 'file' ? `  (${e.size < 1024 ? e.size + 'B' : (e.size / 1024).toFixed(1) + 'K'})` : ''
        return `${icon} ${e.name}${size}`
      })

    const location = path ? `${owner}/${repo}/${path}` : `${owner}/${repo}`
    let result = `[${location}  (${ref})]\n\n${entries.join('\n')}`

    // For root, also fetch README if present
    if (type === 'root') {
      const readmeEntry = (data as Array<{ name: string; download_url: string | null }>)
        .find(e => /^readme(\.(md|txt|rst))?$/i.test(e.name))
      if (readmeEntry?.download_url) {
        try {
          const rr = await fetch(readmeEntry.download_url, { signal: AbortSignal.timeout(10_000) })
          if (rr.ok) {
            const readme = await rr.text()
            const preview = readme.length > 3000 ? readme.slice(0, 3000) + '\n\n[... README truncated]' : readme
            result += `\n\n---\n\n${preview}`
          }
        } catch {}
      }
    }

    return result
  } catch (err) {
    return `Error: ${(err as Error).message}`
  }
}

async function fetchUrl(url: string): Promise<string> {
  // Probe content type with a direct HEAD request first (fast, no body)
  let contentType = ''
  try {
    const head = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'sysai/1.0 (terminal AI assistant)' },
      signal: AbortSignal.timeout(8_000),
    })
    contentType = head.headers.get('content-type') ?? ''
  } catch {
    // HEAD not supported or timed out — fall through to GET and detect from response
  }

  const isHtml = contentType.includes('text/html') || contentType === ''

  // HTML pages: route through Jina Reader for clean markdown extraction
  // unless SYSAI_NO_JINA=1 (air-gapped environments or privacy preference)
  if (isHtml && !process.env.SYSAI_NO_JINA) {
    try {
      const res = await fetch(`${JINA_BASE}${url}`, {
        headers: { 'User-Agent': 'sysai/1.0 (terminal AI assistant)', 'Accept': 'text/plain' },
        signal: AbortSignal.timeout(20_000),
      })
      if (res.ok) {
        const body = await res.text()
        const truncated = body.length > MAX_FETCH_CHARS
          ? body.slice(0, MAX_FETCH_CHARS) + `\n\n[... truncated at ${MAX_FETCH_CHARS} chars — ${body.length} total]`
          : body
        return `[${url}]\n\n${truncated}`
      }
    } catch {
      // Jina unavailable — fall through to direct fetch
    }
  }

  // Direct fetch: plain text, JSON, YAML, raw files — or Jina fallback
  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'sysai/1.0 (terminal AI assistant)' },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    return `Error fetching ${url}: ${(err as Error).message}`
  }

  if (!res.ok) return `Error: HTTP ${res.status} ${res.statusText} — ${url}`

  const body = await res.text()
  const detectedType = res.headers.get('content-type') ?? ''

  // HTML fallback (Jina was disabled or failed): regex-strip
  if (detectedType.includes('text/html')) {
    const text = stripHtml(body)
    const truncated = text.length > MAX_FETCH_CHARS
      ? text.slice(0, MAX_FETCH_CHARS) + `\n\n[... truncated at ${MAX_FETCH_CHARS} chars — ${text.length} total]`
      : text
    return `[${url}]\n\n${truncated}`
  }

  const truncated = body.length > MAX_FETCH_CHARS
    ? body.slice(0, MAX_FETCH_CHARS) + `\n\n[... truncated at ${MAX_FETCH_CHARS} chars — ${body.length} total]`
    : body
  return `[${url}]\n\n${truncated}`
}

function stripHtml(html: string): string {
  // Remove script, style, and nav blocks entirely
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')

  // Block-level elements → newlines
  text = text
    .replace(/<\/?(p|div|section|article|h[1-6]|li|tr|blockquote|pre)[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(ul|ol|table|thead|tbody)[^>]*>/gi, '\n')

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '')

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))

  // Collapse whitespace
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const MAX_DISPLAY_LINES = 10
const MAX_BASH_OUTPUT   = 20_000   // chars sent to AI

function executeBash(command: string): Promise<string> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || 'bash'
    const proc = spawn(shell, ['-c', command], {
      env: process.env,
      cwd: process.cwd(),
    })

    let output = ''
    let killed = false
    proc.stdout.on('data', (data: Buffer) => { output += data.toString() })
    proc.stderr.on('data', (data: Buffer) => { output += data.toString() })

    const timer = setTimeout(() => {
      killed = true
      proc.kill('SIGTERM')
      setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 3000)
    }, BASH_TIMEOUT_MS)

    proc.on('close', (code: number | null) => {
      clearTimeout(timer)
      const tail = killed
        ? `\n[killed: exceeded ${BASH_TIMEOUT_MS / 1000}s timeout]`
        : (code !== 0 ? `\n[exit ${code}] (command failed)` : '')
      const full = (output + tail).trim() || '(no output)'

      if (process.stdout.isTTY) {
        const lines = full.split('\n')
        if (lines.length <= MAX_DISPLAY_LINES) {
          process.stdout.write(full + '\n')
        } else {
          process.stdout.write(lines.slice(0, MAX_DISPLAY_LINES).join('\n') + '\n')
          process.stdout.write(`${DIM}  … ${lines.length - MAX_DISPLAY_LINES} more lines${RESET}\n`)
        }
      }

      if (full.length > MAX_BASH_OUTPUT) {
        const half = MAX_BASH_OUTPUT / 2
        resolve(
          full.slice(0, half) +
          `\n\n[... ${(full.length - MAX_BASH_OUTPUT).toLocaleString()} chars omitted — use grep/tail/awk for targeted output ...]\n\n` +
          full.slice(-half)
        )
      } else {
        resolve(full)
      }
    })

    proc.on('error', (err: Error) => { clearTimeout(timer); resolve(`Error: ${err.message}`) })
  })
}

// ── KB search tool builder ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildKbSearchTools(): Record<string, any> {
  const descs = activeKbDescriptions()
  const kbList = descs.map(d => `  - ${d.name}: ${d.description}`).join('\n')

  return {
    search_kb: tool({
      description: `Search active knowledge bases using keyword search. Returns the most relevant text chunks.
Use this to find specific information. Try multiple searches with different keywords if the first results aren't sufficient.
For example, if asked "how much are compute nodes", try queries like "compute node price cost", "purchasing nodes", etc.

Active knowledge bases:
${kbList}`,
      inputSchema: z.object({
        query: z.string().describe('Keyword search query — use specific, varied terms for best results'),
        limit: z.number().optional().describe('Max results to return (default 8)'),
        kb:    z.string().optional().describe('Target a specific KB by name (searches all active KBs if omitted)'),
      }),
    }),

    list_kb_files: tool({
      description: `List all files in active knowledge bases. Shows file names, sizes, and which KB they belong to.
Use this to browse what documents are available before searching. File names often reveal what topics are covered.
After spotting a relevant file, you can use read_file to read it directly (prefix path with ~/.sysai/kb/<kb-name>/docs/).

Active knowledge bases:
${kbList}`,
      inputSchema: z.object({
        kb: z.string().optional().describe('List files from a specific KB only (lists all active KBs if omitted)'),
      }),
    }),
  }
}

// ── retry helpers ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  // HTTP status codes from AI SDK errors
  const status = (err as unknown as Record<string, unknown>)['status'] as number | undefined
  if (status === 429 || status === 529 || status === 500 || status === 503) return true
  // Network-level errors
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') return true
  return false
}
