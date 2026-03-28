# sysai — terminal-native AI assistant

A lightweight CLI that gives you an AI assistant anywhere in your terminal. Type `?` and ask.

Works everywhere your shell does: SSH sessions, HPC clusters, containers, remote servers.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/charliecpeterson/sysai/main/install.sh | bash
```

Then reload your shell:
```bash
source ~/.bashrc   # or ~/.zshrc
```

> **From source:** `git clone https://github.com/charliecpeterson/sysai && cd sysai && bun run main.ts install`

## Basic usage

```bash
# One-shot query — the AI runs shell commands with your approval
? check disk usage on /scratch
? what processes are eating CPU
cat error.log | ? summarize the errors

# Persistent chat with session history
sysai chat

# Run a named task (built-in: doctor, jobcheck)
sysai doctor

# Configure models
sysai setup
sysai status
```

## Providers

Works with Anthropic (Claude), OpenAI, or any OpenAI-compatible endpoint (Ollama, llama.cpp, OpenWebUI, etc.).

Run `sysai setup` to configure a provider.

## Requirements

- bash or zsh
- An API key for Anthropic or OpenAI, or a local model endpoint
- tmux (optional — enables split-pane chat)
- [bun](https://bun.sh) (only needed to build from source)

## More

See [USER_GUIDE.md](USER_GUIDE.md) for full documentation: chat sessions, tasks, MCP servers, knowledge bases, configuration, and more.
