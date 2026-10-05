/**
 * Codex CLI source adapter.
 *
 * Codex stores active sessions below <codex-home>/sessions and completed or
 * manually archived sessions below <codex-home>/archived_sessions. The first
 * session_meta record carries the project cwd and the session source.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { agentEditedFiles, normalizeEditedPath } from "../edits.js";
import { forEachJsonlRecord, isLogFileBefore } from "../jsonl.js";
import type { NamedSession, SessionEvent, TimelineLoadOptions } from "../core.js";

export const CODEX_HOME = process.env["CODEX_HOME"] || path.join(os.homedir(), ".codex");
export const CODEX_SESSIONS_BASE = path.join(CODEX_HOME, "sessions");
export const CODEX_ARCHIVED_SESSIONS_BASE = path.join(CODEX_HOME, "archived_sessions");

export type CodexSessionBase = string | string[];

export interface CodexSessionFile {
  file: string;
  cwd: string;
  sessionId: string | null;
  historyBaseEndOrdinal: number | null;
  interactive: boolean;
  subagent: boolean;
  startedAt: number;
}

export interface ScannedCodexSession extends CodexSessionFile {
  session: NamedSession;
}

export function defaultCodexSessionDirs(): string[] {
  return [CODEX_SESSIONS_BASE, CODEX_ARCHIVED_SESSIONS_BASE];
}

function walkJsonl(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** Resolve symlinks where possible and make macOS NFC/NFD paths comparable. */
export function canonicalProjectPath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved).normalize("NFC");
  } catch {
    return resolved.normalize("NFC");
  }
}

/** Shared adapter/doctor classification of the unflattened session metadata. */
export function classifyCodexSessionMeta(payload: Record<string, unknown>): { interactive: boolean; subagent: boolean } {
  const source = payload["source"];
  const subagent = !!(source && typeof source === "object" && "subagent" in source) ||
    payload["thread_source"] === "subagent" || typeof payload["parent_thread_id"] === "string";
  return {
    subagent,
    interactive: !subagent && payload["originator"] !== "Claude Code" &&
      (source === undefined || (typeof source === "string" && source !== "exec" && source !== "mcp")),
  };
}

const metaCache = new Map<string, { mtimeMs: number; size: number; meta: CodexSessionFile | null }>();

/** The first object record must be session_meta; later records may be inherited context. */
function readMeta(file: string): CodexSessionFile | null {
  let stat: fs.Stats | undefined;
  try { stat = fs.statSync(file); } catch { /* The reader reports unreadable files. */ }
  const cached = metaCache.get(file);
  if (stat && cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.meta;
  const remember = (meta: CodexSessionFile | null): CodexSessionFile | null => {
    if (stat) metaCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
    return meta;
  };
  let rec: Record<string, unknown> | null = null;
  forEachJsonlRecord(file, (record) => {
    if (record["type"] === "session_meta") rec = record;
    return false;
  }, { chunkSize: 64 * 1024 });
  if (!rec) return remember(null);
  const record = rec as Record<string, unknown>;
  const payload = (record["payload"] ?? {}) as Record<string, unknown>;
  if (typeof payload["cwd"] !== "string") return remember(null);
  const ts = typeof record["timestamp"] === "string" ? Date.parse(record["timestamp"] as string) : NaN;
  const rawId = payload["id"] ?? payload["session_id"];
  const historyBase = payload["history_base"] as Record<string, unknown> | undefined;
  return remember({
    file,
    cwd: payload["cwd"] as string,
    sessionId: typeof rawId === "string" ? rawId : null,
    historyBaseEndOrdinal:
      typeof historyBase?.["end_ordinal_exclusive"] === "number"
        ? historyBase["end_ordinal_exclusive"] : null,
    ...classifyCodexSessionMeta(payload),
    startedAt: Number.isNaN(ts) ? 0 : ts,
  });
}

function userTextParts(payload: Record<string, unknown>): string[] {
  const content = payload["content"];
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .filter((c) => c["type"] === "input_text" || c["type"] === "text")
    .map((c) => c["text"])
    .filter((t): t is string => typeof t === "string");
}

/** Known Codex-injected user-role context, not text typed by the person. */
export function isSyntheticCodexUserText(text: string): boolean {
  // Current Codex rollouts often put one or more XML-like context envelopes
  // before the real human input in the same multipart message.
  const trimmed = text.trimStart();
  return (trimmed.startsWith("<") && !trimmed.startsWith("<send_user_message_question_reply>")) ||
    trimmed.startsWith("# AGENTS.md instructions for ");
}

/** Human input shared by the timeline and worklog; call only for interactive sessions. */
export function codexHumanInput(record: Record<string, unknown>): { prompt: string | null; presence: boolean } {
  const payload = (record["payload"] ?? {}) as Record<string, unknown>;
  if (record["type"] === "realtime_item" && payload["type"] === "transcript_segment" &&
      payload["role"] === "user" && typeof payload["text"] === "string") {
    return { prompt: payload["text"], presence: true };
  }
  if (record["type"] === "response_item" && payload["type"] === "message" && payload["role"] === "user") {
    const parts = userTextParts(payload);
    const first = parts[0]?.trimStart();
    // Delegated speech is derived agent work; writing edits prove presence only.
    if (first?.startsWith("<realtime_delegation>")) return { prompt: null, presence: false };
    if (first?.startsWith("<external_codex_apps_writing_block_edits>")) {
      return { prompt: null, presence: true };
    }
    const text = parts.filter((part) => !isSyntheticCodexUserText(part)).join("\n");
    if (text) return { prompt: text, presence: true };
  }
  return { prompt: null, presence: false };
}

function parseEvents(meta: CodexSessionFile, options: TimelineLoadOptions): SessionEvent[] {
  if (isLogFileBefore(meta.file, options.pruneBeforeMs)) {
    if (options.stats) options.stats.prunedFiles++;
    return [];
  }
  const events: SessionEvent[] = [];
  // Subagents may replay parent history before their own start.
  const effectiveSince = meta.subagent ? meta.startedAt : -Infinity;
  forEachJsonlRecord(meta.file, (r) => {
    const tsStr = r["timestamp"];
    if (typeof tsStr !== "string") return;
    const ts = Date.parse(tsStr);
    if (Number.isNaN(ts) || ts < effectiveSince) return;

    const p = (r["payload"] ?? {}) as Record<string, unknown>;
    // Bookkeeping often has no following human message (69 of 246 measured cases).
    if (r["type"] === "event_msg" && p["type"] === "thread_settings_applied") return;
    const input = meta.interactive ? codexHumanInput(r) : { prompt: null, presence: false };
    const kind: SessionEvent["kind"] = input.prompt !== null ? "prompt" : "work";
    const item = (p["item"] ?? {}) as Record<string, unknown>;
    const reactionAnchor =
      (r["type"] === "response_item" && p["type"] === "message" && p["role"] === "assistant") ||
      (r["type"] === "event_msg" &&
        p["type"] === "item_completed" &&
        item["type"] === "AgentMessage") ||
      (meta.interactive && r["type"] === "realtime_item" &&
        p["type"] === "transcript_segment" && p["role"] === "assistant");
    const agentEdits = agentEditedFiles(r, "codex").map((file) => normalizeEditedPath(file, meta.cwd));
    events.push({ ts, kind, presence: input.presence, reactionAnchor, ...(agentEdits.length ? { agentEdits } : {}) });
  });
  events.sort((a, b) => a.ts - b.ts);
  return events;
}

function baseDirs(baseDir?: CodexSessionBase): string[] {
  if (Array.isArray(baseDir)) return baseDir;
  return baseDir ? [baseDir] : defaultCodexSessionDirs();
}

function scanCodexMetadata(
  baseDir?: CodexSessionBase,
  projectPath?: string,
  includeDescendants = true
): Map<string, CodexSessionFile[]> {
  const seenIds = new Set<string>();
  const files: CodexSessionFile[] = [];
  for (const dir of baseDirs(baseDir)) {
    for (const file of walkJsonl(dir).sort()) {
      const meta = readMeta(file);
      if (!meta) continue;
      const dedupeKey = JSON.stringify([meta.sessionId ?? canonicalProjectPath(file), meta.historyBaseEndOrdinal]);
      if (seenIds.has(dedupeKey)) continue;
      seenIds.add(dedupeKey);
      files.push(meta);
    }
  }
  // Continuations contain only new records. Use the base thread's source for all segments.
  const threads = groupSegments(files);
  for (const [key, segments] of threads) {
    const base = baseSegment(segments);
    if (projectPath && !belongsToProject(base.cwd, projectPath, includeDescendants)) {
      threads.delete(key);
      continue;
    }
    threads.set(key, segments
      .sort((a, b) => (a.historyBaseEndOrdinal ?? -1) - (b.historyBaseEndOrdinal ?? -1))
      .map((meta) => ({ ...meta, interactive: base.interactive, subagent: base.subagent })));
  }
  return threads;
}

function groupSegments(files: CodexSessionFile[]): Map<string, CodexSessionFile[]> {
  const threads = new Map<string, CodexSessionFile[]>();
  for (const meta of files) {
    const key = meta.sessionId ?? canonicalProjectPath(meta.file);
    const segments = threads.get(key) ?? [];
    segments.push(meta);
    threads.set(key, segments);
  }
  return threads;
}

function baseSegment(segments: CodexSessionFile[]): CodexSessionFile {
  return segments.find((meta) => meta.historyBaseEndOrdinal === null) ??
    [...segments].sort((a, b) => a.historyBaseEndOrdinal! - b.historyBaseEndOrdinal!)[0];
}

/** Merge each thread's unique segments, preferring active over archived copies. */
export function scanCodexSessions(
  options: TimelineLoadOptions = {},
  baseDir?: CodexSessionBase,
  projectPath?: string,
  includeDescendants = true
): ScannedCodexSession[] {
  const scanned: ScannedCodexSession[] = [];
  for (const segments of scanCodexMetadata(baseDir, projectPath, includeDescendants).values()) {
    const meta = baseSegment(segments);
    const events = segments.flatMap((segment) => parseEvents(segment, options))
      .sort((a, b) => a.ts - b.ts);
    if (!events.length) continue;
    const containingDir = baseDirs(baseDir).find((dir) => meta.file.startsWith(dir + path.sep));
    scanned.push({
      ...meta,
      session: {
        name: `codex:${path.relative(containingDir ?? path.dirname(meta.file), meta.file)}`,
        events,
      },
    });
  }
  return scanned;
}

function belongsToProject(cwd: string, projectPath: string, includeDescendants: boolean): boolean {
  const actual = canonicalProjectPath(cwd);
  const project = canonicalProjectPath(projectPath);
  return actual === project || (includeDescendants && actual.startsWith(project + path.sep));
}

/** Loads complete Codex timelines whose cwd is the project path (or inside it). */
export function loadCodexSessions(
  projectPath: string,
  options: TimelineLoadOptions = {},
  baseDir?: CodexSessionBase,
  includeDescendants = true
): NamedSession[] {
  return scanCodexSessions(options, baseDir, projectPath, includeDescendants).map(
    (s) => s.session
  );
}

/** All matching metadata, including old bases needed to classify continuations. */
export function findCodexSessionFiles(
  projectPath: string,
  baseDir?: CodexSessionBase,
  includeDescendants = true
): CodexSessionFile[] {
  return [...scanCodexMetadata(baseDir, projectPath, includeDescendants).values()].flat();
}
