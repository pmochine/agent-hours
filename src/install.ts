/**
 * `agent-hours install` — headroom-style one-shot integration.
 *
 * Drops a SKILL.md into the agents' skill directories so users can simply
 * ask their agent "what did I work on this week?" and it knows to run this
 * CLI and interpret the numbers. Idempotent; overwrites our own skill file
 * only.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const SKILL_MD = `---
name: agent-hours
description: Billable hours and worklog from coding-agent session logs (Claude Code + Codex, merged). Use when the user asks "how many hours", "what did I work on", "time tracking", "billing", "invoice summary", "Stunden", "woran habe ich gearbeitet", "Arbeitszeit", "Abrechnung", or wants a per-hour/per-day work summary for a period.
---

# agent-hours

Answer time-tracking and what-was-done questions by running the agent-hours
CLI (reads local session logs retroactively — zero setup) and interpreting
its output. Run it from the project directory the user asks about.

## Commands

\`\`\`bash
npx agent-hours --json                          # full three-state split, machine-readable
npx agent-hours --worklog --csv --by-day        # per-day: hours per state + description
npx agent-hours --worklog --csv                 # per-hour variant
npx agent-hours --json --since 2026-06-01 --until 2026-06-30
npx agent-hours --all-projects --split          # everything on this machine
\`\`\`

## How to answer

1. **"How many hours did I work?"** — run \`--json\`. Present the BAND, never a
   single number as truth: hands-on hours (provable lower bound), attention
   hours (model estimate incl. supervised agent time), upper bound. Mention
   total agent runtime separately.
2. **"What did I work on?"** — run \`--worklog --csv --by-day\` (or per-hour for
   one day) and summarize the description column in your own words, grouped
   by theme. This is free — do NOT pass --summarize unless the user asks.
3. **Invoice/billing export** — write the CSV to ~/Downloads and remind the
   user: browser/call time is not in the logs, add 15–25 % on top.

## Notes

- Sources are merged into ONE timeline (Claude Code + Codex; parallel agents
  and agent-launched agents never double-count).
- Claude Code prunes logs after cleanupPeriodDays (default 30) — if a range
  looks empty, say so and recommend raising it in ~/.claude/settings.json.
- Idle-cap methodology: gaps between events capped at 10 min (configurable
  via --cap/--prompt-cap).
`;

export interface InstallResult {
  target: string;
  path: string;
  status: "installed" | "updated" | "skipped";
  reason?: string;
}

function installSkillFile(skillDir: string): InstallResult {
  const target = path.join(skillDir, "agent-hours", "SKILL.md");
  const existed = fs.existsSync(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, SKILL_MD);
  return { target: skillDir, path: target, status: existed ? "updated" : "installed" };
}

/**
 * Installs the skill for the requested agents. `homeDir` is overridable for
 * tests. Codex is skipped (not failed) when ~/.codex doesn't exist.
 */
export function runInstall(
  agent: "claude" | "codex" | "all",
  homeDir: string = os.homedir()
): InstallResult[] {
  const results: InstallResult[] = [];
  if (agent === "claude" || agent === "all") {
    results.push(installSkillFile(path.join(homeDir, ".claude", "skills")));
  }
  if (agent === "codex" || agent === "all") {
    if (fs.existsSync(path.join(homeDir, ".codex"))) {
      results.push(installSkillFile(path.join(homeDir, ".codex", "skills")));
    } else {
      results.push({
        target: path.join(homeDir, ".codex"),
        path: "",
        status: "skipped",
        reason: "~/.codex not found (Codex CLI not installed)",
      });
    }
  }
  return results;
}
