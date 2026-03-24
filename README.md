# sysai — terminal-native AI assistant

A lightweight CLI tool that gives you an AI assistant anywhere in your terminal. Type `?` and ask.

Works everywhere your shell does.

## Quick start

```bash
git clone https://github.com/charliecpeterson/sysai && cd sysai && node main.js install
```

Then reload your shell:
```bash
source ~/.bashrc   # or ~/.zshrc
```

Then:
```bash
? why is the load average so high
dmesg | tail -50 | ? what do these kernel messages mean
sysai chat             # persistent chat with split-pane tmux support
sysai doctor           # run a built-in task
```

## Usage

### `?` — one-shot agentic query

```bash
? check disk usage on /scratch
? what processes are eating CPU
cat /etc/nginx/nginx.conf | ? is there anything wrong with this config
journalctl -u myservice --since '1 hour ago' | ? summarize the errors
? -y clean up log files older than 30 days    # auto-approve all tool calls
```

The `?` command is agentic — the AI runs shell commands (with your approval), reads files, and iterates on results.

Tool approval:
```
  ⚡ bash  df -h /scratch
  run? [Y/n/e(dit)]:
```

Press Enter to approve, `n` to reject, or `e` to edit before running. Use `-y` to auto-approve everything.

When the AI writes a file, a diff is shown before prompting:
```
  ✎ write  /etc/nginx/nginx.conf
+ server {
+   listen 443 ssl;
  ...
  write? [Y/n]:
```

### `sysai chat` — persistent chat

```bash
sysai chat
```

Interactive session with conversation history and session management.

- **Inside tmux** — automatically splits your window: left pane stays as your terminal, right pane opens the chat. The AI can see your terminal output as context.
- **tmux available but not running** — automatically starts a new tmux session with the split layout.
- **No tmux** — runs inline in the current terminal.

Use `sysai chat --inline` to always run inline.

#### Session commands

```
/sessions      — list saved sessions
/resume N      — resume session N
/new           — start a fresh session
/delete N      — delete session N
/history       — show turns in current session
/clear         — clear current conversation
/compact       — summarise older turns to free up context
/status        — show token usage, turns, and session info
/model [name]  — switch active model
/instructions  — edit ~/.sysai/instructions.md
/exit          — quit
/help          — show all commands
```

Sessions are auto-saved as you go, titled by the first question, and tracked per hostname. Up to 50 sessions are kept.

### `sysai <task>` — named tasks

Tasks are saved queries with pre-configured context collection. Run them with a single command:

```bash
sysai doctor       # system health check
sysai jobcheck     # SLURM job status and health
sysai mycheck      # any task you've created
sysai mycheck --dry-run   # preview what gets collected before AI runs
```

Two built-in tasks are installed automatically. See [Tasks](#tasks) below for how to create your own.

## Tasks

Tasks are Markdown files at `~/.sysai/tasks/<name>.md`. When you run `sysai <name>`:

1. Each `auto_run` command runs silently and its output is given to the AI as context
2. The AI receives the prompt body along with the collected output
3. The AI responds — and can still use tools (bash, read_file, write_file) with your approval

### Built-in tasks

| Task | Description |
|------|-------------|
| `sysai doctor` | uptime, disk, memory, failed services → health summary |
| `sysai jobcheck` | squeue, sacct, quota → SLURM job analysis |

### Creating tasks

#### With AI assistance (recommended)

```bash
sysai task new
```

Opens a back-and-forth chat with the AI. It asks what you want, explores your system to find the right commands, drafts the task file, refines it based on your feedback, and writes the file when you're happy. Ask it to "dry run" at any point to test the commands live.

#### Manually

Task files use YAML frontmatter + a prompt body:

```markdown
---
description: Check GPU memory and utilization
model: claude-sonnet    # optional — uses active model if omitted
auto_run:
  - nvidia-smi 2>/dev/null || echo "No NVIDIA GPU"
  - nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader 2>/dev/null || true
---
Analyze GPU utilization and memory usage.
Flag any GPUs with high memory pressure or low utilization.
Suggest what might be causing any issues.
```

```bash
sysai task edit gpucheck   # create/edit in $EDITOR
```

#### Task commands

```
sysai tasks              — list all tasks
sysai task new           — AI-assisted task designer
sysai task test <name>   — dry run: show auto_run output, then optionally run AI
sysai task edit <name>   — open task file in $EDITOR
sysai task rm   <name>   — delete a task
sysai <name>             — run a task
sysai <name> --dry-run   — same as task test
```

## Configuration

### Model management

sysai supports multiple named model configurations. Switch between them instantly.

```bash
sysai setup     # add, remove, or change models
sysai models    # list all configured models
sysai model     # interactive picker to switch active model
sysai model gpt-5.4   # switch directly by name
```

Example setup with multiple models:
```
  claude-sonnet   anthropic   claude-sonnet-4-6   ← active
  gpt-5.4         openai      gpt-5.4
  local-llama     llamacpp    llama3.2
```

Model configs are stored in `~/.sysai/models.json` (chmod 600).

#### `/model` in chat

Switch models without leaving your chat session:
```
> /model
  1) claude-sonnet   anthropic   claude-sonnet-4-6   ← active
  2) gpt-5.4         openai      gpt-5.4

  Switch to (name or number):
```

The switch is persistent — it stays after you close the session.

### `sysai status`

Show all configured models and run a live health check on each:

```bash
sysai status
```

```
  sysai v0.1.0

  source:  /Users/charlie/projects/sysai

  checking models…

  ● claude-sonnet   anthropic   claude-sonnet-4-6   ← active
  ● gpt-5.4         openai      gpt-5.4
  ✗ local-llama     llamacpp    llama3.2             connection refused

  max turns:  20 (default)

  sysai model <name>   switch active model
  sysai setup          add / remove models
```

`●` green = healthy, `●` red = failed (error shown inline).

### Providers

| Provider | Fields | Default model |
|----------|--------|---------------|
| `anthropic` | `apiKey`, optional `baseUrl` | `claude-sonnet-4-6` |
| `openai` | `apiKey`, optional `baseUrl` | `gpt-4o` |
| `llamacpp` | `baseUrl`, optional `apiKey` | `local` |

You can have multiple configs per provider — e.g., two OpenAI entries with different models or API keys.

### Using with Ollama

```bash
sysai setup
# a) Add model
# Provider: 3 (Local)
# Base URL: http://localhost:11434/v1
# Model ID: llama3.2
# Name: local-llama
```

For small local models, add `SYSAI_MAX_TURNS=8` to `~/.sysai/models.json`'s active config or set it in your environment to avoid hitting small context windows.

### Custom instructions

Edit `~/.sysai/instructions.md` to give the AI persistent context about the machine:

```bash
sysai instructions
```

This file is injected into every query. Keep it concise — focus on what's unique to your environment.

Example for an HPC cluster:
```markdown
# Cluster: Hoffman2 (UCLA)
Scheduler: SLURM. Partitions: shared (CPU), gpu (GPU), highp (priority).
Home: /u/username  Scratch: /scratch/username (purged after 14 days)
Modules: use `module load` before running any software.
No sudo. Software requests: rc-tsupport@cts.ucla.edu
```

No file = no custom instructions. The AI works fine without it.

### Context management

For long sessions, use `/compact` inside `sysai chat` to summarise older turns and free up context:

```
> /compact
✓ Compacted to summary + last 6 turns.
```

Use `/status` to see current token usage and decide when to compact.

Set `SYSAI_MAX_TURNS` in your environment to limit agent iterations (default: 20). Useful for local models with small context windows.

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
     ├─→ LLM calls bash → user approves → runs → output fed back (capped, start+end)
     ├─→ LLM calls read_file with offset/limit → reads chunk → fed back
     ├─→ LLM calls write_file → shows diff → user approves → writes file
     └─→ LLM streams text → rendered with markdown formatting

sysai doctor  (task)
     │
     ▼
  Runs auto_run commands silently → collects output
     │
     ▼
  Same agentic loop with collected output as context
```

### Tools

| Tool | Approval | Description |
|------|----------|-------------|
| `bash` | ask user | Run any shell command. Output capped at 20k chars (start + end preserved). |
| `read_file` | auto | Read a file, optionally with `offset` and `limit` for chunked reading of large files. |
| `write_file` | ask user | Create or overwrite a file. Shows a unified diff before prompting. |

### Context

Automatically detected and sent with every query:

- Hostname, user, cwd, shell, OS/distro
- SSH connection info (`SSH_CONNECTION`)
- SLURM job details (job ID, partition, node list, CPUs)
- Container detection (Docker, Singularity, Apptainer)
- Sudo elevation (`SUDO_USER`)
- Terminal buffer — last 60 lines from tmux. In split-pane mode, captures the **work pane** (your terminal), not the chat pane.
- Piped stdin (capped at 8k chars, start + end preserved)

### Large files and output

The AI reads large files in chunks using `read_file` with `offset` and `limit`. Each response includes total line count so it can navigate to the relevant section:

```
[slurm-12345.out — lines 4850–5000 of 5,000 total]
```

Bash output over 20k chars is truncated with start + end preserved and a note to use `grep`/`tail`/`awk` for targeted follow-up.

## Installation

### What gets installed

```
~/.sysai/
├── bin/sysai          ← compiled binary or symlink to main.js
├── models.json        ← named model configurations (chmod 600)
├── shell.bash         ← shell integration (? function)
├── instructions.md    ← optional: custom instructions for the AI
├── tasks/             ← task files (doctor.md, jobcheck.md, yours…)
└── history/           ← saved chat sessions (auto-managed)
```

Plus one line added to `~/.bashrc` or `~/.zshrc`:
```bash
[ -f ~/.sysai/shell.bash ] && source ~/.sysai/shell.bash
```

### CLI commands

```
sysai install         — set up ~/.sysai, shell integration, and provider
sysai ask <question>  — one-shot agentic query (used by ? shell function)
sysai chat            — interactive chat with session history
sysai setup           — add / remove / manage model configs
sysai models          — list configured models
sysai model [name]    — switch active model
sysai status          — show models with live health check
sysai tasks           — list saved tasks
sysai task new        — create a task with AI assistance
sysai task test <n>   — dry-run a task
sysai task edit <n>   — edit a task file
sysai task rm   <n>   — delete a task
sysai <taskname>      — run a saved task
sysai instructions    — edit ~/.sysai/instructions.md
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
├── main.js      ← entry point: install/setup/status/tasks/model commands
├── cli.js       ← one-shot ? query (agentic)
├── server.js    ← interactive chat with session management and tmux split
├── agent.js     ← agentic loop: streamText → tool calls → approval → execute
├── provider.js  ← model instance creation from named config or legacy env
├── models.js    ← named model config list (~/.sysai/models.json)
├── task.js      ← task file parsing and listing
├── tasks/       ← built-in tasks (doctor.md, jobcheck.md)
├── context.js   ← environment context detection (OS, SLURM, tmux, SSH, etc.)
├── prompt.js    ← system prompt + instructions.md loader
├── history.js   ← session-based conversation history
├── config.js    ← legacy flat config loader (backward compat)
├── render.js    ← spinner, streaming markdown renderer, write diff
├── shell.bash   ← shell integration (? function)
└── build.sh     ← cross-compile via bun
```

## Requirements

- Node.js 18+
- bash or zsh
- tmux (optional — enables split-pane chat and terminal buffer context)
- An API key for Anthropic or OpenAI, or a local model endpoint
