/**
 * task.ts — task file parsing, listing, and execution
 *
 * Tasks live at ~/.sysai/tasks/<name>.md
 * Format: YAML frontmatter (description, model, auto_run) + prompt body
 */

import { readFileSync, existsSync, readdirSync, createReadStream, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join, resolve, sep } from 'path'
import { spawnSync } from 'child_process'
import { createInterface } from 'readline'
import { load as loadYaml } from 'js-yaml'
import { parseToolArgs, runAgent } from '../core/agent.js'
import { buildContext } from '../env/context.js'
import { buildMessages, getSystemPrompt } from '../core/prompt.js'
import { makeApproval, runAgentWithUI } from '../ui/approval.js'
import { createSpinner, StreamRenderer } from '../ui/render.js'
import { formatApiError } from '../ui/errors.js'
import { RESET, BOLD, DIM, RED, GREEN, YELLOW, CYAN } from '../ui/colors.js'
import type { Task, ToolDecision, ModelMessage } from '../types.js'

export const TASKS_DIR = join(homedir(), '.sysai', 'tasks')

/**
 * Resolve a task name to its file path and verify it stays inside TASKS_DIR.
 * Returns null if the name contains path traversal (e.g. '../../etc/passwd').
 */
function safeTaskPath(name: string): string | null {
  const resolved = resolve(join(TASKS_DIR, `${name}.md`))
  return resolved.startsWith(TASKS_DIR + sep) ? resolved : null
}

/**
 * Parse a task markdown file.
 * Returns { name, description, model, auto_run, prompt }
 */
export function parseTask(content: string, name = ''): Task {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { name, description: name, model: null, auto_run: [], prompt: content.trim() }

  const body = match[2].trim()
  let meta: Record<string, unknown> = {}
  try {
    meta = (loadYaml(match[1]) as Record<string, unknown>) ?? {}
  } catch {
    // Malformed YAML — use defaults
  }

  return {
    name:        (meta['name']        as string) || name,
    description: (meta['description'] as string) || name,
    model:       (meta['model']       as string) || null,
    auto_run:    Array.isArray(meta['auto_run']) ? (meta['auto_run'] as string[]) : [],
    prompt:      body,
  }
}

export function loadTask(name: string): Task | null {
  const path = safeTaskPath(name)
  if (!path || !existsSync(path)) return null
  try { return parseTask(readFileSync(path, 'utf8'), name) } catch { return null }
}

export function listTasks(): Task[] {
  if (!existsSync(TASKS_DIR)) return []
  return readdirSync(TASKS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const name = f.replace(/\.md$/, '')
      try { return parseTask(readFileSync(join(TASKS_DIR, f), 'utf8'), name) }
      catch { return { name, description: name, model: null, auto_run: [], prompt: '' } }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

// ── task commands ─────────────────────────────────────────────────────────────

export async function listTasksCmd(): Promise<void> {
  const tasks = listTasks()
  if (tasks.length === 0) {
    process.stdout.write(`No tasks found. Create one with: ${CYAN}sysai task new${RESET}\n`)
    return
  }
  const maxName = Math.max(...tasks.map(t => t.name.length), 4)
  process.stdout.write('\n')
  for (const t of tasks) {
    process.stdout.write(`  ${BOLD}${t.name.padEnd(maxName)}${RESET}  ${DIM}${t.description}${RESET}\n`)
  }
  process.stdout.write(`\n  ${DIM}Run with: sysai <name>   •   sysai <name> --dry-run to preview${RESET}\n\n`)
}

export async function taskCmd([sub, ...args]: string[]): Promise<void> {
  if (sub === 'new')              { await taskDesigner(); return }
  if (sub === 'test' && args[0])  { await runTaskCmd(await requireTask(args[0]), { dryRun: true }); return }
  if (sub === 'edit' && args[0])  { await taskEdit(args[0]); return }
  if (sub === 'rm'   && args[0])  { await taskRm(args[0]); return }
  process.stderr.write([
    'Usage:',
    '  sysai task new          — create a task with AI assistance',
    '  sysai task test <name>  — dry-run: show auto_run output, then AI analysis',
    '  sysai task edit <name>  — open task file in $EDITOR',
    '  sysai task rm   <name>  — delete a task',
    '',
  ].join('\n'))
}

export async function requireTask(name: string): Promise<Task> {
  const task = loadTask(name)
  if (!task) { process.stderr.write(`sysai: no task named "${name}"\n`); process.exit(1) }
  return task
}

export async function taskEdit(name: string): Promise<void> {
  const path = safeTaskPath(name)
  if (!path) { process.stderr.write(`${RED}sysai: invalid task name "${name}"${RESET}\n`); return }
  mkdirSync(TASKS_DIR, { recursive: true })
  if (!existsSync(path)) {
    writeFileSync(path, `---\ndescription: ${name}\nauto_run:\n  - echo "add commands here"\n---\nDescribe what the AI should do with the output above.\n`, 'utf8')
  }
  spawnSync(process.env.VISUAL || process.env.EDITOR || 'vi', [path], { stdio: 'inherit' })
}

export async function taskRm(name: string): Promise<void> {
  const path = safeTaskPath(name)
  if (!path || !existsSync(path)) { process.stderr.write(`${RED}sysai: no task named "${name}"${RESET}\n`); return }
  unlinkSync(path)
  process.stdout.write(`${GREEN}  ✓ Deleted task "${name}"${RESET}\n`)
}

export async function runTaskCmd(task: Task, { dryRun = false } = {}): Promise<void> {

  const shell = process.env.SHELL || 'bash'

  // Run auto_run commands silently, collect output
  let autoRunOutput = ''
  const autoRunTimeout = parseInt(process.env.SYSAI_BASH_TIMEOUT || '120') * 1000
  if (task.auto_run.length > 0) {
    for (const cmd of task.auto_run) {
      const r = spawnSync(shell, ['-c', cmd], { encoding: 'utf8', env: process.env, timeout: autoRunTimeout })
      const out = ((r.stdout || '') + (r.stderr || '')).trim()
      const timedOut = r.signal === 'SIGTERM' || (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
      const suffix = timedOut ? '\n[killed: exceeded timeout]' : ''
      autoRunOutput += `$ ${cmd}\n${out || '(no output)'}${suffix}\n\n`
    }
  }

  // Dry run: show collected output, then ask to continue
  if (dryRun) {
    process.stdout.write(`\n  ${BOLD}${task.name}${RESET} ${DIM}— dry run${RESET}\n\n`)
    if (autoRunOutput) {
      process.stdout.write(autoRunOutput)
    } else {
      process.stdout.write(`${DIM}  (no auto_run commands)${RESET}\n`)
    }
    const rl2 = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const answer = await new Promise<string>(resolve => rl2.question(`\n${DIM}Continue with AI analysis? [Y/n]: ${RESET}`, resolve))
    rl2.close()
    if (answer.trim().toLowerCase() === 'n') return
    process.stdout.write('\n')
  }

  const context  = await buildContext({ stdinContent: autoRunOutput, questionHint: task.name })
  const question = task.prompt || task.description
  const messages = buildMessages({ context, question })

  process.stdout.write('\n')

  // Use /dev/tty for approval prompts so they work even when stdin is piped
  const ttyInput = process.stdin.isTTY
    ? process.stdin
    : (() => { try { return createReadStream('/dev/tty') } catch { return process.stdin } })()
  const rl = createInterface({ input: ttyInput, output: process.stderr, terminal: true })

  const abortController = new AbortController()
  process.once('SIGINT', () => abortController.abort())

  try {
    await runAgentWithUI({
      systemPrompt:  getSystemPrompt(),
      messages,
      autoApprove:   false,
      abortSignal:   abortController.signal,
      rl,
      contentStream: process.stdout,
      uiStream:      process.stderr,
    })
  } catch (err) {
    if (abortController.signal.aborted) {
      process.stderr.write(`\n${DIM}  cancelled${RESET}\n`)
      process.exit(0)
    }
    process.stderr.write(`\n${RED}sysai: ${formatApiError(err)}${RESET}\n`)
    process.exit(1)
  }

  process.stdout.write('\n')
  rl.close()
}

const DESIGNER_PROMPT = `You are a sysai task designer. Help the user create a reusable task file.

Tasks are saved at ~/.sysai/tasks/<name>.md and run with: sysai <name>

TASK FILE FORMAT:
\`\`\`
---
description: One-line description of what this task does
model: model-name      # optional — omit to use active model
auto_run:
  - shell command 1    # runs silently before AI query; output given to AI as context
  - shell command 2
---
The prompt the AI receives, with auto_run output provided as context.
Be specific: what to analyze, what to flag, how to format the response.
\`\`\`

YOUR WORKFLOW:
1. Ask the user what they want the task to do and what their environment is
2. Explore their system with bash: check what tools exist, test a sample command, verify output looks useful
3. Draft the task and show it as a fenced code block so the user can review it
4. Refine based on their feedback — repeat until they're happy
5. When they say "looks good", "save", or "done" — write the file to ~/.sysai/tasks/<name>.md

DRY RUN: If asked to "test" or "dry run", use bash to run each proposed auto_run command (you need approval), show the output, and confirm it gives the AI what it needs. Adjust the task if not.

GUIDELINES:
- auto_run commands must be fast (< 5s) and resilient: use 2>/dev/null or || true for tools that may be missing
- The prompt body tells the AI what to analyze and how to present results — be specific
- Suggest a short lowercase task name (hyphens ok, no spaces, no .md extension)
- Only collect in auto_run what the AI actually needs — keep it focused`

export async function taskDesigner(): Promise<void> {

  mkdirSync(TASKS_DIR, { recursive: true })

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const prompt = (q: string) => new Promise<string>(resolve => rl.question(q, resolve))

  process.stdout.write(`\n  ${CYAN}${BOLD}sysai task designer${RESET}`)
  process.stdout.write(`  ${DIM}back-and-forth with AI — type your goal, refine, then save${RESET}\n`)
  process.stdout.write(`  ${DIM}Ctrl+C to cancel${RESET}\n\n`)

  const context = await buildContext({ questionHint: 'task design' })
  let history: ModelMessage[]    = []
  let activeAbort: AbortController | null = null

  const onSigint = () => {
    if (activeAbort) { activeAbort.abort(); return }
    process.stdout.write(`\n${DIM}Cancelled.${RESET}\n`)
    rl.close(); process.exit(0)
  }
  process.on('SIGINT', onSigint)

  // Tool approval for designer: auto-approve write_file; bash needs approval; read is silent
  const onToolApproval = makeApproval(rl, {
    autoApprove:      false,
    writeFn:          (s) => process.stdout.write(s),
    autoApproveWrite: true,
  })

  // Override write_file display to show green "writing task" message
  const designerApproval = async (toolUse: unknown): Promise<ToolDecision> => {
    const tu   = toolUse as { toolName: string; input?: unknown; args?: unknown }
    const name = tu.toolName
    const args = parseToolArgs(tu.input ?? tu.args)

    if (name === 'write_file') {
      process.stdout.write(`\n${GREEN}  ● write  ${BOLD}${args.path}${RESET}\n`)
      return 'approved'
    }
    // For read_file and bash, use the stdout-directed makeApproval
    return onToolApproval(toolUse)
  }

  const spinner  = process.stderr.isTTY ? createSpinner(s => process.stderr.write(s)) : null
  const renderer = process.stdout.isTTY ? new StreamRenderer(s => process.stdout.write(s)) : null

  const runTurn = async (messages: ModelMessage[]): Promise<ModelMessage[]> => {
    activeAbort = new AbortController()
    try {
      const result = await runAgent({
        systemPrompt:   DESIGNER_PROMPT,
        messages,
        onThinking:     () => spinner?.start(),
        onThinkingDone: () => spinner?.stop(),
        onToken:        process.stdout.isTTY ? t => renderer!.write(t) : t => process.stdout.write(t),
        onToolApproval: designerApproval,
        onToolResult:   (_, __, ms) => { if (process.stderr.isTTY) process.stderr.write(`${DIM}  ✓ ${(ms/1000).toFixed(1)}s${RESET}\n`) },
        abortSignal: activeAbort.signal,
      })
      renderer?.flush()
      process.stdout.write('\n')
      return result.messages
    } catch (err) {
      spinner?.stop(); renderer?.flush()
      if (activeAbort.signal.aborted) {
        process.stdout.write(`\n${DIM}  cancelled${RESET}\n`)
        return messages
      }
      throw err
    } finally {
      activeAbort = null
    }
  }

  // Kick off with a silent opener so AI introduces itself and asks what the user wants
  const opener = buildMessages({
    context,
    question: 'Start the task designer session. Introduce yourself briefly and ask what task the user wants to create.',
  })
  history = await runTurn(opener)

  // Back-and-forth loop
  while (true) {
    const input = (await prompt(`${DIM}> ${RESET}`)).trim()
    if (!input) continue
    if (input === '/exit' || input === '/quit' || input === 'exit' || input === 'quit') break

    history = await runTurn([...history, { role: 'user', content: input }])
  }

  process.removeListener('SIGINT', onSigint)
  process.stdout.write(`${DIM}Task designer session ended.${RESET}\n\n`)
  rl.close()
}
