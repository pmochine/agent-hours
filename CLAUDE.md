# CLAUDE.md

> **What this is:** Orientation for an AI agent working in this repo.
> **What this is NOT:** Product docs (see README.md) or a status/decision log (see PLAN.md, local-only).
> **Update frequency:** An entry point below changes. Then update this file.

**Last verified:** 2026-09-18

## TL;DR

`agent-hours` is a public npm package and GitHub repo (pmochine/agent-hours). README.md is the product doc and entry point. PLAN.md and MARKETING.md are gitignored, local-only files with status, decisions, and client context. Do not copy their content into a tracked file.

## Where things live

- **Entry point / product docs:** README.md (install, usage, methodology, roadmap).
- **Status + decisions:** PLAN.md (gitignored). Sections 8/9 are the live status. Decisions are inline `✅ ENTSCHIEDEN` markers in context, not a separate ADR file. This fits a solo-maintainer project of this size.
- **Core logic:** `src/core.ts` (timekeeping/split) + `src/cli.ts` (entry). Adapters per agent CLI live in `src/sources/` (one file, yields `{timestamp, kind, presence}` events).
- **Python reference implementation:** `reference/claude_hours.py`, kept as a golden master. `test/parity.test.mjs` fails on any numeric drift between it and the TypeScript core.
- **Agent-facing skill:** `skills/agent-hours/SKILL.md`, also synced into the Claude Code plugin (`.claude-plugin/`) by `scripts/sync-skill.mjs` on build. Edit the skill source, not a generated copy.
- **Tests:** `npm test` (builds, then runs `node --test test/*.test.mjs`).

## Rules for this repo

- Public repo. Use no German text, no private paths, no client names in any tracked file.
- Do not hand-edit `dist/`. It is a gitignored build artifact. Run `npm run build` to regenerate it.
- New agent adapters go in `src/sources/`, matching the existing `{timestamp, kind, presence}` event shape.
