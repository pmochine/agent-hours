/** Read-only diagnostics. Never retain or print prompts, content, or project paths. */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { PROJECTS_BASE, classifyRecord } from "./core.js";
import { CODEX_HOME, defaultCodexSessionDirs, codexHumanInput } from "./sources/codex.js";
import { checkRetention } from "./install.js";
import { forEachJsonlRecord, unreadableFileCount } from "./jsonl.js";
import {
  schemaKind, schemaValue, KNOWN_CLAUDE_KINDS, KNOWN_CODEX_KINDS,
  KNOWN_PROMPT_SOURCES, KNOWN_ORIGINATORS, KNOWN_CODEX_SOURCES,
} from "./schema.js";

const DAY = 86400000;
const READ_LIMIT = 400 * 1024 * 1024;
type Source = "claude" | "codex";
type Counts = Map<string, number>;
interface LogFile { file: string; source: Source; size: number; mtimeMs: number }
interface SourceInfo { directory: string; exists: boolean; files: number; bytes: number; projectDirectories?: number }

function increment(counts: Counts, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
function counted(counts: Counts): { kind: string; count: number }[] {
  return [...counts].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}
function binaryVersion(binary: string): string | null {
  try {
    const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 4096 });
    return !result.error && result.status === 0 ? result.stdout.trim().split("\n")[0].slice(0, 200) || null : null;
  } catch { return null; }
}

export function collectDoctor(now = Date.now()) {
  const files: LogFile[] = [];
  const unsupported = new Map<string, number>();
  let nestedSubagentDirectories = 0;
  let inventoryFailures = 0;
  const inventory = (directory: string, source: Source): SourceInfo => {
    const info: SourceInfo = { directory, exists: fs.existsSync(directory), files: 0, bytes: 0 };
    if (source === "claude") info.projectDirectories = 0;
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { inventoryFailures++; return; }
      for (const entry of entries) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (source === "claude") {
            if (dir === directory) info.projectDirectories!++;
            const parts = path.relative(directory, file).split(path.sep);
            const at = parts.indexOf("subagents");
            const below = at < 0 ? [] : parts.slice(at + 1);
            if (below.length && !(below.length === 1 && below[0] === "workflows") &&
                !(below.length === 2 && below[0] === "workflows" && below[1].startsWith("wf_"))) {
              nestedSubagentDirectories++;
            }
          }
          walk(file);
        } else if (entry.isFile()) {
          try {
            const stat = fs.statSync(file);
            if (entry.name.endsWith(".jsonl")) {
              info.files++;
              info.bytes += stat.size;
              files.push({ file, source, size: stat.size, mtimeMs: stat.mtimeMs });
            } else if (source === "codex") {
              // Extensions only: filenames can contain project or thread identity.
              increment(unsupported, entry.name.endsWith(".jsonl.zst") ? "*.jsonl.zst" : path.extname(entry.name) || "(no extension)");
            }
          } catch { inventoryFailures++; }
        }
      }
    };
    if (info.exists) walk(directory);
    return info;
  };
  const [sessionsDir, archivedDir] = defaultCodexSessionDirs();
  const sources = {
    claude: inventory(PROJECTS_BASE, "claude"),
    codexHome: CODEX_HOME,
    codexSessions: inventory(sessionsDir, "codex"),
    codexArchivedSessions: inventory(archivedDir, "codex"),
    versions: { claude: binaryVersion("claude"), codex: binaryVersion("codex") },
  };
  const cleanupPeriodDays = checkRetention().current ?? 30;
  // mtime is the append-only transcript's last activity, the pruning age proxy.
  const claudeFiles = files.filter((file) => file.source === "claude");
  const oldestAgeDays = claudeFiles.length ? (now - claudeFiles.reduce((oldest, file) => Math.min(oldest, file.mtimeMs), Infinity)) / DAY : null;
  const retention = { cleanupPeriodDays, oldestAgeDays, ageBasis: "file mtime" };
  const unknownClaude = new Map<string, number>();
  const unknownCodex = new Map<string, number>();
  const promptSources = new Map<string, number>();
  const originators = new Map<string, number>();
  const codexSources = new Map<string, number>();
  const kinds = new Map<string, number>();
  const passive = new Map<string, number>();
  const recent = files.filter((file) => file.mtimeMs >= now - 14 * DAY).sort((a, b) => b.mtimeMs - a.mtimeMs);
  let bytesRead = 0;
  let filesScanned = 0;
  let historyBaseFiles = 0;
  const unreadableBefore = unreadableFileCount;
  for (const file of recent) {
    if (bytesRead >= READ_LIMIT) break;
    filesScanned++;
    const bytesBefore = bytesRead;
    let previousTs: number | null = null;
    let interactive = true;
    let subagent = file.source === "claude" && file.file.includes(`${path.sep}subagents${path.sep}`);
    let historyBase = false;
    let pending: { ts: number; kind: string }[] = [];
    forEachJsonlRecord(file.file, (record) => {
      const kind = schemaKind(record, file.source);
      const labeledKind = `${file.source}:${kind}`;
      increment(kinds, labeledKind);
      const payload = (record["payload"] ?? {}) as Record<string, unknown>;
      if (file.source === "claude" && record["promptSource"] !== undefined) {
        const value = schemaValue(record["promptSource"]);
        if (!KNOWN_PROMPT_SOURCES.has(value)) increment(promptSources, value);
      }
      if (file.source === "codex" && record["type"] === "session_meta") {
        const originator = schemaValue(payload["originator"]);
        const source = schemaValue(payload["source"]);
        if (!KNOWN_ORIGINATORS.has(originator)) increment(originators, originator);
        if (!KNOWN_CODEX_SOURCES.has(source)) increment(codexSources, source);
        if (payload["history_base"] !== undefined) historyBase = true;
        subagent = source.startsWith("subagent.") || payload["thread_source"] === "subagent" || typeof payload["parent_thread_id"] === "string";
        interactive = !subagent && payload["originator"] !== "Claude Code" && source !== "exec" && source !== "mcp";
      }
      const timestamp = record["timestamp"];
      const ts = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
      if (!Number.isFinite(ts)) return;
      const known = file.source === "claude" ? KNOWN_CLAUDE_KINDS : KNOWN_CODEX_KINDS;
      if (!known.has(kind)) increment(file.source === "claude" ? unknownClaude : unknownCodex, kind);
      const human = !subagent && (file.source === "claude" ? classifyRecord(record).kind === "prompt" : interactive && codexHumanInput(record).prompt !== null);
      pending = pending.filter((candidate) => {
        if (ts > candidate.ts + 2 * 60000) { increment(passive, candidate.kind); return false; }
        return !(human && ts >= candidate.ts);
      });
      // A prompt is itself human input at the end of the gap, not passive.
      if (!human && previousTs !== null && ts - previousTs > 10 * 60000) pending.push({ ts, kind: labeledKind });
      previousTs = ts;
    }, { maxBytes: READ_LIMIT - bytesRead, onBytesRead: (size) => { bytesRead += size; } });
    // Only complete files establish the absence of a later human prompt.
    if (bytesRead - bytesBefore >= file.size) {
      for (const candidate of pending) increment(passive, candidate.kind);
    }
    if (historyBase) historyBaseFiles++;
  }
  const unreadableFiles = unreadableFileCount - unreadableBefore;
  const scan = {
    days: 14, recentFiles: recent.length, filesScanned, bytesRead,
    readLimitBytes: READ_LIMIT, limited: bytesRead >= READ_LIMIT,
    kinds: counted(kinds), unknownClaudeKinds: counted(unknownClaude), unknownCodexKinds: counted(unknownCodex),
    unknownPromptSources: counted(promptSources), unknownOriginators: counted(originators), unknownSources: counted(codexSources),
  };
  const structure = { nestedSubagentDirectories, historyBaseFiles, unsupportedFiles: counted(unsupported), unreadableFiles, inventoryFailures };
  const warnings: string[] = [];
  if (oldestAgeDays !== null && oldestAgeDays >= cleanupPeriodDays - 7) warnings.push("Oldest Claude session file is within 7 days of pruning age or older.");
  if (unknownClaude.size) warnings.push("Unknown timestamped Claude kinds.");
  if (unknownCodex.size) warnings.push("Unknown timestamped Codex kinds.");
  if (promptSources.size) warnings.push("Unknown Claude promptSource values.");
  if (originators.size) warnings.push("Unknown Codex originator values.");
  if (codexSources.size) warnings.push("Unknown Codex source values.");
  if (nestedSubagentDirectories) warnings.push("Unexpected nested subagent directories.");
  if (unsupported.size) warnings.push("Compressed or unknown Codex files: not read.");
  if (unreadableFiles) warnings.push("The streaming reader could not read files.");
  if (inventoryFailures) warnings.push("Some source entries could not be inspected.");
  return { sources, retention, scan, structure, passiveCandidates: counted(passive).slice(0, 5), warnings,
    status: warnings.length ? `doctor: ${warnings.length} warnings` : "doctor: OK" };
}

export function formatDoctor(report: ReturnType<typeof collectDoctor>): string {
  const lines = ["Sources:"];
  for (const [name, source] of [ ["Claude projects", report.sources.claude], ["Codex sessions", report.sources.codexSessions], ["Codex archived sessions", report.sources.codexArchivedSessions] ] as const) {
    lines.push(`  ${name}: ${source.directory}; exists=${source.exists}; ${source.projectDirectories === undefined ? "" : `${source.projectDirectories} project directories; `}${source.files} files; ${source.bytes} bytes`);
  }
  lines.push(`  CODEX_HOME: ${report.sources.codexHome}`);
  lines.push(`  Versions: claude=${report.sources.versions.claude ?? "unavailable"}; codex=${report.sources.versions.codex ?? "unavailable"}`);
  lines.push(`Retention: cleanupPeriodDays=${report.retention.cleanupPeriodDays}; oldest Claude file=${report.retention.oldestAgeDays?.toFixed(1) ?? "none"} days (mtime)`);
  lines.push(`Schema canary: ${report.scan.filesScanned}/${report.scan.recentFiles} recent files; ${report.scan.bytesRead} bytes read; last ${report.scan.days} days${report.scan.limited ? "; stopped at 400 MB limit (partial scan)" : ""}`);
  const section = (title: string, values: { kind: string; count: number }[]) => {
    lines.push(`${title}: ${values.length ? values.length + " kinds/values" : "none"}`);
    for (const value of values) lines.push(`  ${JSON.stringify(value.kind)}: ${value.count}`);
  };
  section("Unknown timestamped Claude kinds", report.scan.unknownClaudeKinds);
  section("Unknown timestamped Codex kinds", report.scan.unknownCodexKinds);
  section("Unknown promptSource", report.scan.unknownPromptSources);
  section("Unknown originator", report.scan.unknownOriginators);
  section("Unknown source", report.scan.unknownSources);
  lines.push(`Structure: ${report.structure.nestedSubagentDirectories} unexpected subagent directories; ${report.structure.historyBaseFiles} scanned Codex files with history_base (info); ${report.structure.unreadableFiles} unreadable files; ${report.structure.inventoryFailures} inventory failures`);
  section("Codex files not read (warning)", report.structure.unsupportedFiles);
  section("Passive-record candidates (info; per-file gaps >10 min, no human prompt within 2 min)", report.passiveCandidates);
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  lines.push(report.status);
  return lines.join("\n");
}
