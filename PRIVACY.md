# Privacy

agent-hours runs on your computer. It has no server, no account and no telemetry.

## What it reads

- Claude Code session logs below `~/.claude/projects/`.
- Codex session logs below `$CODEX_HOME/sessions/` and `$CODEX_HOME/archived_sessions/` (default `~/.codex`), including plain `*.jsonl` and compressed `*.jsonl.zst` files. Compressed logs require Node >= 22.15; older runtimes warn and skip them.
- The local config at `$XDG_CONFIG_HOME/agent-hours/config.json` (default `~/.config/agent-hours/config.json`), or the file selected with `--config`. Doctor checks only the default config.
- `~/.claude/settings.json`, only to check `cleanupPeriodDays` during `install` and `doctor`.

## What it writes

- The output you ask for: terminal text, or CSV and JSON that you redirect to a file.
- During `install`: one skill file in `~/.claude/skills/agent-hours/` and one in `$CODEX_HOME/skills/agent-hours/`.
- During `install`, and only after you agree: `cleanupPeriodDays` in `~/.claude/settings.json`. It keeps a backup of the old file and never lowers the value.

## What leaves your computer

Nothing, unless you pass `--summarize`. With `--summarize`, agent-hours starts your local `claude -p` and sends worklog excerpts to Claude: prompt excerpts, file paths, commit messages, away-summary excerpts and Codex final-answer excerpts. This runs under your own Claude account and its terms. The call has no tools, no MCP servers and no session persistence.

The `doctor` command reads bounded samples of your logs, including compressed Codex logs on supported runtimes. It prints source directories, binary versions, retention status, counts, and record type and source names, never prompts, log content, client names, or project paths from the config. It also prints the default config path, whether it exists and is valid, and counts of relay prefixes and clients. Invalid configs produce a generic warning without config content or validation error text.

Client reports include configured client names and project paths. With `clients --client <name>`, JSON omits unassigned projects and combines other clients’ shared-hour minutes under `others`; text output omits the Unassigned footer. Unfiltered reports include all clients and unassigned projects.

## Contact

Open an issue: https://github.com/pmochine/agent-hours/issues
