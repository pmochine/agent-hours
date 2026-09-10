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
import type { NamedSession, SessionEvent } from "../core.js";

export const CODEX_HOME = process.env["CODEX_HOME"] || path.join(os.homedir(), ".codex");
export const CODEX_SESSIONS_BASE = path.join(CODEX_HOME, "sessions");
export const CODEX_ARCHIVED_SESSIONS_BASE = path.join(CODEX_HOME, "archived_sessions");

export type CodexSessionBase = string | string[];

export interface CodexSessionFile {
  file: string;
  cwd: string;
  sessionId: string | null;
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

function isSubagentSource(payload: Record<string, unknown>): boolean {
  const source = payload["source"];
  if (source && typeof source === "object" && "subagent" in source) return true;
  return payload["thread_source"] === "subagent" || typeof payload["parent_thread_id"] === "string";
}

/** Read the first session_meta only; later metadata may be inherited context. */
function readMeta(file: string): CodexSessionFile | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const CHUNK = 65536;
    const MAX = 4 * 1024 * 1024;
    let data = Buffer.alloc(0);
    let pos = 0;
    let nl = -1;
    while (nl < 0 && pos < MAX) {
      const buf = Buffer.alloc(CHUNK);
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      data = Buffer.concat([data, buf.subarray(0, n)]);
      pos += n;
      nl = data.indexOf(0x0a);
    }
    const firstLine = (nl >= 0 ? data.subarray(0, nl) : data).toString("utf8");
    const rec = JSON.parse(firstLine) as Record<string, unknown>;
    if (rec["type"] !== "session_meta") return null;
    const payload = (rec["payload"] ?? {}) as Record<string, unknown>;
    if (typeof payload["cwd"] !== "string") return null;
    const subagent = isSubagentSource(payload);
    const source = payload["source"];
    const ts = typeof rec["timestamp"] === "string" ? Date.parse(rec["timestamp"] as string) : NaN;
    const rawId = payload["id"] ?? payload["session_id"];
    return {
      file,
      cwd: payload["cwd"] as string,
      sessionId: typeof rawId === "string" ? rawId : null,
      interactive:
        !subagent &&
        (source === undefined ||
          (typeof source === "string" && source !== "exec" && source !== "mcp")),
      subagent,
      startedAt: Number.isNaN(ts) ? 0 : ts,
    };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function userText(payload: Record<string, unknown>): string | null {
  const content = payload["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts = content
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .filter((c) => c["type"] === "input_text" || c["type"] === "text")
    .map((c) => c["text"])
    .filter((t): t is string => typeof t === "string")
    .filter((t) => !isSyntheticCodexUserText(t));
  return texts.length ? texts.join("\n") : null;
}

/** Known Codex-injected user-role context, not text typed by the person. */
export function isSyntheticCodexUserText(text: string): boolean {
  // Current Codex rollouts often put one or more XML-like context envelopes
  // before the real human input in the same multipart message.
  const trimmed = text.trimStart();
  return trimmed.startsWith("<") || trimmed.startsWith("# AGENTS.md instructions for ");
}

function parseEvents(meta: CodexSessionFile, sinceMs: number, untilMs: number): SessionEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(meta.file, "utf8");
  } catch {
    return [];
  }
  const events: SessionEvent[] = [];
  // Current subagent rollouts can contain a replay of parent history. Its
  // original timestamps predate the child session_meta and must not count twice.
  const effectiveSince = meta.subagent ? Math.max(sinceMs, meta.startedAt) : sinceMs;
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

    let kind: SessionEvent["kind"] = "work";
    let presence = false;
    const p = (r["payload"] ?? {}) as Record<string, unknown>;
    if (meta.interactive && r["type"] === "response_item") {
      if (p["type"] === "message" && p["role"] === "user") {
        const text = userText(p);
        if (text && !isSyntheticCodexUserText(text)) {
          kind = "prompt";
          presence = true;
        }
      }
    }
    const item = (p["item"] ?? {}) as Record<string, unknown>;
    const reactionAnchor =
      (r["type"] === "response_item" && p["type"] === "message" && p["role"] === "assistant") ||
      (r["type"] === "event_msg" &&
        p["type"] === "item_completed" &&
        item["type"] === "AgentMessage");
    events.push({ ts, kind, presence, reactionAnchor });
  }
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
): CodexSessionFile[] {
  const seenIds = new Set<string>();
  const files: CodexSessionFile[] = [];
  for (const dir of baseDirs(baseDir)) {
    for (const file of walkJsonl(dir).sort()) {
      const meta = readMeta(file);
      if (!meta) continue;
      const dedupeKey = meta.sessionId ?? canonicalProjectPath(file);
      if (seenIds.has(dedupeKey)) continue;
      seenIds.add(dedupeKey);
      if (projectPath && !belongsToProject(meta.cwd, projectPath, includeDescendants)) continue;
      files.push(meta);
    }
  }
  return files;
}

/** Load every unique Codex rollout once, preferring active over archived copies. */
export function scanCodexSessions(
  sinceMs: number,
  untilMs: number,
  baseDir?: CodexSessionBase,
  projectPath?: string,
  includeDescendants = true
): ScannedCodexSession[] {
  const scanned: ScannedCodexSession[] = [];
  for (const meta of scanCodexMetadata(baseDir, projectPath, includeDescendants)) {
      const events = parseEvents(meta, sinceMs, untilMs);
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

/** Loads Codex sessions whose cwd is the project path (or inside it). */
export function loadCodexSessions(
  projectPath: string,
  sinceMs: number,
  untilMs: number,
  baseDir?: CodexSessionBase,
  includeDescendants = true
): NamedSession[] {
  return scanCodexSessions(sinceMs, untilMs, baseDir, projectPath, includeDescendants).map(
    (s) => s.session
  );
}

/** Same matching as loadCodexSessions, without parsing every unrelated rollout. */
export function findCodexSessionFiles(
  projectPath: string,
  sinceMs: number,
  untilMs: number,
  baseDir?: CodexSessionBase,
  includeDescendants = true
): CodexSessionFile[] {
  // The caller still filters individual records to the requested time range.
  void sinceMs;
  void untilMs;
  return scanCodexMetadata(baseDir, projectPath, includeDescendants);
}
