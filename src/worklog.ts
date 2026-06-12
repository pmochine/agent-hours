/**
 * Hourly worklog extraction — deterministic, no LLM calls (hard constraint:
 * the CLI never spends API money). Pulls billing-relevant evidence per hour
 * from the JSONLs: typed prompts, edited files, commands, commits, and the
 * away_summary texts Claude Code itself wrote (free LLM summaries!).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { hourKey } from "./core.js";

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
  tzOffsetHours: number
): Map<string, HourLog> {
  const hours = new Map<string, HourLog>();
  const bucket = (ts: number): HourLog => {
    const key = hourKey(ts, tzOffsetHours);
    let b = hours.get(key);
    if (!b) {
      b = { prompts: [], filesEdited: new Set(), commands: [], commits: [], awaySummaries: [] };
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
          if (src === "typed" || src === undefined) {
            const msg = r["message"] as Record<string, unknown> | undefined;
            const c = msg?.["content"];
            let text: string | null = null;
            if (typeof c === "string") text = c;
            else if (Array.isArray(c)) {
              const t = c.find(
                (i) => i && typeof i === "object" && (i as Record<string, unknown>)["type"] === "text"
              ) as Record<string, unknown> | undefined;
              const hasToolResult = c.some(
                (i) => i && typeof i === "object" && (i as Record<string, unknown>)["type"] === "tool_result"
              );
              if (t && !hasToolResult) text = String(t["text"] ?? "");
            }
            if (
              text &&
              !text.startsWith("[Request interrupted") &&
              !text.trimStart().startsWith("<command-") &&
              !text.trimStart().startsWith("<local-command")
            ) {
              bucket(ts).prompts.push(excerpt(text));
            }
          }
        }
        if (
          type === "queue-operation" &&
          r["operation"] === "enqueue" &&
          typeof r["content"] === "string" &&
          !(r["content"] as string).trimStart().startsWith("<task-notification")
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
            const cmd = input["command"] as string;
            if (/git commit/.test(cmd)) {
              // plain -m "msg" first; heredoc style (-m "$(cat <<EOF ... )")
              // falls through to the first heredoc line as the subject
              let m = cmd.match(/-m\s+["']([^"'$][^"']*)/);
              if (!m) m = cmd.match(/<<\s*'?EOF'?\s*\n\s*([^\n]+)/);
              if (m) {
                bucket(ts).commits.push(excerpt(m[1], 80));
                continue;
              }
            }
            bucket(ts).commands.push(condenseCommand(cmd));
          }
        }
      }
    }
  }
  return hours;
}

/** Shortens file paths to a common-sense display form (basename + parent). */
export function shortPath(p: string): string {
  const parts = p.split("/");
  return parts.length > 2 ? parts.slice(-2).join("/") : p;
}

/** Merges several hour buckets into one (for day/project aggregation). */
export function mergeLogs(logs: HourLog[]): HourLog {
  const out: HourLog = {
    prompts: [],
    filesEdited: new Set(),
    commands: [],
    commits: [],
    awaySummaries: [],
  };
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
