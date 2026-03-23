import { execSync, spawnSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'

const MAX_BUFFER_LINES = 60
const MAX_STDIN_CHARS  = 8000

/**
 * Build the full context object for the current environment.
 * All fields degrade gracefully — nothing throws if a command is missing.
 *
 * @param {object} opts
 * @param {string} [opts.stdinContent]   - piped stdin content, if any
 * @param {string} [opts.questionHint]   - the user's question (used to trim buffer intelligently)
 * @returns {object} context
 */
export async function buildContext({ stdinContent = '', questionHint = '' } = {}) {
  const ctx = {
    hostname:        safeExec('hostname -f') || safeExec('hostname') || 'unknown',
    user:            process.env.USER || process.env.LOGNAME || safeExec('whoami') || 'unknown',
    cwd:             process.cwd(),
    shell:           process.env.SHELL?.split('/').pop() || 'sh',
    os:              getOS(),
    distro:          getDistro(),
    ssh:             getSSHInfo(),
    slurm:           getSlurmInfo(),
    container:       getContainerInfo(),
    sudo:            getSudoInfo(),
    terminal_buffer: getTerminalBuffer(),
    stdin_pipe:      stdinContent ? truncate(stdinContent, MAX_STDIN_CHARS) : null,
  }
  return ctx
}

/**
 * Format context into a human-readable block for the prompt.
 */
export function formatContext(ctx) {
  const lines = []

  lines.push(`hostname: ${ctx.hostname}`)
  lines.push(`user: ${ctx.user}`)
  lines.push(`cwd: ${ctx.cwd}`)
  lines.push(`shell: ${ctx.shell}`)
  lines.push(`os: ${ctx.os}${ctx.distro ? ' / ' + ctx.distro : ''}`)

  if (ctx.ssh.active) {
    lines.push(`ssh: connected (client ${ctx.ssh.client})`)
  }

  if (ctx.slurm.active) {
    lines.push(`slurm: job ${ctx.slurm.job_id} (${ctx.slurm.job_name}) on ${ctx.slurm.nodelist}, partition=${ctx.slurm.partition}`)
  }

  if (ctx.container.active) {
    lines.push(`container: ${ctx.container.type}`)
  }

  if (ctx.sudo) {
    lines.push(`sudo: elevated (SUDO_USER=${ctx.sudo})`)
  }

  return lines.join('\n')
}

// --- helpers ---

function safeExec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 2000 }).trim()
  } catch {
    return null
  }
}

function getOS() {
  const p = process.platform
  if (p === 'darwin') return 'macOS'
  if (p === 'linux')  return 'Linux'
  return p
}

function getDistro() {
  if (process.platform !== 'linux') return null
  try {
    const release = readFileSync('/etc/os-release', 'utf8')
    const name    = release.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1]
    return name || null
  } catch {
    return safeExec('uname -r')
  }
}

function getSSHInfo() {
  const conn = process.env.SSH_CONNECTION
  if (!conn) return { active: false }
  return {
    active: true,
    client: conn,
  }
}

function getSlurmInfo() {
  const job_id = process.env.SLURM_JOB_ID
  if (!job_id) return { active: false }
  return {
    active:    true,
    job_id,
    job_name:  process.env.SLURM_JOB_NAME    || null,
    nodelist:  process.env.SLURM_NODELIST    || null,
    partition: process.env.SLURM_JOB_PARTITION || null,
    ntasks:    process.env.SLURM_NTASKS      || null,
    cpus:      process.env.SLURM_CPUS_ON_NODE || null,
  }
}

function getContainerInfo() {
  if (existsSync('/.dockerenv'))           return { active: true, type: 'docker' }
  if (process.env.SINGULARITY_CONTAINER)   return { active: true, type: 'singularity', image: process.env.SINGULARITY_CONTAINER }
  if (process.env.APPTAINER_CONTAINER)     return { active: true, type: 'apptainer',   image: process.env.APPTAINER_CONTAINER }
  try {
    const cgroup = readFileSync('/proc/1/cgroup', 'utf8')
    if (cgroup.includes('docker') || cgroup.includes('containerd')) return { active: true, type: 'docker/containerd' }
  } catch {}
  return { active: false }
}

function getSudoInfo() {
  return process.env.SUDO_USER || null
}

function getTerminalBuffer() {
  if (!process.env.TMUX) return null

  // In split mode, capture the work pane not the chat pane
  let workPane = process.env.SYSAI_WORK_PANE
  if (!workPane) {
    // Auto-detect: if there are multiple panes, grab the one that isn't us
    const currentPane = spawnSync('tmux', ['display-message', '-p', '#{pane_id}'],
      { encoding: 'utf8', timeout: 1000 }).stdout.trim()
    const allPanes = spawnSync('tmux', ['list-panes', '-F', '#{pane_id}'],
      { encoding: 'utf8', timeout: 1000 }).stdout.trim().split('\n').filter(Boolean)
    if (allPanes.length > 1) workPane = allPanes.find(p => p !== currentPane) || null
  }
  const args = workPane
    ? ['capture-pane', '-p', '-S', `-${MAX_BUFFER_LINES}`, '-t', workPane]
    : ['capture-pane', '-p', '-S', `-${MAX_BUFFER_LINES}`]

  const result = spawnSync('tmux', args, {
    encoding: 'utf8',
    timeout: 2000,
  })

  if (result.status !== 0 || !result.stdout.trim()) return null

  // Strip the last line if it's just the prompt (starts with $ or %)
  const lines = result.stdout.split('\n')
  const filtered = lines.filter((l, i) => {
    if (i === lines.length - 1 && /^[\$%#>]\s*$/.test(l.trim())) return false
    return true
  })

  return filtered.join('\n').trim() || null
}

function truncate(str, maxChars) {
  if (str.length <= maxChars) return str
  const half = Math.floor(maxChars / 2)
  return str.slice(0, half) + '\n\n[... truncated ...]\n\n' + str.slice(-half)
}

