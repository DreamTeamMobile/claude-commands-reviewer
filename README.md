# Claude Commands Reviewer

[![npm version](https://img.shields.io/npm/v/claude-commands-reviewer)](https://www.npmjs.com/package/claude-commands-reviewer)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**Stop approving the same commands over and over.** Claude Commands Reviewer scans your Claude Code sessions, intelligently groups safe commands using AI, and applies them to your global settings — so every new session starts pre-approved.

If you use Claude Code across multiple projects, you know the pain: the same `npm test`, `git add`, `pytest` prompts appearing in every session. This tool collects those commands, groups them with smart wildcard patterns, and lets you review and approve them once for all future sessions.

## How It Works

1. **Collect** — Scans all active Claude Code sessions and extracts allowed/denied commands from project settings
2. **Group** — Uses Claude Haiku to intelligently create wildcard patterns for similar safe commands (e.g., `npm run:*`)
3. **Review** — Presents grouped commands for interactive approval with built-in safety checks
4. **Apply** — Merges approved commands into `~/.claude/settings.json` with automatic backup

## Quick Start

```bash
# Collect commands from all your Claude Code projects
npx -y claude-commands-reviewer@latest collect

# Interactively review the generated file
npx -y claude-commands-reviewer@latest review review-2025-10-23-183045.json

# Apply approved commands to your global settings
npx -y claude-commands-reviewer@latest apply review-2025-10-23-183045.json
```

No installation required — just run with `npx`.

## Commands

### List Active Sessions

```bash
npx -y claude-commands-reviewer@latest list
```

Shows all Claude Code sessions grouped by project, including project paths, git branches, session count, and last activity time.

### Collect & Analyze

```bash
npx -y claude-commands-reviewer@latest collect
```

Discovers all active sessions (last 7 days or since last run), extracts commands from project `.claude/settings.json` and `settings.local.json`, groups similar commands with AI, and generates a review file.

Use `--reset` to re-scan the last 7 days regardless of when you last ran it:

```bash
npx -y claude-commands-reviewer@latest collect --reset
```

### Interactive Review

```bash
npx -y claude-commands-reviewer@latest review review-2025-10-23-183045.json
```

Interactive controls:
- `A` — Approve current item
- `D` — Deny current item
- `S` — Skip (leave as pending)
- `N` / `P` — Next / Previous item
- `Q` — Save and quit

### Apply Approved Commands

```bash
npx -y claude-commands-reviewer@latest apply review-2025-10-23-183045.json
```

Reads the review file, backs up `~/.claude/settings.json`, merges approved commands, and logs the change to `history/command-approvals.md`.

## Safety Framework

The tool uses a comprehensive safety framework to prevent dangerous wildcards:

**Safe to Wildcard** — Development commands (`poetry run:*`, `npm run:*`), non-destructive git (`git checkout:*`, `git add:*`), testing (`pytest:*`, `jest:*`), build tools (`npm build:*`, `cargo build:*`)

**Review Required** — Publishing commands (`git commit:*`, `git push:*` without --force), package installation (`npm install:*`, `pip install:*`)

**Never Wildcarded** — Destructive operations (`rm`, `del`, `--force`, `--hard`), permission changes (`chmod`, `chown`, `sudo`), network operations (`curl`, `wget`), broad domain/path access

## Review File Format

```json
{
  "date": "2025-10-23T18:30:00.000Z",
  "groupings": [
    {
      "pattern": "Bash(poetry run:*)",
      "matches": ["Bash(poetry run test)", "Bash(poetry run lint)"],
      "reasoning": "Safe: All poetry run commands execute project-defined scripts",
      "confidence": "high",
      "safetyCategory": "SAFE_TO_WILDCARD",
      "approved": true
    }
  ],
  "ungrouped": [
    {
      "command": "Bash(rm -rf temp)",
      "reasoning": "Dangerous: Destructive file deletion",
      "safetyCategory": "NEVER_WILDCARD",
      "approved": false
    }
  ]
}
```

## Recommended Workflow

1. **Weekly**: Run `npx -y claude-commands-reviewer@latest collect` to gather commands from recent sessions
2. **Review**: Use the interactive reviewer or manually edit the JSON file
3. **Apply**: Run `npx -y claude-commands-reviewer@latest apply review-*.json` to update global settings
4. **Benefit**: All new Claude Code sessions automatically allow approved commands

## Alternative Package Managers

Using **Bun**:

```bash
bunx claude-commands-reviewer@latest collect
bunx claude-commands-reviewer@latest review review-2025-10-23-183045.json
bunx claude-commands-reviewer@latest apply review-2025-10-23-183045.json
```

Using **pnpm**:

```bash
pnpm dlx claude-commands-reviewer@latest collect
pnpm dlx claude-commands-reviewer@latest review review-2025-10-23-183045.json
pnpm dlx claude-commands-reviewer@latest apply review-2025-10-23-183045.json
```

## Requirements

- Node.js 22+
- Claude Code CLI installed and authenticated
- Active Claude Code sessions with project settings

## License

MIT
