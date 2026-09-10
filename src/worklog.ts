/**
 * Hourly worklog extraction — deterministic, no LLM calls (hard constraint:
 * the CLI never spends API money). Pulls billing-relevant evidence per hour
 * from the JSONLs: typed prompts, edited files, commands, commits, and the
 * away_summary texts Claude Code itself wrote (free LLM summaries!).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  hourKey,
  isHumanPromptSource,
  isMachineGeneratedText,
  type TimeZoneSpec,
} from "./core.js";
import {
  findCodexSessionFiles,
  isSyntheticCodexUserText,
  type CodexSessionBase,
} from "./sources/codex.js";

export interface HourLog {
  prompts: string[];
  filesEdited: Set<string>;
  commands: string[];
  commits: string[];
  awaySummaries: string[];
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function excerpt(text: string, max = 90): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

function condenseCommand(cmd: string): string {
  return excerpt(cmd, 70);
}

function emptyHourLog(): HourLog {
  return { prompts: [], filesEdited: new Set(), commands: [], commits: [], awaySummaries: [] };
}

function addCommand(log: HourLog, cmd: string): void {
  if (/\bgit\s+commit\b/.test(cmd)) {
    let m = cmd.match(/-m\s+["']([^"'$][^"']*)/);
    if (!m) m = cmd.match(/<<\s*'?EOF'?\s*\n\s*([^\n]+)/);
    if (m) {
      log.commits.push(excerpt(m[1], 80));
      return;
    }
  }
  log.commands.push(condenseCommand(cmd));
}

function isUsefulWorklogPrompt(text: string): boolean {
  const trimmed = text.trimStart();
  return !trimmed.startsWith("<") && !trimmed.startsWith("[Request interrupted");
}

function jsonlFiles(projectDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => path.join(projectDir, e.name));
  for (const dir of entries.filter((e) => e.isDirectory())) {
    const subDir = path.join(projectDir, dir.name, "subagents");
    try {
      for (const f of fs.readdirSync(subDir)) {
        if (f.endsWith(".jsonl")) files.push(path.join(subDir, f));
      }
    } catch {
      /* no subagents dir */
    }
  }
  return files.sort();
}

/** Collects per-hour worklog evidence. Keys: "YYYY-MM-DD HH:00" (local). */
export function collectWorklog(
  projectDir: string,
  sinceMs: number,
  untilMs: number,
  timeZone: TimeZoneSpec
): Map<string, HourLog> {
  const hours = new Map<string, HourLog>();
  const bucket = (ts: number): HourLog => {
    const key = hourKey(ts, timeZone);
    let b = hours.get(key);
    if (!b) {
      b = emptyHourLog();
      hours.set(key, b);
    }
    return b;
  };

  for (const file of jsonlFiles(projectDir)) {
    const isSubagent = file.includes(`${path.sep}subagents${path.sep}`);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      const tsStr = r["timestamp"];
      if (typeof tsStr !== "string") continue;
      const ts = Date.parse(tsStr);
      if (Number.isNaN(ts) || ts < sinceMs || ts > untilMs) continue;

      const type = r["type"];

      // Human prompts (top-level transcripts only — subagent "user" msgs are machine)
      if (!isSubagent && r["isSidechain"] !== true) {
        if (type === "user" && !r["isMeta"] && !r["isCompactSummary"]) {
          const src = r["promptSource"];
          if (isHumanPromptSource(src) || src === undefined) {
            const msg = r["message"] as Record<string, unknown> | undefined;
            const c = msg?.["content"];
            let text: string | null = null;
            if (typeof c === "string") text = c;
            else if (Array.isArray(c)) {
              const t = c.find((i) => {
                if (!i || typeof i !== "object") return false;
                const item = i as Record<string, unknown>;
                return (
                  item["type"] === "text" &&
                  typeof item["text"] === "string" &&
                  isUsefulWorklogPrompt(item["text"] as string)
                );
              }) as Record<string, unknown> | undefined;
              const hasToolResult = c.some(
                (i) => i && typeof i === "object" && (i as Record<string, unknown>)["type"] === "tool_result"
              );
              if (t && !hasToolResult) text = String(t["text"] ?? "");
            }
            if (text && isUsefulWorklogPrompt(text)) {
              bucket(ts).prompts.push(excerpt(text));
            }
          }
        }
        if (
          type === "queue-operation" &&
          r["operation"] === "enqueue" &&
          typeof r["content"] === "string" &&
          !isMachineGeneratedText(r["content"] as string)
        ) {
          bucket(ts).prompts.push(excerpt(r["content"] as string));
        }
        if (type === "system" && r["subtype"] === "away_summary" && typeof r["content"] === "string") {
          bucket(ts).awaySummaries.push(excerpt(r["content"] as string, 200));
        }
      }

      // Tool activity counts from BOTH main and subagent transcripts —
      // subagent edits are real work product.
      if (type === "assistant") {
        const msg = r["message"] as Record<string, unknown> | undefined;
        const c = msg?.["content"];
        if (!Array.isArray(c)) continue;
        for (const item of c) {
          if (!item || typeof item !== "object") continue;
          const it = item as Record<string, unknown>;
          if (it["type"] !== "tool_use") continue;
          const name = String(it["name"] ?? "");
          const input = (it["input"] ?? {}) as Record<string, unknown>;
          if (EDIT_TOOLS.has(name) && typeof input["file_path"] === "string") {
            bucket(ts).filesEdited.add(input["file_path"] as string);
          } else if (name === "Bash" && typeof input["command"] === "string") {
            addCommand(bucket(ts), input["command"] as string);
          }
        }
      }
    }
  }
  return hours;
}

function codexMessageText(payload: Record<string, unknown>): string | null {
  const content = payload["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .filter((c) => c["type"] === "input_text" || c["type"] === "text")
    .map((c) => c["text"])
    .filter((t): t is string => typeof t === "string")
    .filter((t) => !isSyntheticCodexUserText(t));
  return parts.length ? parts.join("\n") : null;
}

function codexCommand(item: Record<string, unknown>): string | null {
  const command = item["command"];
  if (typeof command === "string") return command;
  if (Array.isArray(command)) {
    const strings = command.filter((v): v is string => typeof v === "string");
    return strings.length ? strings[strings.length - 1] : null;
  }
  return null;
}

function codexContentText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts = value
    .filter((part): part is Record<string, unknown> => !!part && typeof part === "object")
    .filter((part) => part["type"] === "text" || part["type"] === "output_text")
    .map((part) => part["text"])
    .filter((text): text is string => typeof text === "string");
  return parts.length ? parts.join("\n") : null;
}

function addPatchFiles(log: HourLog, patchText: string): void {
  for (const line of patchText.split("\n")) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s+(.+?)\s*$/);
    if (match) log.filesEdited.add(match[1]);
  }
}

function parseArguments(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Collects worklog evidence from current and legacy Codex rollout schemas. */
export function collectCodexWorklog(
  projectPath: string,
  sinceMs: number,
  untilMs: number,
  timeZone: TimeZoneSpec,
  baseDir?: CodexSessionBase
): Map<string, HourLog> {
  const hours = new Map<string, HourLog>();
  const bucket = (ts: number): HourLog => {
    const key = hourKey(ts, timeZone);
    let b = hours.get(key);
    if (!b) {
      b = emptyHourLog();
      hours.set(key, b);
    }
    return b;
  };

  for (const meta of findCodexSessionFiles(projectPath, sinceMs, untilMs, baseDir)) {
    let raw: string;
    try {
      raw = fs.readFileSync(meta.file, "utf8");
    } catch {
      continue;
    }
    const effectiveSince = meta.subagent ? Math.max(sinceMs, meta.startedAt) : sinceMs;
    const seenCommandCalls = new Set<string>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      const tsStr = r["timestamp"];
      if (typeof tsStr !== "string") continue;
      const ts = Date.parse(tsStr);
      if (Number.isNaN(ts) || ts < effectiveSince || ts > untilMs) continue;
      const payload = (r["payload"] ?? {}) as Record<string, unknown>;

      if (r["type"] === "response_item") {
        if (meta.interactive && payload["type"] === "message" && payload["role"] === "user") {
          const text = codexMessageText(payload);
          if (text && !isSyntheticCodexUserText(text)) bucket(ts).prompts.push(excerpt(text));
        }

        // Legacy Codex tool-call schema. Newer logs expose richer normalized
        // item_completed records below, so this is intentionally conservative.
        if (payload["type"] === "function_call" || payload["type"] === "custom_tool_call") {
          const name = String(payload["name"] ?? "");
          const callId = payload["call_id"] ?? payload["id"];
          const rawInput = payload["arguments"] ?? payload["input"];
          const args = parseArguments(rawInput);
          if ((name === "exec_command" || name === "shell" || name === "Bash") && args) {
            const cmd = args["cmd"] ?? args["command"];
            const normalized = codexCommand({ command: cmd });
            if (normalized && (typeof callId !== "string" || !seenCommandCalls.has(callId))) {
              addCommand(bucket(ts), normalized);
              if (typeof callId === "string") seenCommandCalls.add(callId);
            }
          } else if (name === "apply_patch") {
            const patchText =
              (args && (args["patch"] ?? args["input"])) ??
              (typeof rawInput === "string" && !args ? rawInput : null);
            if (typeof patchText === "string") addPatchFiles(bucket(ts), patchText);
          }
        }
        continue;
      }

      if (r["type"] !== "event_msg" || payload["type"] !== "item_completed") continue;
      const item = (payload["item"] ?? {}) as Record<string, unknown>;
      const itemType = item["type"];
      if (itemType === "CommandExecution") {
        const callId = item["id"] ?? item["call_id"];
        if (typeof callId === "string" && seenCommandCalls.has(callId)) continue;
        const cmd = codexCommand(item);
        if (cmd) {
          addCommand(bucket(ts), cmd);
          if (typeof callId === "string") seenCommandCalls.add(callId);
        }
      } else if (itemType === "FileChange") {
        const changes = item["changes"];
        if (changes && typeof changes === "object" && !Array.isArray(changes)) {
          for (const file of Object.keys(changes as Record<string, unknown>)) {
            bucket(ts).filesEdited.add(file);
          }
        }
      } else if (itemType === "AgentMessage" && item["phase"] === "final_answer") {
        const content = codexContentText(item["content"]);
        if (content && content.trim()) {
          bucket(ts).awaySummaries.push(excerpt(content, 200));
        }
      }
    }
  }
  return hours;
}

/** Merge evidence maps from several agent sources without losing file sets. */
export function mergeWorklogMaps(maps: Map<string, HourLog>[]): Map<string, HourLog> {
  const out = new Map<string, HourLog>();
  for (const map of maps) {
    for (const [key, log] of map) {
      const current = out.get(key);
      out.set(key, current ? mergeLogs([current, log]) : mergeLogs([log]));
    }
  }
  return out;
}

/** Shortens file paths to a common-sense display form (basename + parent). */
export function shortPath(p: string): string {
  const parts = p.split("/");
  return parts.length > 2 ? parts.slice(-2).join("/") : p;
}

/** Merges several hour buckets into one (for day/project aggregation). */
export function mergeLogs(logs: HourLog[]): HourLog {
  const out = emptyHourLog();
  for (const l of logs) {
    out.prompts.push(...l.prompts);
    for (const f of l.filesEdited) out.filesEdited.add(f);
    out.commands.push(...l.commands);
    out.commits.push(...l.commits);
    out.awaySummaries.push(...l.awaySummaries);
  }
  return out;
}

/**
 * Rule-based one-line description of a bucket — deterministic, no LLM.
 * Evidence priority: commits (best intent signal) > away summaries (prose
 * Claude Code already wrote) > prompt topics; plus an edited-files note.
 */
export function describeLog(l: HourLog, maxLen = 240): string {
  const parts: string[] = [];
  if (l.commits.length) {
    const shown = l.commits.slice(0, 3);
    parts.push(
      `Commits: ${shown.join(" · ")}${l.commits.length > 3 ? ` (+${l.commits.length - 3})` : ""}`
    );
  }
  if (l.awaySummaries.length) {
    parts.push(l.awaySummaries[l.awaySummaries.length - 1]);
  } else if (!l.commits.length && l.prompts.length) {
    parts.push(`Topics: ${l.prompts.slice(0, 2).join(" · ")}`);
  }
  if (l.filesEdited.size) {
    const files = [...l.filesEdited].map(shortPath);
    parts.push(
      `${files.length} file${files.length > 1 ? "s" : ""}: ${files.slice(0, 4).join(", ")}${files.length > 4 ? " …" : ""}`
    );
  }
  if (!parts.length && l.prompts.length) parts.push(`Topics: ${l.prompts[0]}`);
  if (!parts.length && l.commands.length) parts.push(`Commands: ${l.commands.slice(0, 2).join(" | ")}`);
  const joined = parts.join(" — ");
  return joined.length > maxLen ? joined.slice(0, maxLen - 1) + "…" : joined;
}

export const WORKLOG_LLM_TEMPLATE =
  "Below is a structured hourly worklog extracted from coding-agent session logs. " +
  "For each hour, write ONE concise line (max 15 words) describing the work done, " +
  "suitable as an invoice attachment. Then add a 3-sentence overall summary. " +
  "Keep technical terms, skip pleasantries.";
