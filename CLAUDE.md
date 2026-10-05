# CLAUDE.md

Orientation for agents working in this public npm package and GitHub repo (`pmochine/agent-hours`). README.md is the product documentation.

**Last verified:** 2026-10-05

## Where things live

- **Product docs:** README.md (install, usage, methodology, roadmap).
- **Status pointer:** PLAN.md (gitignored, local). Its last section is the live status. PLAN.md and MARKETING.md contain private context. Never copy it into tracked files.
- **Core and entry point:** `src/core.ts` (timekeeping/split), `src/cli.ts` (CLI). `src/doctor.ts` implements the read-only `agent-hours doctor [--json]` diagnostics; `src/schema.ts` holds its measured canary baseline.
- **Adapters:** Claude Code lives in `src/core.ts` (`findClaudeProjectDirs`, `classifyRecord`, `loadProject`) plus `collectWorklog` in `src/worklog.ts`. Codex lives in `src/sources/codex.ts` plus `collectCodexWorklog` in `src/worklog.ts`, wired in `src/cli.ts`. Events are `SessionEvent {ts, kind, presence, session?, reactionAnchor?, editedPath?, agentEdits?}` inside `NamedSession[]`. `src/edits.ts` shares edit extraction with worklogs.
- **Skill:** Source of truth is `SKILL_MD` in `src/install.ts`. `npm run build` regenerates `skills/agent-hours/SKILL.md`, which the plugin (`.claude-plugin/`, marketplace source `.`) ships. Never edit that file by hand.
- **Tests:** `npm test` builds and runs `node --test test/*.test.mjs`.

## Rules

- Public repo: no German text, private paths, client names, or secrets in tracked files. There are two named exceptions. The first is the German CSV header strings behind `--lang de` in `src/cli.ts`. The second is the German trigger phrases in the skill description in `src/install.ts` and in the generated skill.
- Do not hand-edit `dist/` or the generated skill. Run `npm run build`.
- No `git push --force`. No `--no-verify`.
- New agent adapters go in `src/sources/` and follow the adapter contract in README.md ("Sources").
