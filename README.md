# agent-hours

**Billable hours from your local coding-agent session logs — with the split no other tool gives you: hands-on / supervised / AI-autonomous. Plus an hourly worklog for your invoice attachments.**

```
npx agent-hours --split
```

```
Human/AI split — three-state model (cap 10min / prompt cap 10min):
  Hands-on (provably human):        9.26 h   (237 prompts)
  Supervised (weighted est.):       9.39 h
  = Human attention (model):       18.65 h
  Upper bound (inter-prompt):      21.44 h
  AI autonomous (model):           18.99 h
  Total (merged timeline):         37.65 h
```

No server, no account, no telemetry, no setup. It reads the session logs your agents already write to disk — which means it works **retroactively** on every project you've ever run an agent in.

## Why

If you freelance with AI tooling, you need defensible numbers for every invoice conversation:

1. **How long did the work take overall?** (effort evidence)
2. **How much of it were *you*, actively driving or supervising** — vs. the agent grinding alone while you made coffee?
3. **What was actually done, hour by hour?** (the attachment your client never questions)

Existing tools don't answer this:

| Tool | What it gives you | What it can't do |
|---|---|---|
| WakaTime agent plugins | coding activity dashboards | no billing split, not retroactive, cloud service |
| Claude Code OpenTelemetry | `active_time` metrics | needs Prometheus/Grafana, only logs from activation onward |
| ccusage | tokens & API cost | no hours at all |

`agent-hours` is local, retroactive, billing-oriented — and it refuses to pretend one fake-precise number is the truth.

## Features

- **Three-state human/AI split** — hands-on (provable lower bound), supervised (evidence-weighted), AI-autonomous; the old binary heuristic is always shown as the upper bound, so you get an honest band.
- **Multi-agent, one timeline** — Claude Code and Codex CLI sessions merge into a single timeline. Parallel agents never double-count wall-clock time; an agent launched *by* another agent counts as AI runtime, not as you.
- **Hourly worklog** — what was done per hour: your prompts, edited files (incl. subagents), commands, commit messages, and the away-summaries the agent itself wrote.
- **Descriptions with or without AI** — rule-based summaries are the default (deterministic, free, reproducible). `--summarize` optionally refines them via `claude -p` — the only feature that costs API money, strictly opt-in. Or pipe `--worklog-json` into the AI chat you're already paying for.
- **Exports** — CSV (hours/days, with description column and project GESAMT row), JSON, markdown worklog.
- **Battle-tested timekeeping core** — merged-timeline idle-cap math, parallel-session detection, pause analysis, cap-bonus vs. strict columns, per-session breakdown.
- **All projects at a glance** — `--all-projects` ranks everything on your machine.

## Install (pick your comfort level)

**Level 0 — just ask your agent.** Paste this into Claude Code or Codex:

> Install agent-hours (`npx agent-hours install`) and then tell me how many hours I worked on this project this month and what I did.

**Level 1 — one command, then talk naturally:**

```bash
npx agent-hours install        # drops a skill into ~/.claude and ~/.codex
```

From then on, questions like *"What did I work on this week?"* or *"Export a CSV of my June hours for the invoice"* just work — your agent runs the CLI and interprets the band for you.

**Level 2 — Claude Code plugin** (this repo doubles as one):

```
/plugin marketplace add pmochine/agent-hours
/plugin install agent-hours
```

**Level 3 — raw CLI**, no agent involved:

## Usage

```bash
npx agent-hours                    # current project, hours at several idle caps
npx agent-hours --split            # hands-on / supervised / AI-autonomous
npx agent-hours --by-day --split   # per-day table with split

# worklog: what was done, hour by hour
npx agent-hours --worklog                  # markdown, rule-based descriptions
npx agent-hours --worklog --summarize      # + AI-refined lines (claude -p, paid)
npx agent-hours --worklog --csv            # hourly CSV incl. description column
npx agent-hours --worklog --csv --by-day   # daily CSV incl. descriptions
npx agent-hours --worklog-json             # structured + LLM prompt template

# exports & scope
npx agent-hours --csv > hours.csv          # plain per-day CSV (invoice tools)
npx agent-hours --json                     # machine-readable, full split
npx agent-hours --since 2026-06-08 --until 2026-06-12
npx agent-hours --project /path/to/repo
npx agent-hours --source claude|codex|auto # default auto: merge all agents
npx agent-hours --all-projects --split

# tuning & debugging
npx agent-hours --cap 10 --prompt-cap 10 --tz-offset 2
npx agent-hours --by-session               # parallel sessions, per-file
npx agent-hours --pauses                   # longest gaps > cap
```

## Methodology

**Idle-cap timing** is the industry standard for activity-log-based time tracking (WakaTime uses a 5-minute cap, RescueTime 15): sum the gaps between consecutive events, capping each gap. The output always shows several caps (1/2/3/5/10/15) plus a *strict* column (pause > cap counts zero).

**The three-state split** answers the question a binary human/AI split gets wrong — *was the human actually there while the agent worked?*

- **Hands-on** — reaction tails: the time between the agent's last output and your next prompt. You provably read, thought, or typed. The defensible lower bound.
- **Supervised** — the agent-working part of each prompt window, weighted by watch evidence: you reacted within 30 s afterwards (you were watching) ⇒ 100 %, within 5 min ⇒ 50 %, slower ⇒ 0 %. Hard presence proof — you typed a queued message mid-turn, or edited a file in your editor while the agent ran — forces 100 %.
- **AI autonomous** — the rest of agent runtime.

What you bill is your decision; the tool gives you the evidence and the band.

Classification details verified against real logs: scheduled-task and hook "prompts" are filtered out (`promptSource: "system"`), queued messages are credited at the moment you *typed* them, compact-continuation summaries don't count, subagent transcripts are merged in as machine work, and Codex `exec` sessions (launched by scripts or other agents) count entirely as AI runtime.

## Sources

| Agent | Status | Logs read from |
|---|---|---|
| Claude Code | ✅ | `~/.claude/projects/<hash>/*.jsonl` + `<session>/subagents/` |
| Codex CLI | ✅ | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (matched via `cwd`) |
| Gemini CLI, opencode, Cursor, Aider | planned | adapter interface in `src/sources/` |

Adding an agent = one adapter file that yields `{timestamp, kind: prompt|work, presence}` events. PRs welcome.

## Retroactive use & log retention

Everything works retroactively — **as long as the logs are still on disk**:

- **Claude Code** prunes old transcripts after `cleanupPeriodDays` (default: 30 days). For billing, raise it in `~/.claude/settings.json`: `{"cleanupPeriodDays": 365}` — do this *before* you need last quarter's hours.
- **Codex CLI** keeps sessions indefinitely (date-partitioned folders).

Rule of thumb: run your exports when you invoice, archive the CSV/JSON next to the invoice, and you're audit-proof regardless of retention.

### Honest caveats

- The logs only see the agent CLI. Time in the browser, on calls, reading docs, or in another editor is invisible (external file edits show up only as presence signals). Real-world reconciliation says: **add 15–25 %**.
- "Supervised" is a weighted estimate, not a stopwatch. A fast reaction proves presence at the end of a window, not throughout — which is exactly why supervision is capped per prompt window.
- If *cap bonus* and *strict* columns diverge a lot, your sessions had many long waits — quote the strict number to be conservative.

## Roadmap

- **Rates & invoice math** — `--rate 90 --currency EUR`: money columns, plus a three-anchor pricing suggestion (AI-hours floor / senior-equivalent / market).
- **HTML report** — one printable file as the invoice attachment.
- **Git triangulation** — `--git`: inter-commit hours as a cross-check column.
- **`--by-week` / `--by-month`** grouping for retainer billing.
- **Retention guard** — warn when logs approach cleanup age; `agent-hours archive` to snapshot them.
- **More agents** — Gemini CLI, opencode, Cursor, Aider.
- **Optional live precision** — opt-in macOS idle-time sampler to separate "watching" from "AFK" with hardware truth.

## Verification

The original Python implementation (battle-tested over weeks of real invoicing) ships in [`reference/`](reference/) as a golden master. The test suite runs the same legacy-format fixtures through both implementations and fails on any numeric difference (`npm test`).

## License

MIT
