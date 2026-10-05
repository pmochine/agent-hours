#!/usr/bin/env node
/**
 * agent-hours — billable hours from local coding-agent session logs
 * (Claude Code + Codex), including the three-state
 * split: direct interaction / supervised / AI-autonomous.
 *
 * Data source: local Claude and Codex JSONL transcripts (retroactive, zero
 * setup — nothing leaves your machine unless --summarize is requested).
 */
import { collectDoctor, formatDoctor } from "./doctor.js";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  PROJECTS_BASE,
  cappedMinutesInRange,
  computeRefinedSplit,
  countByDay,
  dateTimeKey,
  dayKey,
  detectOverlaps,
  findPauses,
  findClaudeProjectDirs,
  findProjectDir,
  loadProject,
  mergeEvents,
  parseDate,
  claudeFileProjectCwd,
  type NamedSession,
  type RefinedSplit,
  type SessionEvent,
  type TimeZoneSpec,
  type TimelineLoadOptions,
} from "./core.js";
import { unreadableFileCount } from "./jsonl.js";
import {
  WORKLOG_LLM_TEMPLATE,
  collectCodexWorklog,
  collectWorklog,
  describeLog,
  mergeLogs,
  mergeWorklogMaps,
  shortPath,
  type HourLog,
} from "./worklog.js";
import * as readline from "node:readline/promises";
import {
  CODEX_ARCHIVED_SESSIONS_BASE,
  CODEX_SESSIONS_BASE,
  canonicalProjectPath,
  findCodexSessionFiles,
  loadCodexSessions,
  scanCodexSessions,
} from "./sources/codex.js";
import {
  RECOMMENDED_RETENTION_DAYS,
  checkRetention,
  runInstall,
  setRetention,
} from "./install.js";

let doctorCommand = false;

const HELP = `agent-hours — billable hours from coding-agent session logs

Usage:
  npx agent-hours install            integrate with your agents (one shot):
                                     drops a skill so you can just ask
                                     "what did I work on this week?", and
                                     offers to raise Claude's log retention
  npx agent-hours doctor             inspect sources, retention, and schema (or --json)
  npx agent-hours                    current project, cap overview
  npx agent-hours --split            direct interaction / supervised / AI-autonomous
  npx agent-hours --by-day --split   per-day table with split
  npx agent-hours --worklog          hourly worklog (invoice attachment)
  npx agent-hours --worklog --csv    hourly CSV incl. what-was-done column
  npx agent-hours --worklog --csv --by-day   daily CSV incl. descriptions
  npx agent-hours --csv > hours.csv  CSV export (invoice tools)
  npx agent-hours --json             machine-readable output
  npx agent-hours --all-projects     overview across all projects

Options:
  --project <path|hash>  project to analyze (default: cwd)
  --source <s>           auto | claude | codex (default: auto — merges all
                         agents into ONE timeline, no double counting)
  --summarize            refine worklog descriptions via \`claude -p\`
                         (opt-in, the ONLY feature that costs API money)
  --since <date>         start, inclusive (YYYY-MM-DD [HH:MM], local zone)
  --until <date>         end: exclusive with a time, whole day with a date
                         (YYYY-MM-DD [HH:MM], local zone)
  --cap <min>            idle cap for total time (default: 10)
  --prompt-cap <min>     cap for direct-interaction windows (default: 10)
  --split                show the three-state human/AI split
  --by-day               per-day breakdown
  --by-session           per-session breakdown (parallel-session debugging)
  --worklog              hourly what-was-done log (markdown)
  --worklog-json         hourly worklog as JSON + LLM prompt template
  --csv                  CSV output (semicolon-separated)
  --lang <en|de>         CSV headers and total label (default: en)
  --json                 JSON output (always includes the split)
  --timezone <iana>      IANA zone for ranges/buckets (default: system zone)
  --tz-offset <h>        fixed offset: quarter-hours from -14 to 14; disables DST
  --pauses               list longest pauses (> cap)
  --top-pauses <n>       how many pauses to list (default: 10)
  --all-projects         scan projects found in Claude and/or Codex logs
  --set-retention        (with install) set cleanupPeriodDays=365 without asking
  --no-retention         (with install) skip the log-retention check
  -h, --help             this help
  -v, --version          version

Methodology — three states, an estimate rather than a stopwatch:
  direct       credited reaction tails ending in a prompt (estimate)
  supervised   agent working while evidence says you watched (reaction < 30s
               => 100%, < 5min => 50%; mid-turn typing / external file edits
               force 100%)
  AI-autonomous the rest of agent runtime
Browser, call, and unrelated editor time is not present in agent logs.`;

type CsvLanguage = "en" | "de";

const CSV_HEADERS = {
  en: {
    hours: ["Date", "Duration (h)", "Duration (h:mm)"],
    split: ["Direct interaction (h)", "Supervised (h)", "Human attention (h)", "AI autonomous (h)"],
    worklogDay: ["Date", "Active (h)", "Direct interaction (h)", "Supervised (h)", "AI (h)", "Description"],
    worklogHour: ["Date", "Hour", "Active (min)", "Direct interaction (min)", "Supervised (min)", "AI (min)", "Description"],
    total: "TOTAL",
  },
  de: {
    hours: ["Datum", "Dauer (h)", "Dauer (Stunden:Minuten)"],
    split: ["Direct interaction (h)", "Supervised (h)", "Mensch gesamt (h)", "AI-solo (h)"],
    worklogDay: ["Datum", "Aktiv (h)", "Direct interaction (h)", "Supervised (h)", "AI (h)", "Beschreibung"],
    worklogHour: ["Datum", "Stunde", "Aktiv (min)", "Direct interaction (min)", "Supervised (min)", "AI (min)", "Beschreibung"],
    total: "GESAMT",
  },
};

function fail(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function fmtH(minutes: number): string {
  return (minutes / 60).toFixed(2);
}

function hhmm(minutes: number): string {
  const m = Math.floor(minutes);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/** A bare non-path value can still be a legacy Claude project hash. */
function resolveProjectPath(projectArg?: string): string | null {
  if (projectArg === undefined) return canonicalProjectPath(process.cwd());
  const candidate = path.resolve(projectArg);
  if (
    path.isAbsolute(projectArg) ||
    projectArg.startsWith(".") ||
    projectArg.includes(path.sep) ||
    fs.existsSync(candidate)
  ) {
    return canonicalProjectPath(candidate);
  }
  return null;
}

/**
 * After install, make sure Claude Code keeps logs long enough to bill against.
 * Interactive (real TTY): ask before changing the user's settings.json.
 * Non-interactive (agent-invoked): never touch settings silently — just warn.
 * Flags: --set-retention forces it, --no-retention skips the check.
 */
async function ensureRetention(force: boolean, skip: boolean): Promise<void> {
  if (skip) return;
  const status = checkRetention();
  console.log();
  if (status.sufficient) {
    console.log(`Log retention: cleanupPeriodDays = ${status.current} days — good for retroactive billing.`);
    return;
  }

  const have = status.current === null ? "unset (Claude Code prunes after 30 days)" : `${status.current} days`;
  console.log(`⚠  Log retention is ${have}.`);
  console.log(`   agent-hours can only look as far back as your logs survive. For`);
  console.log(`   quarterly/yearly invoicing, ${RECOMMENDED_RETENTION_DAYS} days is recommended.`);

  const apply = () => {
    const r = setRetention(RECOMMENDED_RETENTION_DAYS);
    if (r.ok) {
      console.log(`   ✓ Set cleanupPeriodDays = ${RECOMMENDED_RETENTION_DAYS} in ${r.settingsPath}` + (r.backupPath ? ` (backup: ${r.backupPath})` : ""));
    } else {
      console.log(`   ✗ Could not update settings: ${r.error}`);
    }
  };

  if (force) {
    apply();
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // Agent-invoked / piped: do not modify the user's config behind their back.
    console.log(`   To enable: agent-hours install --set-retention`);
    console.log(`   Or add "cleanupPeriodDays": ${RECOMMENDED_RETENTION_DAYS} to ~/.claude/settings.json`);
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`   Set it to ${RECOMMENDED_RETENTION_DAYS} now? [y/N] `)).trim().toLowerCase();
    if (answer === "y" || answer === "yes") apply();
    else console.log(`   Skipped. You can set it later with: agent-hours install --set-retention`);
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  let args;
  let positionals: string[] = [];
  try {
    const parsed = parseArgs({
      allowPositionals: true,
      options: {
        project: { type: "string" },
        source: { type: "string", default: "auto" },
        summarize: { type: "boolean", default: false },
        since: { type: "string" },
        until: { type: "string" },
        cap: { type: "string", default: "10" },
        "prompt-cap": { type: "string", default: "10" },
        split: { type: "boolean", default: false },
        "by-day": { type: "boolean", default: false },
        "by-session": { type: "boolean", default: false },
        worklog: { type: "boolean", default: false },
        "worklog-json": { type: "boolean", default: false },
        csv: { type: "boolean", default: false },
        lang: { type: "string", default: "en" },
        json: { type: "boolean", default: false },
        timezone: { type: "string" },
        "tz-offset": { type: "string" },
        pauses: { type: "boolean", default: false },
        "top-pauses": { type: "string", default: "10" },
        "all-projects": { type: "boolean", default: false },
        "set-retention": { type: "boolean", default: false },
        "no-retention": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
    args = parsed.values;
    positionals = parsed.positionals;
  } catch (e) {
    fail(`${(e as Error).message}\n\nRun agent-hours --help for usage.`);
  }

  if (args.lang !== "en" && args.lang !== "de") fail("--lang must be en or de.");
  const lang: CsvLanguage = args.lang;

  if (positionals[0] === "doctor") {
    if (positionals.length > 1) fail("Usage: agent-hours doctor [--json]");
    doctorCommand = true;
    const report = collectDoctor();
    console.log(args.json ? JSON.stringify(report, null, 2) : formatDoctor(report));
    return;
  }

  if (positionals[0] === "install") {
    const target = (positionals[1] ?? "all") as "claude" | "codex" | "all";
    if (!["claude", "codex", "all"].includes(target)) {
      fail("Usage: agent-hours install [claude|codex|all]");
    }
    for (const r of runInstall(target)) {
      if (r.status === "skipped") console.log(`- skipped: ${r.reason}`);
      else console.log(`- ${r.status}: ${r.path}`);
    }

    await ensureRetention(args["set-retention"], args["no-retention"]);

    console.log();
    console.log("Done. Now just ask your agent things like:");
    console.log(`  "How many hours did I work on this project last week?"`);
    console.log(`  "What did I work on yesterday? Export a CSV for my invoice."`);
    console.log();
    console.log("Tip (fewer permission prompts): allow \"Bash(agent-hours *)\"");
    console.log("and/or \"Bash(npx agent-hours *)\" in ~/.claude/settings.json");
    console.log("under permissions.allow.");
    return;
  } else if (positionals.length > 0) {
    fail(`Unknown command '${positionals[0]}'. Run agent-hours --help for usage.`);
  }

  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.version) {
    const pkg = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
    );
    console.log(pkg.version);
    return;
  }

  const cap = Number(args.cap);
  const promptCap = Number(args["prompt-cap"]);
  const topPauses = Number(args["top-pauses"]);
  if (!Number.isFinite(cap) || cap <= 0) fail("--cap must be a positive number of minutes.");
  if (!Number.isFinite(promptCap) || promptCap <= 0) fail("--prompt-cap must be a positive number of minutes.");
  if (args.timezone && args["tz-offset"] !== undefined) fail("Use either --timezone or --tz-offset, not both.");
  let timeZone: TimeZoneSpec = args.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  if (args["tz-offset"] !== undefined) {
    const offset = Number(args["tz-offset"]);
    if (!Number.isFinite(offset) || offset < -14 || offset > 14 || !Number.isInteger(offset * 4)) {
      fail("--tz-offset must be a multiple of 0.25 hours between -14 and 14.");
    }
    timeZone = offset;
  }
  try {
    dayKey(Date.now(), timeZone);
  } catch {
    fail(`Invalid time zone: ${String(timeZone)}`);
  }

  let sinceMs = -Infinity;
  let untilMs = Infinity;
  try {
    if (args.since) sinceMs = parseDate(args.since, timeZone);
    if (args.until) {
      if (args.until.includes(" ") || args.until.includes("T")) {
        untilMs = parseDate(args.until, timeZone);
      } else {
        // The final second exists even when the next midnight is skipped by DST.
        untilMs = parseDate(args.until + " 23:59:59", timeZone) + 1000;
      }
    }
  } catch (e) {
    fail((e as Error).message);
  }

  // Load complete files so previous prompts, reaction anchors and future
  // events survive long pauses. With pruning, the direct-interaction tail and
  // reaction weight are exact; only the proportional supervised share of a
  // window that began in a pruned file can differ.
  const loadOptions: TimelineLoadOptions = {
    ...(args.since ? { pruneBeforeMs: sinceMs - 24 * 3600_000 } : {}),
    stats: { prunedFiles: 0 },
  };
  const range = { rangeStartMs: sinceMs, rangeEndMs: untilMs };

  const source = String(args.source).toLowerCase();
  if (!["auto", "claude", "codex"].includes(source)) {
    fail("--source must be auto, claude or codex.");
  }
  const wantClaude = source === "auto" || source === "claude";
  const wantCodex = source === "auto" || source === "codex";

  if (args["all-projects"]) {
    runAllProjects(sinceMs, untilMs, loadOptions, cap, promptCap, timeZone, source, args.split, args.json);
    return;
  }

  const projectDir = findProjectDir(args.project);
  // Codex matching needs a real path; a bare Claude hash can't be mapped back.
  const projectPath = resolveProjectPath(args.project);
  const claudeProjectDirs = wantClaude
    ? projectPath
      ? findClaudeProjectDirs(projectPath)
      : fs.existsSync(projectDir)
        ? [projectDir]
        : []
    : [];

  const sessions: NamedSession[] = [];
  if (wantClaude) {
    for (const dir of claudeProjectDirs) {
      const loaded = loadProject(dir, loadOptions, projectPath ?? undefined);
      sessions.push(
        ...(claudeProjectDirs.length > 1
          ? loaded.map((session) => ({
              ...session,
              name: `${path.basename(dir)}/${session.name}`,
            }))
          : loaded)
      );
    }
  }
  if (
    wantCodex &&
    projectPath &&
    (fs.existsSync(CODEX_SESSIONS_BASE) || fs.existsSync(CODEX_ARCHIVED_SESSIONS_BASE))
  ) {
    sessions.push(...loadCodexSessions(projectPath, loadOptions));
  }

  // A known project can have an empty clipped range after all files are pruned.
  const hasHistory = claudeProjectDirs.length > 0 ||
    (wantCodex && projectPath && sessions.length === 0 && findCodexSessionFiles(projectPath).length > 0);
  if (sessions.length === 0 && !hasHistory) {
    fail(
      `ERROR: no sessions found.\n` +
        (wantClaude ? `  Claude logs checked: ${projectDir}\n` : "") +
        (wantCodex
          ? `  Codex logs checked:  ${CODEX_SESSIONS_BASE} + ${CODEX_ARCHIVED_SESSIONS_BASE} (cwd match)\n`
          : "") +
        `Tip: pass --project <path> or run from the project root.`
    );
  }

  const merged = mergeEvents(sessions);
  const rangeSessions = sessions.map((session) => ({
    ...session,
    events: session.events.filter((event) => event.ts >= sinceMs && event.ts < untilMs),
    creditedMinutes: cappedMinutesInRange(session.events.map((event) => event.ts), cap, sinceMs, untilMs),
  })).filter((session) => session.events.length > 0);
  const rangeClaudeCount = rangeSessions.filter((session) => !session.name.startsWith("codex:")).length;
  const codexCount = rangeSessions.length - rangeClaudeCount;
  const overlapping = detectOverlaps(rangeSessions);
  const openStart = (loadOptions.stats?.prunedFiles ?? 0) > 0;
  const refined = computeRefinedSplit(merged, {
    capMinutes: cap,
    promptCapMinutes: promptCap,
    timeZone,
    ...range,
    openStart,
  });
  const allTimes = merged.map((e) => e.ts);
  const inRange = merged.filter((e) => e.ts >= sinceMs && e.ts < untilMs);

  if (args["worklog"] || args["worklog-json"]) {
    const logs: Map<string, HourLog>[] = [];
    if (wantClaude) {
      for (const dir of claudeProjectDirs) {
        logs.push(collectWorklog(dir, sinceMs, untilMs, timeZone, projectPath ?? undefined));
      }
    }
    if (wantCodex && projectPath) logs.push(collectCodexWorklog(projectPath, sinceMs, untilMs, timeZone));
    const worklog = mergeWorklogMaps(logs);
    if (args.csv && !args["worklog-json"]) {
      printWorklogCsv(worklog, refined, args["by-day"], lang, args.summarize);
    } else {
      printWorklog(projectDir, worklog, refined, args["worklog-json"], args.summarize);
    }
    return;
  }
  if (args.json) {
    printJson(projectDir, args, rangeSessions, merged, refined, cap, promptCap, timeZone, overlapping, sinceMs, untilMs, openStart);
    return;
  }
  if (args.csv) {
    printCsv(refined, args.split, lang);
    return;
  }

  // Human-readable output
  console.log(`Project logs: ${projectDir}`);
  console.log(`Range: ${args.since ?? "beginning"} – ${args.until ?? "now"}`);
  console.log(
    `Sessions in range: ${rangeSessions.length}` +
      (codexCount > 0 ? ` (claude ${rangeClaudeCount}, codex ${codexCount})` : "")
  );
  if (claudeProjectDirs.length > 1) {
    console.log(`Claude project directories matched (root + descendants): ${claudeProjectDirs.length}`);
  }
  console.log(`Total events: ${inRange.length.toLocaleString("en-US")}`);
  console.log();
  console.log("Activity at different idle caps:");
  console.log(`  ${"Cap".padEnd(8)} ${"with cap bonus".padEnd(16)} ${"strict (pause>cap=0)".padEnd(22)}`);
  for (const c of [1, 2, 3, 5, 10, 15]) {
    const h = fmtH(cappedMinutesInRange(allTimes, c, sinceMs, untilMs));
    const hs = fmtH(cappedMinutesInRange(allTimes, c, sinceMs, untilMs, true));
    const marker = c === Math.round(cap) ? "  ← standard" : "";
    console.log(`  ${String(c).padStart(2)}min    ${h.padStart(6)}h          ${hs.padStart(6)}h${marker}`);
  }
  console.log();
  console.log("  with cap bonus: common activity-log estimate (pause > cap counts cap minutes).");
  console.log("  strict        : pause > cap counts 0 — conservative activity estimate for");
  console.log("                  background-heavy sessions (orchestrator waits).");
  console.log();

  if (args.split) {
    console.log(`Human/AI split — three-state model (cap ${cap}min / prompt cap ${promptCap}min):`);
    console.log(`  Direct interaction (estimate): ${fmtH(refined.handsOnMinutes).padStart(7)} h   (${refined.promptCount} prompts)`);
    console.log(`  Supervised (weighted est.):    ${fmtH(refined.supervisedMinutes).padStart(7)} h`);
    console.log(`  = Human attention (model):     ${fmtH(refined.attentionMinutes).padStart(7)} h`);
    console.log(`  Upper bound (inter-prompt):    ${fmtH(refined.upperBoundMinutes).padStart(7)} h`);
    console.log(`  AI autonomous (model):         ${fmtH(refined.aiAutonomousMinutes).padStart(7)} h`);
    console.log(`  Total (merged timeline):       ${fmtH(refined.totalMinutes).padStart(7)} h`);
    console.log();
    console.log("  Band: direct interaction and attention are estimates from log evidence;");
    console.log("  the inter-prompt value is a conservative upper estimate.");
    console.log("  The model weighs agent-working windows by watch evidence (reaction");
    console.log("  < 30s / mid-turn typing / external edits). Billing decision is yours.");
    console.log();
    console.log("  Range across caps (cap and prompt cap varied together):");
    for (const c of [5, 10, 15]) {
      const s = computeRefinedSplit(merged, {
        capMinutes: c,
        promptCapMinutes: c,
        timeZone,
        ...range,
        openStart,
      });
      console.log(
        `    cap ${String(c).padStart(2)}min: total ${fmtH(s.totalMinutes).padStart(6)}h | attention ${fmtH(s.attentionMinutes).padStart(6)}h | AI ${fmtH(s.aiAutonomousMinutes).padStart(6)}h`
      );
    }
    console.log();
  }

  const realPauses = findPauses(allTimes, cap).filter((pause) => pause.startMs < untilMs && pause.endMs > sinceMs);
  if (realPauses.length > 0 && (args.pauses || !args.split)) {
    const n = Math.min(topPauses, realPauses.length);
    const idleTotal = realPauses.reduce((acc, p) => acc +
      (Math.min(p.endMs, untilMs) - Math.max(p.startMs, sinceMs)) / 60000, 0);
    const capBonus = realPauses.reduce((acc, p) => acc +
      cappedMinutesInRange([p.startMs, p.endMs], cap, sinceMs, untilMs), 0);
    console.log(`Pauses > ${cap}min cap (${realPauses.length} total, ${fmtH(idleTotal)}h idle):`);
    console.log(`  Cap-bonus effect: ${capBonus.toFixed(0)}min (${fmtH(capBonus)}h) still counted as work by the standard method.`);
    console.log();
    console.log(`  Top ${n} longest pauses (shown in ${String(timeZone)}):`);
    for (let i = 0; i < n; i++) {
      const p = realPauses[i];
      const start = Math.max(p.startMs, sinceMs);
      const end = Math.min(p.endMs, untilMs);
      const s = (start > p.startMs ? "… " : "") + dateTimeKey(start, timeZone);
      const e = dateTimeKey(end, timeZone) + (end < p.endMs ? " …" : "");
      const minutes = (end - start) / 60000;
      const dur =
        minutes >= 60
          ? `${Math.floor(minutes / 60)}h${String(Math.floor(minutes % 60)).padStart(2, "0")}m`
          : `${minutes.toFixed(1)} min`;
      console.log(`    ${String(i + 1).padStart(2)}. ${s} – ${e}  →  ${dur}`);
    }
    console.log();
  }

  if (overlapping) {
    console.log("⚠  NOTE: multiple sessions/subagents ran IN PARALLEL.");
    console.log("   Hours above use the merged timeline (every real minute counted");
    console.log("   once — no double counting). Details per session: --by-session");
    console.log();
  }

  if (args["by-session"]) {
    console.log(`Per session (cap ${cap}min):`);
    for (const s of rangeSessions) {
      const times = s.events.map((e) => e.ts);
      const a = fmtH(s.creditedMinutes);
      const f = dateTimeKey(times[0], timeZone);
      const l = dateTimeKey(times[times.length - 1], timeZone);
      console.log(`  ${s.name}`);
      console.log(`    ${f} – ${l} | ${String(times.length).padStart(4)} events | ${a.padStart(6)}h active`);
    }
    const sumH = rangeSessions.reduce((acc, s) => acc + s.creditedMinutes, 0);
    console.log();
    console.log(`  Sum of individual sessions (double-counts overlap): ${fmtH(sumH)}h`);
    console.log(`  Merged timeline (real active time):                 ${fmtH(refined.totalMinutes)}h`);
    console.log();
  }

  if (args["by-day"]) {
    if (args.split) {
      const days = aggregateDays(refined);
      console.log(`Per day (cap ${cap}min / prompt cap ${promptCap}min):`);
      console.log(`  Date        |  Total |  Direct | Superv. | AI-auto`);
      for (const day of [...days.keys()].sort()) {
        const d = days.get(day)!;
        console.log(
          `  ${day}  | ${fmtH(d.total).padStart(5)}h | ${fmtH(d.handsOn).padStart(7)}h | ${fmtH(d.supervised).padStart(6)}h | ${fmtH(d.ai).padStart(6)}h`
        );
      }
    } else {
      const dayTotal = aggregateDays(refined);
      const dayMsgs = countByDay(allTimes, timeZone, sinceMs, untilMs);
      console.log(`Per day (cap ${cap}min):`);
      for (const day of [...dayTotal.keys()].sort()) {
        console.log(
          `  ${day} | ${fmtH(dayTotal.get(day)?.total ?? 0).padStart(5)}h | ${String(dayMsgs.get(day) ?? 0).padStart(4)} events`
        );
      }
    }
    console.log();
    console.log(`Sum: ${(refined.totalMinutes / 60).toFixed(1)} h`);
  }
}

interface DayStates {
  total: number;
  handsOn: number;
  supervised: number;
  ai: number;
}

function aggregateDays(refined: RefinedSplit): Map<string, DayStates> {
  const days = new Map<string, DayStates>();
  for (const [hour, st] of refined.byHour) {
    const day = hour.slice(0, 10);
    const d = days.get(day) ?? { total: 0, handsOn: 0, supervised: 0, ai: 0 };
    d.total += st.total;
    d.handsOn += st.handsOn;
    d.supervised += st.supervised;
    d.ai += st.ai;
    days.set(day, d);
  }
  return days;
}

function printCsv(refined: RefinedSplit, withSplit: boolean, lang: CsvLanguage): void {
  const days = aggregateDays(refined);
  const header = [...CSV_HEADERS[lang].hours];
  if (withSplit) header.push(...CSV_HEADERS[lang].split);
  console.log(header.join(";"));
  for (const day of [...days.keys()].sort()) {
    const d = days.get(day)!;
    const row = [day, fmtH(d.total), hhmm(d.total)];
    if (withSplit) {
      row.push(fmtH(d.handsOn), fmtH(d.supervised), fmtH(d.handsOn + d.supervised), fmtH(d.ai));
    }
    console.log(row.join(";"));
  }
}

function csvField(s: string): string {
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[;"\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

interface SummaryBucket {
  key: string;
  minutes?: { total: number; handsOn: number; supervised: number; ai: number };
  commits: string[];
  prompts: string[];
  files: string[];
  awaySummaries: string[];
}

/**
 * Optional AI refinement — the ONLY feature that spends API money, therefore
 * strictly opt-in via --summarize. One `claude -p` call for ALL buckets.
 */
function aiSummarize(buckets: SummaryBucket[]): Map<string, string> {
  const instruction =
    "You receive JSON evidence buckets extracted from coding-agent session logs. " +
    "Output a JSON object mapping EACH bucket key to a summary string " +
    "(summary: max 14 words, dominant language of the evidence, invoice-attachment tone). " +
    "Include OVERALL with a 2-3 sentence summary of the whole period. Output nothing else.";
  try {
    const res = spawnSync("claude", [
      "-p", instruction, "--tools", "", "--strict-mcp-config", "--no-session-persistence",
    ], {
      input: JSON.stringify(buckets),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 300000,
      cwd: os.tmpdir(),
    });
    if (res.error) throw res.error;
    if (res.status !== 0) throw new Error(`claude exited with status ${res.status}`);
    const text = res.stdout.trim().replace(/^```[^\n]*\n([\s\S]*?)\n```$/, "$1");
    const result: unknown = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("expected a JSON object");
    }
    const knownKeys = new Set([...buckets.map((b) => b.key), "OVERALL"]);
    const map = new Map<string, string>();
    for (const [key, value] of Object.entries(result)) {
      if (knownKeys.has(key) && typeof value === "string") map.set(key, value);
    }
    return map;
  } catch (error) {
    console.error(`Warning: --summarize failed; using rule-based descriptions. ${(error as Error).message}`);
    return new Map();
  }
}

/**
 * Worklog as CSV with rule-based descriptions — hourly by default, daily with
 * --by-day. Always ends with a total row describing the whole range.
 */
function printWorklogCsv(
  log: Map<string, HourLog>,
  refined: RefinedSplit,
  byDay: boolean,
  lang: CsvLanguage,
  summarize = false
): void {
  const keys = [...new Set([...refined.byHour.keys(), ...log.keys()])].sort();

  // Optional AI pass: collect evidence per row key, one claude -p call.
  let ai = new Map<string, string>();
  if (summarize) {
    const buckets: SummaryBucket[] = [];
    const rowKeys = byDay ? [...new Set(keys.map((k) => k.slice(0, 10)))].sort() : keys;
    for (const rk of rowKeys) {
      const logs = byDay
        ? keys.filter((k) => k.startsWith(rk)).map((k) => log.get(k)).filter((l): l is NonNullable<typeof l> => !!l)
        : ([log.get(rk)].filter(Boolean) as NonNullable<ReturnType<typeof log.get>>[]);
      const m = mergeLogs(logs);
      buckets.push({
        key: rk,
        commits: m.commits.slice(0, 8),
        prompts: m.prompts.slice(0, 6),
        files: [...m.filesEdited].map(shortPath).slice(0, 10),
        awaySummaries: m.awaySummaries.slice(-2),
      });
    }
    ai = aiSummarize(buckets);
  }
  const describe = (key: string, l: Parameters<typeof describeLog>[0], maxLen?: number) =>
    ai.get(key) ?? describeLog(l, maxLen);

  if (byDay) {
    console.log(CSV_HEADERS[lang].worklogDay.join(";"));
    const days = [...new Set(keys.map((k) => k.slice(0, 10)))].sort();
    const dayStates = aggregateDays(refined);
    for (const day of days) {
      const dayHours = keys.filter((k) => k.startsWith(day));
      const st = dayStates.get(day) ?? { total: 0, handsOn: 0, supervised: 0, ai: 0 };
      const merged = mergeLogs(dayHours.map((h) => log.get(h)).filter((l): l is NonNullable<typeof l> => !!l));
      console.log(
        [day, fmtH(st.total), fmtH(st.handsOn), fmtH(st.supervised), fmtH(st.ai), csvField(describe(day, merged))].join(";")
      );
    }
  } else {
    console.log(CSV_HEADERS[lang].worklogHour.join(";"));
    for (const k of keys) {
      const st = refined.byHour.get(k) ?? { total: 0, handsOn: 0, supervised: 0, ai: 0 };
      const l = log.get(k);
      console.log(
        [
          k.slice(0, 10),
          k.slice(11),
          st.total.toFixed(1),
          st.handsOn.toFixed(1),
          st.supervised.toFixed(1),
          st.ai.toFixed(1),
          csvField(l ? describe(k, l) : ""),
        ].join(";")
      );
    }
  }

  // Project-level summary row (chronological merge)
  const all = mergeLogs(keys.map((k) => log.get(k)).filter((l): l is NonNullable<typeof l> => !!l));
  const label = CSV_HEADERS[lang].total + (byDay ? "" : ";");
  console.log(
    [
      label,
      byDay ? fmtH(refined.totalMinutes) : refined.totalMinutes.toFixed(1),
      byDay ? fmtH(refined.handsOnMinutes) : refined.handsOnMinutes.toFixed(1),
      byDay ? fmtH(refined.supervisedMinutes) : refined.supervisedMinutes.toFixed(1),
      byDay ? fmtH(refined.aiAutonomousMinutes) : refined.aiAutonomousMinutes.toFixed(1),
      csvField(ai.get("OVERALL") ?? describeLog(all, 400)),
    ].join(";")
  );
}

function printWorklog(
  projectDir: string,
  log: Map<string, HourLog>,
  refined: RefinedSplit,
  asJson: boolean,
  summarize = false
): void {
  const hours = [...new Set([...refined.byHour.keys(), ...log.keys()])].sort();

  let ai = new Map<string, string>();
  if (summarize && !asJson) {
    ai = aiSummarize(
      hours
        .filter((h) => log.has(h))
        .map((h) => {
          const l = log.get(h)!;
          return {
            key: h,
            commits: l.commits.slice(0, 8),
            prompts: l.prompts.slice(0, 6),
            files: [...l.filesEdited].map(shortPath).slice(0, 10),
            awaySummaries: l.awaySummaries.slice(-2),
          };
        })
    );
  }

  if (asJson) {
    const out = hours.map((h) => {
      const st = refined.byHour.get(h);
      const l = log.get(h);
      return {
        hour: h,
        minutes: st
          ? {
              total: +st.total.toFixed(1),
              handsOn: +st.handsOn.toFixed(1),
              supervised: +st.supervised.toFixed(1),
              aiAutonomous: +st.ai.toFixed(1),
            }
          : null,
        prompts: l?.prompts ?? [],
        filesEdited: l ? [...l.filesEdited] : [],
        commands: l?.commands ?? [],
        commits: l?.commits ?? [],
        awaySummaries: l?.awaySummaries ?? [],
      };
    });
    console.log(JSON.stringify({ llmTemplate: WORKLOG_LLM_TEMPLATE, hours: out }, null, 2));
    return;
  }

  console.log(`# Worklog ${projectDir.split("/").pop()}`);
  let currentDay = "";
  for (const h of hours) {
    const day = h.slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      console.log(`\n## ${day}`);
    }
    const st = refined.byHour.get(h);
    const l = log.get(h);
    const mins = st
      ? `${st.total.toFixed(0)} min active (${st.handsOn.toFixed(0)} direct / ${st.supervised.toFixed(0)} supervised / ${st.ai.toFixed(0)} AI)`
      : "evidence only";
    console.log(`\n### ${h.slice(11)} · ${mins}`);
    const summary = ai.get(h);
    if (summary) console.log(`- **Summary:** ${summary}`);
    if (l) {
      if (l.prompts.length) {
        console.log(`- Prompts (${l.prompts.length}): ${l.prompts.slice(0, 3).map((p) => `"${p}"`).join(" | ")}${l.prompts.length > 3 ? " …" : ""}`);
      }
      if (l.filesEdited.size) {
        const files = [...l.filesEdited].map(shortPath);
        console.log(`- Files edited (${files.length}): ${files.slice(0, 6).join(", ")}${files.length > 6 ? " …" : ""}`);
      }
      if (l.commits.length) console.log(`- Commits: ${l.commits.map((c) => `"${c}"`).join(", ")}`);
      if (l.commands.length) console.log(`- Commands (${l.commands.length}): ${l.commands.slice(0, 3).join(" | ")}${l.commands.length > 3 ? " …" : ""}`);
      for (const a of l.awaySummaries) console.log(`- Away summary: ${a}`);
    }
  }
  console.log();
  console.log(`---`);
  const overall = ai.get("OVERALL");
  if (overall) console.log(`**Overall:** ${overall}\n`);
  console.log(
    `Totals: ${fmtH(refined.totalMinutes)}h | direct ${fmtH(refined.handsOnMinutes)}h | supervised ${fmtH(refined.supervisedMinutes)}h | AI ${fmtH(refined.aiAutonomousMinutes)}h`
  );
  if (!summarize) {
    console.log(`Tip: --summarize refines descriptions via claude -p (paid), or pipe --worklog-json into your AI chat for free.`);
  }
}

function printJson(
  projectDir: string,
  args: { since?: string; until?: string },
  sessions: NamedSession[],
  merged: SessionEvent[],
  refined: RefinedSplit,
  cap: number,
  promptCap: number,
  timeZone: TimeZoneSpec,
  overlapping: boolean,
  sinceMs: number,
  untilMs: number,
  openStart: boolean
): void {
  const allTimes = merged.map((e) => e.ts);
  const days = aggregateDays(refined);

  const caps: Record<string, unknown> = {};
  for (const c of [5, 10, 15]) {
    const s = computeRefinedSplit(merged, {
      capMinutes: c,
      promptCapMinutes: c,
      timeZone,
      rangeStartMs: sinceMs,
      rangeEndMs: untilMs,
      openStart,
    });
    caps[String(c)] = {
      totalHours: +(s.totalMinutes / 60).toFixed(2),
      attentionHours: +(s.attentionMinutes / 60).toFixed(2),
      aiAutonomousHours: +(s.aiAutonomousMinutes / 60).toFixed(2),
    };
  }

  console.log(
    JSON.stringify(
      {
        projectDir,
        since: args.since ?? null,
        until: args.until ?? null,
        capMinutes: cap,
        promptCapMinutes: promptCap,
        timeZone: typeof timeZone === "string" ? timeZone : null,
        tzOffsetHours: typeof timeZone === "number" ? timeZone : null,
        sessions: sessions.length,
        events: merged.filter((event) => event.ts >= sinceMs && event.ts < untilMs).length,
        prompts: refined.promptCount,
        parallelSessions: overlapping,
        totalHours: +(refined.totalMinutes / 60).toFixed(2),
        strictTotalHours: +(cappedMinutesInRange(allTimes, cap, sinceMs, untilMs, true) / 60).toFixed(2),
        handsOnHours: +(refined.handsOnMinutes / 60).toFixed(2),
        supervisedHours: +(refined.supervisedMinutes / 60).toFixed(2),
        attentionHours: +(refined.attentionMinutes / 60).toFixed(2),
        upperBoundHours: +(refined.upperBoundMinutes / 60).toFixed(2),
        aiAutonomousHours: +(refined.aiAutonomousMinutes / 60).toFixed(2),
        capRange: caps,
        byDay: [...days.keys()].sort().map((day) => {
          const d = days.get(day)!;
          return {
            date: day,
            totalHours: +(d.total / 60).toFixed(2),
            handsOnHours: +(d.handsOn / 60).toFixed(2),
            supervisedHours: +(d.supervised / 60).toFixed(2),
            attentionHours: +((d.handsOn + d.supervised) / 60).toFixed(2),
            aiAutonomousHours: +(d.ai / 60).toFixed(2),
          };
        }),
      },
      null,
      2
    )
  );
}

function runAllProjects(
  sinceMs: number,
  untilMs: number,
  loadOptions: TimelineLoadOptions,
  cap: number,
  promptCap: number,
  timeZone: TimeZoneSpec,
  source: string,
  withSplit: boolean,
  asJson: boolean
): void {
  interface Row {
    project: string;
    totalHours: number;
    attentionHours: number;
    aiAutonomousHours: number;
    events: number;
    lastActivity: string;
  }
  interface ProjectSessions {
    project: string;
    sessions: NamedSession[];
  }

  const projects = new Map<string, ProjectSessions>();
  const wantClaude = source === "auto" || source === "claude";
  const wantCodex = source === "auto" || source === "codex";

  if (wantClaude) {
    let dirs: string[] = [];
    try {
      dirs = fs
        .readdirSync(PROJECTS_BASE, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      // A machine with Codex-only history need not have ~/.claude/projects.
    }
    for (const dir of dirs) {
      const projectDir = path.join(PROJECTS_BASE, dir);
      for (const session of loadProject(projectDir, loadOptions)) {
        const cwd = claudeFileProjectCwd(path.join(projectDir, session.name), projectDir);
        const key = cwd ? `path:${cwd}` : `hash:${dir}`;
        const existing = projects.get(key) ?? { project: cwd ?? dir, sessions: [] };
        existing.sessions.push({ ...session, name: `${dir}/${session.name}` });
        projects.set(key, existing);
      }
    }
  }

  if (wantCodex) {
    for (const scanned of scanCodexSessions(loadOptions)) {
      const cwd = canonicalProjectPath(scanned.cwd);
      const key = `path:${cwd}`;
      const existing = projects.get(key) ?? { project: cwd, sessions: [] };
      // Prefer the readable cwd when a matching Claude path already exists.
      existing.project = cwd;
      existing.sessions.push(scanned.session);
      projects.set(key, existing);
    }
  }

  const openStart = (loadOptions.stats?.prunedFiles ?? 0) > 0;
  const rows: Row[] = [];
  const allSessions: NamedSession[] = [];
  for (const { project, sessions } of projects.values()) {
    allSessions.push(...sessions);
    const merged = mergeEvents(sessions);
    const refined = computeRefinedSplit(merged, {
      capMinutes: cap,
      promptCapMinutes: promptCap,
      timeZone,
      rangeStartMs: sinceMs,
      rangeEndMs: untilMs,
      openStart,
    });
    const inRange = merged.filter((event) => event.ts >= sinceMs && event.ts < untilMs);
    if (!inRange.length && refined.totalMinutes === 0) continue;
    rows.push({
      project,
      totalHours: +(refined.totalMinutes / 60).toFixed(2),
      attentionHours: +(refined.attentionMinutes / 60).toFixed(2),
      aiAutonomousHours: +(refined.aiAutonomousMinutes / 60).toFixed(2),
      events: inRange.length,
      lastActivity: dayKey([...merged].reverse().find((event) => event.ts < untilMs)!.ts, timeZone),
    });
  }
  rows.sort((a, b) => b.totalHours - a.totalHours);

  if (asJson) {
    const grand = computeRefinedSplit(mergeEvents(allSessions), {
      capMinutes: cap,
      promptCapMinutes: promptCap,
      timeZone,
      rangeStartMs: sinceMs,
      rangeEndMs: untilMs,
      openStart,
    });
    console.log(
      JSON.stringify(
        {
          capMinutes: cap,
          promptCapMinutes: promptCap,
          source,
          timeZone: typeof timeZone === "string" ? timeZone : null,
          tzOffsetHours: typeof timeZone === "number" ? timeZone : null,
          totalHours: +(grand.totalMinutes / 60).toFixed(2),
          projects: rows,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`All projects (cap ${cap}min)${withSplit ? " — with split" : ""}:`);
  console.log();
  const head = withSplit
    ? `  ${"Hours".padStart(7)} ${"Attn".padStart(7)} ${"AI-auto".padStart(8)}  ${"Last".padEnd(11)} Project`
    : `  ${"Hours".padStart(7)} ${"Events".padStart(7)}  ${"Last".padEnd(11)} Project`;
  console.log(head);
  for (const r of rows) {
    if (withSplit) {
      console.log(
        `  ${r.totalHours.toFixed(2).padStart(6)}h ${r.attentionHours.toFixed(2).padStart(6)}h ${r.aiAutonomousHours.toFixed(2).padStart(7)}h  ${r.lastActivity.padEnd(11)} ${r.project}`
      );
    } else {
      console.log(
        `  ${r.totalHours.toFixed(2).padStart(6)}h ${String(r.events).padStart(7)}  ${r.lastActivity.padEnd(11)} ${r.project}`
      );
    }
  }
  const grand = computeRefinedSplit(mergeEvents(allSessions), {
    capMinutes: cap,
    promptCapMinutes: promptCap,
    timeZone,
    rangeStartMs: sinceMs,
    rangeEndMs: untilMs,
    openStart,
  });
  console.log();
  console.log(`  ${rows.length} projects, ${fmtH(grand.totalMinutes)} h merged wall-clock activity.`);
}

process.on("exit", () => {
  if (!doctorCommand && unreadableFileCount > 0) console.error(`warning: ${unreadableFileCount} log files could not be read`);
});
main().catch((e) => fail((e as Error).message));
