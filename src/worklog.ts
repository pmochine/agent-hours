/**
 * Hourly worklog extraction — deterministic, no LLM calls (hard constraint:
 * the CLI never spends API money). Pulls billing-relevant evidence per hour
 * from the JSONLs: typed prompts, edited files, commands, commits, and the
 * away_summary texts Claude Code itself wrote (free LLM summaries!).
 */
import { agentEditedFiles, parseArguments } from "./edits.js";
import {
  hourKey,
  isClaudeSubagentFile,
  isHumanPromptSource,
  isMachineGeneratedText,
  claudeProjectFiles,
  claudeQuestionAnswers,
  classifyRecord,
  type TimeZoneSpec,
} from "./core.js";
import { forEachJsonlRecord, isLogFileBefore } from "./jsonl.js";
import {
  findCodexSessionFiles,
  codexHumanInput,
  type CodexSessionBase,
} from "./sources/codex.js";

export interface HourLog {
  prompts: string[];
  filesEdited: Set<string>;
  commands: string[];
  commits: string[];
  awaySummaries: string[];
}

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

/** Collects per-hour worklog evidence. Keys: "YYYY-MM-DD HH:00" (local). */
export function collectWorklog(
  projectDir: string,
  sinceMs: number,
  untilMs: number,
  timeZone: TimeZoneSpec,
  projectPath?: string,
  includeDescendants = true
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

  for (const file of claudeProjectFiles(projectDir, projectPath, includeDescendants, { pruneBeforeMs: sinceMs })) {
    const isSubagent = isClaudeSubagentFile(file, projectDir);
    forEachJsonlRecord(file, (r) => {
      const tsStr = r["timestamp"];
      if (typeof tsStr !== "string") return;
      const ts = Date.parse(tsStr);
      if (Number.isNaN(ts) || ts < sinceMs || ts >= untilMs) return;

      for (const file of agentEditedFiles(r, "claude")) bucket(ts).filesEdited.add(file);
      const type = r["type"];

      // Human prompts (top-level transcripts only — subagent "user" msgs are machine)
      if (!isSubagent && r["isSidechain"] !== true) {
        if (type === "user" && !r["isMeta"] && !r["isCompactSummary"]) {
          const src = r["promptSource"];
          if (isHumanPromptSource(src) || src === undefined) {
            const answers = src === undefined && classifyRecord(r).kind === "prompt" ? claudeQuestionAnswers(r) : null;
            if (answers) {
              const text = Object.values(answers).map((value) => typeof value === "string" ? value : JSON.stringify(value)).join("; ");
              if (text) bucket(ts).prompts.push(excerpt(text));
            }
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
        if (!Array.isArray(c)) return;
        for (const item of c) {
          if (!item || typeof item !== "object") continue;
          const it = item as Record<string, unknown>;
          if (it["type"] !== "tool_use") continue;
          const name = String(it["name"] ?? "");
          const input = (it["input"] ?? {}) as Record<string, unknown>;
          if (name === "Bash" && typeof input["command"] === "string") {
            addCommand(bucket(ts), input["command"] as string);
          }
        }
      }
    });
  }
  return hours;
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

  for (const meta of findCodexSessionFiles(projectPath, baseDir)) {
    if (isLogFileBefore(meta.file, sinceMs)) continue;
    const effectiveSince = meta.subagent ? Math.max(sinceMs, meta.startedAt) : sinceMs;
    const seenCommandCalls = new Set<string>();
    forEachJsonlRecord(meta.file, (r) => {
      const tsStr = r["timestamp"];
      if (typeof tsStr !== "string") return;
      const ts = Date.parse(tsStr);
      if (Number.isNaN(ts) || ts < effectiveSince || ts >= untilMs) return;
      for (const file of agentEditedFiles(r, "codex")) bucket(ts).filesEdited.add(file);
      const payload = (r["payload"] ?? {}) as Record<string, unknown>;
      if (meta.interactive) {
        const input = codexHumanInput(r);
        if (input.prompt !== null) bucket(ts).prompts.push(excerpt(input.prompt));
      }

      if (r["type"] === "response_item") {
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
          }
        }
        return;
      }

      if (r["type"] !== "event_msg" || payload["type"] !== "item_completed") return;
      const item = (payload["item"] ?? {}) as Record<string, unknown>;
      const itemType = item["type"];
      if (itemType === "CommandExecution") {
        const callId = item["id"] ?? item["call_id"];
        if (typeof callId === "string" && seenCommandCalls.has(callId)) return;
        const cmd = codexCommand(item);
        if (cmd) {
          addCommand(bucket(ts), cmd);
          if (typeof callId === "string") seenCommandCalls.add(callId);
        }
      } else if (itemType === "AgentMessage" && item["phase"] === "final_answer") {
        const content = codexContentText(item["content"]);
        if (content && content.trim()) {
          bucket(ts).awaySummaries.push(excerpt(content, 200));
        }
      }
    });
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
