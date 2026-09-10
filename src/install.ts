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

Prefer the installed \`agent-hours\` executable when it is on PATH. Otherwise
replace it below with \`npx agent-hours@latest\`.

\`\`\`bash
agent-hours --json                          # full three-state split, machine-readable
agent-hours --worklog --csv --by-day        # per-day: hours per state + description
agent-hours --worklog --csv                 # per-hour variant
agent-hours --json --since 2026-06-01 --until 2026-06-30
agent-hours --all-projects --source auto --split
agent-hours --source codex --timezone Europe/Berlin --worklog-json
\`\`\`

## How to answer

1. **"How many hours did I work?"** — run \`--json\`. Present the BAND, never a
   single number as truth: direct-interaction estimate, attention estimate
   (including evidence-weighted supervision), and inter-prompt upper estimate.
   Mention total agent runtime separately.
2. **"What did I work on?"** — run \`--worklog --csv --by-day\` (or per-hour for
   one day) and summarize the description column in your own words, grouped
   by theme. This is free — do NOT pass --summarize unless the user asks.
3. **Invoice/billing export** — write the CSV to the requested location and
   state that browser, call, and unrelated editor time is absent. Reconcile
   that time from calendar or other records; do not invent a fixed markup.

## Notes

- \`--source auto\` merges Claude Code + Codex into ONE timeline; parallel
  agents and agent-launched agents do not double-count wall-clock time.
- Codex reads both active \`sessions\` and \`archived_sessions\` from
  \`CODEX_HOME\` (default \`~/.codex\`) and deduplicates session IDs.
- Claude Code prunes logs after cleanupPeriodDays (default 30) — if a range
  looks empty, say so and recommend raising it in ~/.claude/settings.json.
- Local date ranges and buckets use the system IANA timezone by default. Pass
  \`--timezone Europe/Berlin\` when a report must use a specific billing zone.
- Idle-cap methodology: gaps between events capped at 10 min (configurable
  via --cap/--prompt-cap).
`;

export interface InstallResult {
  target: string;
  path: string;
  status: "installed" | "updated" | "skipped";
  reason?: string;
}

/**
 * Long enough to cover quarterly/yearly retroactive billing. Claude Code's
 * default of 30 days silently prunes transcripts — by the time you invoice
 * last quarter, the raw data is gone.
 */
export const RECOMMENDED_RETENTION_DAYS = 365;

export interface RetentionStatus {
  settingsPath: string;
  exists: boolean;
  /** cleanupPeriodDays as currently configured (null = unset → 30-day default) */
  current: number | null;
  sufficient: boolean;
}

/** Reads ~/.claude/settings.json and reports the cleanupPeriodDays state. */
export function checkRetention(homeDir: string = os.homedir()): RetentionStatus {
  const settingsPath = path.join(homeDir, ".claude", "settings.json");
  let current: number | null = null;
  let exists = false;
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    exists = true;
    const v = (JSON.parse(raw) as Record<string, unknown>)["cleanupPeriodDays"];
    if (typeof v === "number") current = v;
  } catch {
    /* missing or unparseable → treat as unset */
  }
  return {
    settingsPath,
    exists,
    current,
    sufficient: current !== null && current >= RECOMMENDED_RETENTION_DAYS,
  };
}

export interface SetRetentionResult {
  ok: boolean;
  settingsPath: string;
  previous: number | null;
  backupPath?: string;
  error?: string;
}

/**
 * Safely sets cleanupPeriodDays in ~/.claude/settings.json. Never lowers an
 * existing higher value. Backs the file up first; bails (without writing) if
 * the existing file isn't valid JSON, so we never clobber a user's config.
 */
export function setRetention(
  days: number = RECOMMENDED_RETENTION_DAYS,
  homeDir: string = os.homedir()
): SetRetentionResult {
  const settingsPath = path.join(homeDir, ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  let previous: number | null = null;
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch {
    /* file doesn't exist yet — we'll create it */
  }
  if (raw !== null) {
    try {
      settings = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        settingsPath,
        previous: null,
        error: "settings.json is not valid JSON — not touching it. Set cleanupPeriodDays manually.",
      };
    }
    const v = settings["cleanupPeriodDays"];
    if (typeof v === "number") previous = v;
  }
  if (previous !== null && previous >= days) {
    return { ok: true, settingsPath, previous };
  }

  let backupPath: string | undefined;
  try {
    if (raw !== null) {
      backupPath = settingsPath + ".bak";
      fs.writeFileSync(backupPath, raw);
    } else {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    }
    settings["cleanupPeriodDays"] = days;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    return { ok: true, settingsPath, previous, backupPath };
  } catch (e) {
    return { ok: false, settingsPath, previous, error: (e as Error).message };
  }
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
 * tests. Codex honors CODEX_HOME for the real user and is skipped (not failed)
 * when the selected Codex home does not exist.
 */
export function runInstall(
  agent: "claude" | "codex" | "all",
  homeDir: string = os.homedir(),
  codexHomeDir?: string
): InstallResult[] {
  const results: InstallResult[] = [];
  if (agent === "claude" || agent === "all") {
    results.push(installSkillFile(path.join(homeDir, ".claude", "skills")));
  }
  if (agent === "codex" || agent === "all") {
    const defaultHome = os.homedir();
    const codexHome =
      codexHomeDir ??
      (homeDir === defaultHome && process.env["CODEX_HOME"]
        ? process.env["CODEX_HOME"]!
        : path.join(homeDir, ".codex"));
    if (fs.existsSync(codexHome)) {
      results.push(installSkillFile(path.join(codexHome, "skills")));
    } else {
      results.push({
        target: codexHome,
        path: "",
        status: "skipped",
        reason: `${codexHome} not found (Codex CLI not installed)`,
      });
    }
  }
  return results;
}
