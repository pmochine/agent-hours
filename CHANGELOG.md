# Changelog

All notable changes are documented here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.6.0] - 2026-10-05

### Fixed

- Session counts, parallel warnings, session tables, and pause details now reflect the requested range.
- Date-only `--until` includes the whole day across midnight DST jumps; timed `--until` is exclusive.
- Pruning a previous prompt's file preserves the first loaded reaction tail and watch weight.
- `--summarize` accepts fenced JSON replies with surrounding text.
- `--all-projects` separates Claude hash collisions by each file's canonical cwd and reports the latest activity before the range end.
- Doctor shares Codex source classification and recognizes bare subagent sources.
- Claude subagent classification uses the path relative to the project directory; relative edits without session cwd use the requested project path or stay relative.
- Codex metadata is accepted only in the first object record, preventing inherited metadata from creating sessions.

- External edited-file notices only prove human presence when no other session, including a subagent, edited the same normalized path in the previous 30 minutes.
- Totals drop where Claude away summaries and Codex thread settings previously padded pauses. Away summaries remain worklog evidence.
- Codex long threads now include continuation segments once, including archived copies; Claude workflow subagents now count as machine work.
- Codex voice input and question replies, and Claude `AskUserQuestion` answers, now count as human input.
- Date ranges and hourly buckets clip credited intervals, so adjacent ranges add up. The repeated DST hour has a separate bucket.

### Changed

- `--tz-offset` must be a finite multiple of 0.25 hours between -14 and 14.
- **Breaking:** CSV headers are English by default; use `--lang de` for the previous headers.
- Credited time sits immediately after an event; hourly worklog CSV minutes use one decimal.
- JSONL logs are streamed and `--since` prunes old files by modification time while retaining Codex base metadata for continuations.

### Added

- Read-only `agent-hours doctor` diagnostics with `--json`: source inventory, binary versions, retention warnings, a bounded schema canary, structure checks, and passive-record candidates.
- Shared edit extraction for timelines and worklogs, with cwd resolution and NFC normalization for presence comparisons.

### Removed

- Legacy binary split and its parity test; the three-state interval model is the supported split.

## [0.5.0] - 2026-09-10

- Robust Codex support: archived sessions, subagent and MCP sources, multipart prompts, deduplication by session.
- IANA time zones with daylight-saving-aware ranges and buckets; `--tz-offset` kept as a fixed-offset mode.

## [0.4.0] - 2026-06-18

- `install` checks Claude log retention and offers a safe increase to 365 days.

## [0.3.1] - 2026-06-13

- Project matching handles directories with special characters (non-alphanumeric replacement and NFC normalization).

## [0.3.0] - 2026-06-12

- First public release: merged Claude and Codex timelines, the three-state human/AI split, hourly worklogs, CSV/JSON exports, agent skill installation and the Claude Code plugin.
