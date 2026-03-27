# sysai — terminal-native AI assistant

A lightweight CLI tool that gives you an AI assistant anywhere in your terminal. Type `?` and ask.

Works everywhere your shell does: SSH sessions, HPC clusters, containers, remote servers.

## Quick start

```bash
git clone https://github.com/charliecpeterson/sysai && cd sysai && bun run main.ts install
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
  ● run   df -h /scratch
  run? [Y/n/e(dit)]:
```

Press Enter to approve, `n` to reject, or `e` to edit before running. Use `-y` to auto-approve everything.

When the AI writes a file, a diff is shown before prompting:
```
  ● write  /etc/nginx/nginx.conf
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

Two built-in tasks are installed automatically on first `sysai install`. See [Tasks](#tasks) below for how to create your own.

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

Task files use a simple frontmatter + prompt body format:

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

## MCP servers

sysai is an MCP host — it can connect to any [Model Context Protocol](https://modelcontextprotocol.io) server and make its tools available to the AI agent alongside the built-in `bash`, `read_file`, and `write_file` tools.

This lets you bring external capabilities (web search, databases, APIs, knowledge bases, etc.) without modifying sysai itself.

### Adding an MCP server

```bash
sysai mcp add
```

Interactive wizard:
```
  Add MCP server

  Name: weather
  Command (e.g. npx, python): npx
  Args (e.g. -y @example/weather-mcp, enter to skip): -y @some/weather-mcp
  Env vars (KEY=val KEY2=val2, enter to skip): WEATHER_API_KEY=abc123
  Description (optional): current weather via WeatherAPI
```

Server configs are stored in `~/.sysai/mcp.json` using the same format as Claude Desktop, so you can copy entries directly between them.

### Using MCP tools

Configured servers start automatically when you run `sysai` or `?`. The AI discovers their tools and uses them naturally:

```
$ ? what's the weather in Tokyo?
  sysai ● claude-sonnet
  mcp  weather (2 tools)

  ● mcp   weather / get_current_weather  {"location":"Tokyo"}
  call? [Y/n]: Y
  ✓ 0.8s

It's currently 18°C and overcast in Tokyo...
```

MCP tool calls show the server name, tool name, and arguments. `-y` auto-approves them like other tools.

### Managing MCP servers

```bash
sysai mcp list             # show all configured servers
sysai mcp add              # add a server (interactive wizard)
sysai mcp edit <name>      # update config in place (API key, args, etc.)
sysai mcp remove <name>    # remove a server
sysai mcp test [name]      # connect and list tools — all servers if no name given
```

`sysai mcp test` is useful when setting up a new server — it connects, lists every tool and its description, and shows a clear error if the server fails to start:

```
$ sysai mcp test get_weather

  connecting…

  ●  get_weather  2 tools
       weather-get_hourly  Get hourly weather forecast for a location
       weather-get_daily   Get daily weather forecast for a location
```

`sysai mcp edit` lets you update a server without removing and re-adding it. Current values are shown as defaults — just press Enter to keep them:

```
$ sysai mcp edit get_weather

  Edit MCP server "get_weather"  (Enter to keep current value)

  Command [npx]:
  Args [-y @timlukahorstmann/mcp-weather]:
  Env vars [ACCUWEATHER_API_KEY=zpka_...]:  ACCUWEATHER_API_KEY=new_key_here
  Description [none]:

  ✓ Updated MCP server "get_weather"
```

> **Note on env var values:** do not quote values in the wizard — type `KEY=value`, not `KEY="value"`. Quotes are stripped automatically if present.

### Example: external tools via MCP

You can add any MCP-compatible tool server. For example, a database tool:

```bash
sysai mcp add
#  Name: postgres
#  Command: npx
#  Args: -y @modelcontextprotocol/server-postgres postgresql://localhost/mydb
```

The AI can then query your database when answering questions. For document search, see the built-in [Knowledge base](#knowledge-base) feature.

### mcp.json format

```json
{
  "servers": {
    "weather": {
      "command": "npx",
      "args": ["-y", "@some/weather-mcp"],
      "env": { "WEATHER_API_KEY": "your-key" },
      "description": "current weather"
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"]
    }
  }
}
```

## Knowledge base

sysai supports local knowledge bases — drop files in a directory, index them, and the AI uses them to answer your questions. No external vector database or embedding service needed.

sysai automatically picks the best strategy based on KB size:

- **Small KBs** (≤80k tokens) — **CAG mode**: all content injected directly into the AI's context. The AI sees everything and can reference it naturally.
- **Large KBs** (>80k tokens) — **Search mode**: the AI gets `list_kb_files` and `search_kb` tools. It browses files, searches with BM25 keyword matching (boosted by filename relevance), and automatically expands queries with alternate phrasings to find what it needs.

### Creating a knowledge base

```bash
sysai kb add myproject --desc "Internal docs for the myproject service"
```

Or use the interactive wizard:
```bash
sysai kb add
```

This creates `~/.sysai/kb/myproject/docs/` — add files to it:

```bash
# Copy files manually
cp ~/docs/*.md ~/.sysai/kb/myproject/docs/
cp ~/specs/api.yaml ~/.sysai/kb/myproject/docs/

# Or use add-file (copies and re-indexes automatically)
sysai kb add-file myproject ~/docs/api.md
sysai kb add-file myproject ~/specs/         # entire directory
```

Then index (if adding manually):
```bash
sysai kb index myproject
  ✓ Indexed "myproject": 12 files, ~15.2k tokens
```

### Supported file types

Text: `.txt`, `.md`, `.json`, `.csv`, `.yaml`, `.yml`, `.toml`, `.ini`, `.log`
Code: `.py`, `.js`, `.ts`, `.go`, `.rs`, `.sh`, `.bash`
Markup: `.html`, `.xml`, `.rst`, `.org`
PDF: `.pdf` (requires `pdftotext` from poppler-utils)

Files over 10MB are skipped. Hidden files (dotfiles) are ignored.

### Using knowledge bases

Active KBs are loaded automatically when you run `sysai` or `?`.

**CAG mode** (small KBs — all content in context):
```
$ ? how does the auth middleware work
  sysai ● claude-sonnet
  kb   myproject (~15k tokens)

The auth middleware in myproject uses JWT tokens...
```

**Search mode** (large KBs — AI browses and searches):
```
$ ? how much are compute nodes
  sysai ● claude-sonnet
  kb   search mode (~375k tokens, too large for context)

  ○ list kb files
  ○ search [h2docs]  compute node price cost purchasing
  ○ read  ~/.sysai/kb/h2docs/docs/purchasing/nodes.md

Standard compute nodes are $14,218.23 per node...
```

In search mode the AI has `list_kb_files`, `search_kb`, and `read_file` — it browses available files, searches with multiple keyword angles, and reads full documents when needed. All KB tool calls are auto-approved (read-only).

### Managing knowledge bases

```bash
sysai kb list                    # show all KBs with status and size
sysai kb add <name>              # create a KB
sysai kb add-file <name> <path>  # copy file or directory into KB and re-index
sysai kb index <name>            # (re)index docs/ contents
sysai kb on <name>               # activate a KB for AI use
sysai kb off <name>              # deactivate a KB
sysai kb delete <name>           # remove a KB and all its docs
```

`sysai kb list` shows a `(stale — re-index)` warning next to any KB whose docs folder has files newer than the last index run.

New KBs start active. Use `sysai kb off` to keep a KB around without loading it into context. You can have multiple KBs — only active ones are used.

For the best experience, keep frequently-used KBs under ~80k tokens so they stay in CAG mode. Larger KBs work fine in search mode — add an embedding model for better search quality.

### Embedding models (optional, improves search mode)

Embeddings are configured per-KB at index time. When indexing, sysai prompts you to choose an embedding model (or BM25 only). If you choose an embedding model, it generates vectors and search uses hybrid scoring (BM25 + cosine similarity) for much better results.

First add an embedding model:
```bash
sysai setup
# e) Add embedding
#   Provider: 1 (OpenAI) or 2 (OpenAI-compatible)
#   For Ollama: base URL http://localhost:11434/v1, model nomic-embed-text
#   For OpenAI: API key, model text-embedding-3-small
```

Then index your KB — you'll be prompted to choose:
```bash
sysai kb index h2docs
  Embedding models available:
    1) openai-small  openai  text-embedding-3-small
    0) None (BM25 only — no API calls)
  Choose embedding [1]: 1

  ✓ Indexed "h2docs": 57 files, ~375.0k tokens  embeddings: openai-small
```

Each KB stores which embedding it was indexed with. Multiple KBs can use different embedding models independently. If you remove an embedding config, affected KBs fall back to BM25-only search until re-indexed.

**Popular local embedding models (via Ollama):**

| Model | Dims | Notes |
|-------|------|-------|
| `nomic-embed-text` | 768 | Best balance, beats OpenAI ada-002 |
| `mxbai-embed-large` | 1024 | Highest quality |
| `all-minilm` | 384 | Fastest, smallest |

Embeddings only affect search mode — CAG mode always injects full text regardless.

## Configuration

### Model management

sysai supports multiple named model configurations. Switch between them instantly.

```bash
sysai setup     # add, remove, or change LLM models and embedding models
sysai models    # list all configured models
sysai model     # interactive picker to switch active model
sysai model claude-sonnet   # switch directly by name
```

Example setup with multiple models and an embedding:
```
  LLM models:
    claude-sonnet   anthropic   claude-sonnet-4-6   ← active
    gpt-4o          openai      gpt-4o
    local-llama     llamacpp    llama3.2

  Embedding models:
    openai-small    openai   text-embedding-3-small
```

Model configs are stored in `~/.sysai/models.json` (chmod 600).

#### `/model` in chat

Switch models without leaving your chat session:
```
> /model
  1) claude-sonnet   anthropic   claude-sonnet-4-6   ← active
  2) gpt-4o          openai      gpt-4o

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

  checking models…

  ●  claude-sonnet   anthropic   claude-sonnet-4-6   ← active
  ●  gpt-4o          openai      gpt-4o
  ●  local-llama     llamacpp    llama3.2

  ◆  get_weather  2 tools

  ◇  openai-small   openai   text-embedding-3-small

  ■  h2docs  57 docs, ~375k tokens  openai-small

  env vars:
    SYSAI_MAX_TURNS       20 (default)  — max agent iterations per query
    SYSAI_MAX_TOKENS      8192 (default)  — max tokens per response
    SYSAI_BASH_TIMEOUT    120 (default)  — seconds before killing a bash command
    SYSAI_COMPACT_KEEP    6 (default)  — turns to keep when compacting

  sysai model <name>   switch active model
  sysai setup          add / remove models
```

`●` green = healthy, `●` red = failed (error shown inline). MCP servers appear below models as `◆` — green if connected, red if the server failed to start.

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
# Provider: 3 (Local)
# Base URL: http://localhost:11434/v1
# Model ID: llama3.2
# Name: local-llama
```

For small local models, set `SYSAI_MAX_TURNS=8` in your environment to avoid hitting small context windows.

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
  Connects to MCP servers from ~/.sysai/mcp.json (if any)
  Loads active knowledge bases from ~/.sysai/kb/ (if any, ≤80k tokens)
     │
     ▼
  Agentic loop: sends query + context + instructions + KB text to LLM
  with built-in tools + any MCP tools
     │
     ├─→ LLM calls bash → user approves → runs → output fed back
     ├─→ LLM calls read_file with offset/limit → reads chunk → fed back
     ├─→ LLM calls write_file → shows diff → user approves → writes file
     ├─→ LLM calls MCP tool → user approves → MCP server executes
     └─→ LLM streams text → rendered with markdown formatting

sysai doctor  (task)
     │
     ▼
  Runs auto_run commands silently → collects output
     │
     ▼
  Same agentic loop with collected output as context
```

### Built-in tools

| Tool | Approval | Description |
|------|----------|-------------|
| `bash` | ask user | Run any shell command. Output capped at 20k chars (start + end preserved). |
| `read_file` | auto | Read a file, optionally with `offset` and `limit` for chunked reading of large files. |
| `write_file` | ask user | Create or overwrite a file. Shows a unified diff before prompting. |
| `search_kb` | auto | Hybrid BM25 + cosine search over active knowledge bases. Automatically expands the query with 2 alternate phrasings and merges results. File name matches are boosted. Available in search mode (>80k tokens). |
| `list_kb_files` | auto | List all files in active KBs with paths and sizes. Helps the AI browse before searching. Available in search mode. |
| MCP tools | ask user | Any tool exposed by a configured MCP server, called by its original name. Auto-approved with `-y`. Result preview shown inline. |

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
├── bin/sysai          ← compiled binary (or symlink to main.ts when running from source)
├── models.json        ← named model configurations (chmod 600)
├── mcp.json           ← MCP server configurations (created on first sysai mcp add)
├── kb/                ← knowledge bases (created on first sysai kb add)
│   ├── config.json    ← KB metadata and active list
│   └── <name>/
│       ├── docs/       ← user-dropped source files
│       ├── index.json  ← processed text chunks (after sysai kb index)
│       └── vectors.json ← embeddings (optional, when embedding model chosen)
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
sysai install              — set up ~/.sysai, shell integration, and provider
sysai ask <question>       — one-shot agentic query (used by ? shell function)
sysai chat                 — interactive chat with session history

sysai setup                — add / remove / manage model configs
sysai models               — list configured models
sysai model [name]         — switch active model
sysai status               — show models with live health check

sysai mcp list             — list configured MCP servers
sysai mcp add              — add an MCP server (interactive wizard)
sysai mcp edit <name>      — update a server's config in place
sysai mcp remove <name>    — remove an MCP server
sysai mcp test [name]      — connect and list tools (all servers if no name)

sysai kb list                    — list knowledge bases with status and size
sysai kb add <name>              — create a knowledge base
sysai kb add-file <name> <path>  — copy file or directory into KB and re-index
sysai kb index <name>            — (re)index docs/ contents
sysai kb on <name>               — activate a KB for AI use
sysai kb off <name>              — deactivate a KB
sysai kb delete <name>           — remove a KB and all its docs

sysai tasks                — list saved tasks
sysai task new             — create a task with AI assistance
sysai task test <name>     — dry-run a task
sysai task edit <name>     — edit a task file
sysai task rm   <name>     — delete a task
sysai <taskname>           — run a saved task

sysai instructions         — edit ~/.sysai/instructions.md
sysai --version            — print version
```

### Uninstall

```bash
rm -rf ~/.sysai
# Remove the source line from ~/.bashrc or ~/.zshrc
```

## Building from source

Requires [bun](https://bun.sh).

```bash
npm install
npm run build          # cross-compile all 4 targets
npm run build:local    # compile for current platform only
```

Outputs self-contained binaries to `dist/sysai-{darwin,linux}-{x64,arm64}`. The installer copies the prebuilt binary if one is present, otherwise symlinks `main.ts` and uses bun at runtime.

To run directly from source without building:

```bash
bun run main.ts --version
bun run main.ts install
```

## Project structure

```
sysai/
├── main.ts                    ← entry point and CLI router
├── src/
│   ├── types.ts               ← shared TypeScript interfaces
│   ├── version.ts             ← version constant
│   ├── commands/
│   │   ├── ask.ts             ← one-shot ? query (agentic)
│   │   ├── chat.ts            ← interactive chat with session management and tmux split
│   │   ├── kb.ts              ← kb add / list / index / on / off / delete commands
│   │   ├── mcp.ts             ← mcp list / add / remove commands
│   │   └── setup.ts           ← model setup wizard, status, list, switch
│   ├── core/
│   │   ├── agent.ts           ← agentic loop: streamText → tool calls → approval → execute
│   │   ├── embeddings.ts      ← embedding client: /v1/embeddings, cosine similarity
│   │   ├── mcp-client.ts      ← MCP stdio client: connect, discover tools, forward calls
│   │   ├── prompt.ts          ← system prompt + instructions.md loader
│   │   └── provider.ts        ← AI SDK model instantiation (Anthropic, OpenAI, llama.cpp)
│   ├── storage/
│   │   ├── history.ts         ← JSONL session files, auto-managed
│   │   ├── kb.ts              ← knowledge base storage and indexing (~/.sysai/kb/)
│   │   ├── mcp.ts             ← MCP server configs (~/.sysai/mcp.json)
│   │   └── models.ts          ← named model configs (~/.sysai/models.json)
│   ├── env/
│   │   └── context.ts         ← environment detection (OS, SLURM, tmux, SSH, container)
│   ├── task/
│   │   └── task.ts            ← task file parsing, listing, and execution
│   └── ui/
│       ├── approval.ts        ← tool approval prompts and agent UI wiring
│       ├── colors.ts          ← ANSI color constants
│       ├── errors.ts          ← API error formatting
│       └── render.ts          ← spinner, streaming markdown renderer, write diff
├── tasks/                     ← built-in tasks (doctor.md, jobcheck.md)
├── shell.bash                 ← shell integration (? function)
├── build.sh                   ← cross-compile via bun
└── tsconfig.json
```

## Requirements

- [bun](https://bun.sh) — required to run from source or build binaries
- bash or zsh
- tmux (optional — enables split-pane chat and terminal buffer context)
- poppler-utils (optional — enables PDF support in knowledge bases via `pdftotext`)
- An API key for Anthropic or OpenAI, or a local model endpoint (Ollama, llama.cpp)
