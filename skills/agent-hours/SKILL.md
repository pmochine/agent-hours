---
name: agent-hours
description: Billable hours and worklog from coding-agent session logs (Claude Code + Codex, merged). Use when the user asks "how many hours", "what did I work on", "time tracking", "billing", "invoice summary", "Stunden", "woran habe ich gearbeitet", "Arbeitszeit", "Abrechnung", or wants a per-hour/per-day work summary for a period.
---

# agent-hours

Answer time-tracking and what-was-done questions by running the agent-hours
CLI (reads local session logs retroactively — zero setup) and interpreting
its output. Run it from the project directory the user asks about.

## Commands

Prefer the installed `agent-hours` executable when it is on PATH. Otherwise
replace it below with `npx agent-hours@latest`.

```bash
agent-hours --json                          # full three-state split, machine-readable
agent-hours --worklog --csv --by-day        # per-day: hours per state + description
agent-hours --worklog --csv                 # per-hour variant
agent-hours --json --since 2026-06-01 --until 2026-06-30
agent-hours --all-projects --source auto --split
agent-hours --source codex --timezone Europe/Berlin --worklog-json
```

## How to answer

1. **"How many hours did I work?"** — run `--json`. Present the BAND, never a
   single number as truth: direct-interaction estimate, attention estimate
   (including evidence-weighted supervision), and inter-prompt upper estimate.
   Mention total agent runtime separately.
2. **"What did I work on?"** — run `--worklog --csv --by-day` (or per-hour for
   one day) and summarize the description column in your own words, grouped
   by theme. This is free — do NOT pass --summarize unless the user asks.
3. **Invoice/billing export** — write the CSV to the requested location and
   state that browser, call, and unrelated editor time is absent. Reconcile
   that time from calendar or other records; do not invent a fixed markup.

## Notes

- `--source auto` merges Claude Code + Codex into ONE timeline; parallel
  agents and agent-launched agents do not double-count wall-clock time.
- Codex reads both active `sessions` and `archived_sessions` from
  `CODEX_HOME` (default `~/.codex`) and deduplicates session IDs.
- Claude Code prunes logs after cleanupPeriodDays (default 30) — if a range
  looks empty, say so and recommend raising it in ~/.claude/settings.json.
- Local date ranges and buckets use the system IANA timezone by default. Pass
  `--timezone Europe/Berlin` when a report must use a specific billing zone.
- Idle-cap methodology: gaps between events capped at 10 min (configurable
  via --cap/--prompt-cap).
