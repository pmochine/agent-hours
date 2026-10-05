# CLAUDE.md

Orientation for agents working in this public npm package and GitHub repo (`pmochine/agent-hours`). README.md is the product documentation.

**Last verified:** 2026-10-05

## Where things live

- **Product docs:** README.md (install, usage, methodology, roadmap).
- **Status pointer:** PLAN.md (gitignored, local). Its last section is the live status. PLAN.md and MARKETING.md contain private context; never copy it into tracked files.
- **Core and entry point:** `src/core.ts` (timekeeping/split), `src/cli.ts` (CLI).
- **Adapters:** Claude Code lives in `src/core.ts` (`findClaudeProjectDirs`, `classifyRecord`, `loadProject`) plus `collectWorklog` in `src/worklog.ts`. Codex lives in `src/sources/codex.ts` plus `collectCodexWorklog` in `src/worklog.ts`, wired in `src/cli.ts`. Events are `SessionEvent {ts, kind, presence, session?, reactionAnchor?}` inside `NamedSession[]`.
- **Skill:** Source of truth is `SKILL_MD` in `src/install.ts`. `npm run build` regenerates `skills/agent-hours/SKILL.md`, which the plugin (`.claude-plugin/`, marketplace source `.`) ships. Never edit that file by hand.
- **Tests:** `npm test` builds and runs `node --test test/*.test.mjs`.

## Rules

- Public repo: no German text, private paths, client names, or secrets in tracked files. The two named exceptions are the German CSV header strings behind `--lang de` in `src/cli.ts` and the German trigger phrases in the skill description in `src/install.ts` (also present in the generated skill).
- Do not hand-edit `dist/` or the generated skill. Run `npm run build`.
- No `git push`. No `--no-verify`.
