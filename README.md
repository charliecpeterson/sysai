# sysai — terminal-native AI assistant

A lightweight CLI tool that gives you an AI assistant anywhere in your terminal — local, over SSH, inside SLURM jobs, containers, sudo sessions. Type `?` and ask.

Install once per machine (or once per shared filesystem). Works everywhere your shell does.

## Quick start

```bash
git clone https://github.com/charliecpeterson/sysai && cd sysai
node main.js install   # installs to ~/.sysai, configures provider, adds shell integration
source ~/.bashrc       # or ~/.zshrc
```

Then:
```bash
? why is the load average so high
dmesg | tail -50 | ? what do these kernel messages mean
ai-pane                # persistent REPL with conversation history
```

On HPC clusters with shared `/home`, install once on the login node — it works on every compute node automatically via `srun`, `ssh`, etc.

## Usage

### `?` — one-shot agentic query

```bash
? check disk usage on /scratch
? what processes are eating CPU
cat /etc/nginx/nginx.conf | ? is there anything wrong with this config
journalctl -u myservice --since '1 hour ago' | ? summarize the errors
```

The `?` command is agentic — the AI runs shell commands (with your approval), reads files, and iterates on results. Not just suggesting commands, executing them.

Tool approval looks like:
```
  ⚡ bash  df -h /scratch
  run? [Y/n/e(dit)]:
```

Press Enter to approve, `n` to reject, or `e` to edit the command before running.

### `ai-pane` — persistent REPL

```bash
ai-pane
```

Interactive session with multi-session history. On startup, offers to resume your last session. If inside tmux, opens a side pane; otherwise runs inline.

#### Session management

```
/sessions    — list saved sessions
/resume N    — resume session N
/new         — start a fresh session
/delete N    — delete session N
/history     — show turns in current session
/clear       — clear current conversation
/exit        — quit
/help        — show all commands
```

Sessions are auto-saved as you go. Each session is titled by its first question and tracks hostname and turn count. Up to 50 sessions are kept.

## Configuration

### `sysai setup`

Interactive configuration wizard. Run anytime to change providers or API keys:

```bash
sysai setup
```

Prompts for:
1. **Provider** — Anthropic (Claude), OpenAI (GPT-4o, o3), or Local (llama.cpp, Ollama, any OpenAI-compatible endpoint)
2. **API key** — or base URL for local endpoints
3. **Model** — optional override (sensible defaults per provider)

Runs a health check after saving to verify the connection works.

### Providers

| Provider | Config keys | Default model |
|----------|------------|---------------|
| `anthropic` | `ANTHROPIC_API_KEY`, optional `ANTHROPIC_BASE_URL` | `claude-sonnet-4-6` |
| `openai` | `OPENAI_API_KEY`, optional `OPENAI_BASE_URL` | `gpt-4o` |
| `llamacpp` | `SYSAI_BASE_URL`, optional `SYSAI_API_KEY` | `local` |

Config is stored in `~/.sysai/config` (chmod 600). Environment variables take precedence over the config file.

### Using with Ollama

```bash
sysai setup
# Choose 3 (Local)
# Base URL: http://localhost:11434/v1
# Model: llama3.2
```

### Custom instructions

Create `~/.sysai/instructions.md` to give the AI persistent context about the machine or your preferences. This is injected into every query's system prompt.

Example for a production database server:
```markdown
This is a production PostgreSQL server (pg01.internal).
- NEVER restart postgresql or modify pg_hba.conf without confirming
- Backups run via pgbackrest, cron at 2am
- App logs: /var/log/myapp/, DB logs: /var/log/postgresql/
- Monitoring: grafana.internal/d/pg-overview
- On-call escalation: #db-oncall in Slack
```

Example for a dev workstation:
```markdown
This is my dev box, be fast and loose.
- Docker compose stack in ~/projects/infra/
- I prefer vim for edits, not nano
- When installing packages, use brew
```

No file = no custom instructions. The AI works fine without it.

## How it works

```
? check disk usage on /scratch
     │
     ▼
  ? shell function → sysai ask "check disk usage on /scratch"
     │
     ▼
  Builds context (hostname, cwd, OS, SLURM, tmux buffer, piped stdin)
     │
     ▼
  Loads ~/.sysai/instructions.md (if present)
     │
     ▼
  Agentic loop: sends query + context + instructions to LLM with tools
     │
     ├─→ LLM calls bash tool → user approves → executes → output fed back
     ├─→ LLM calls read_file → auto-approved → content fed back
     ├─→ LLM calls write_file → user approves → writes file
     └─→ LLM returns text → streamed to stdout
```

### Tools

| Tool | Approval | Description |
|------|----------|-------------|
| `bash` | ask user | Run any shell command in the current environment |
| `read_file` | auto | Read a file's contents |
| `write_file` | ask user | Create or overwrite a file |

### Context

Automatically detected and sent with every query:

- Hostname, user, cwd, shell, OS/distro
- SSH connection info (`SSH_CONNECTION`)
- SLURM job details (job ID, partition, node list, CPUs)
- Container detection (Docker, Singularity, Apptainer)
- Sudo elevation (`SUDO_USER`)
- Terminal buffer (last 60 lines via tmux, if available)
- Piped stdin content

## Installation

### What gets installed

```
~/.sysai/
├── bin/sysai          ← compiled binary or symlink to main.js
├── config             ← provider, API key, model (chmod 600)
├── shell.bash         ← shell integration (? and ai-pane functions)
├── instructions.md    ← optional: custom instructions for the AI
└── history/           ← saved sessions (auto-managed)
```

Plus one line added to `~/.bashrc` or `~/.zshrc`:
```bash
[ -f ~/.sysai/shell.bash ] && source ~/.sysai/shell.bash
```

### CLI commands

```
sysai install         — set up ~/.sysai, shell integration, and provider
sysai ask <question>  — one-shot agentic query (used by ? shell function)
sysai repl            — interactive REPL (used by ai-pane)
sysai setup           — reconfigure provider and API key
sysai --setup-shell   — write shell.bash and print source line
sysai --version       — print version
```

### Uninstall

```bash
rm -rf ~/.sysai
# Remove the source line from ~/.bashrc or ~/.zshrc
```

## Building from source

Requires [bun](https://bun.sh) for compiled binaries, or Node.js 18+ to run directly.

```bash
npm install
npm run build          # cross-compile all 4 targets
npm run build:local    # compile for current platform only
```

Outputs self-contained binaries to `dist/sysai-{darwin,linux}-{x64,arm64}`. The installer uses the prebuilt binary if available, otherwise symlinks `main.js` directly.

## Project structure

```
sysai/
├── main.js          ← entry point + install/setup commands
├── cli.js           ← one-shot ? query (agentic)
├── server.js        ← interactive REPL with session management
├── agent.js         ← agentic loop: streamText → tool calls → approval → execute
├── provider.js      ← model/provider selection
├── context.js       ← environment context detection
├── prompt.js        ← system prompt + instructions.md loader
├── history.js       ← session-based conversation history
├── config.js        ← loads ~/.sysai/config into env
├── ai-pane          ← tmux pane launcher (splits or runs inline)
├── shell.bash       ← shell integration (? and ai-pane functions)
├── install.sh       ← bash installer (alternative to sysai install)
└── build.sh         ← cross-compile via bun
```

## Requirements

- Node.js 18+ (or bun for compiled binaries)
- bash or zsh
- tmux (optional — enables terminal buffer capture)
- An API key for Anthropic or OpenAI, or a local model endpoint
