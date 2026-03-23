import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const CONFIG_PATH = join(homedir(), '.sysai', 'config')

/**
 * Load ~/.sysai config file and apply to process.env.
 * Format is simple KEY=VALUE, one per line. Comments with #.
 *
 * This lets users store their API key without it being in the shell environment
 * (slightly safer than putting it in .bashrc).
 */
export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return

  try {
    const lines = readFileSync(CONFIG_PATH, 'utf8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      const val = trimmed.slice(eq + 1).trim()
      // Only set if not already in environment (env var takes precedence)
      if (key && val && !process.env[key]) {
        process.env[key] = val
      }
    }
  } catch {
    // Config file unreadable — fail silently, provider.js will catch missing keys
  }
}
