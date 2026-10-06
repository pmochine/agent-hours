# Privacy

agent-hours runs on your computer. It has no server, no account and no telemetry.

## What it reads

- Claude Code session logs below `~/.claude/projects/`.
- Codex session logs below `$CODEX_HOME/sessions/` and `$CODEX_HOME/archived_sessions/` (default `~/.codex`).
- `~/.claude/settings.json`, only to check `cleanupPeriodDays` during `install`.

## What it writes

- The output you ask for: terminal text, or CSV and JSON that you redirect to a file.
- During `install`: one skill file in `~/.claude/skills/agent-hours/` and one in `$CODEX_HOME/skills/agent-hours/`.
- During `install`, and only after you agree: `cleanupPeriodDays` in `~/.claude/settings.json`. It keeps a backup of the old file and never lowers the value.

## What leaves your computer

Nothing, unless you pass `--summarize`. With `--summarize`, agent-hours starts your local `claude -p` and sends worklog excerpts to Claude: prompt excerpts, file paths and commit messages. This runs under your own Claude account and its terms. The call has no tools, no MCP servers and no session persistence.

The `doctor` command reads samples of your logs. It prints only counts and record type names, never log content or project paths.

## Contact

Open an issue: https://github.com/pmochine/agent-hours/issues
