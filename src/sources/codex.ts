/**
 * Codex CLI source adapter.
 *
 * Codex stores sessions in ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
 * Every line has a top-level ISO `timestamp`; the first line is a
 * `session_meta` record carrying `payload.cwd` (project matching) and
 * `payload.source` ("exec" = non-interactive run launched by a script or
 * another agent — its "user" messages are machine-authored, so the whole
 * session counts as AI runtime; "tui"/IDE sessions have real human prompts).
 *
 * Verified against real logs 2026-06-12 (Codex CLI 0.135/0.139).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { NamedSession, SessionEvent } from "../core.js";

export const CODEX_SESSIONS_BASE = path.join(os.homedir(), ".codex", "sessions");

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

interface CodexMeta {
  cwd: string | null;
  interactive: boolean;
}

/**
 * Cheap header check: only the first line is needed to match the project.
 * The session_meta line can be huge (it embeds the agent's base instructions),
 * so read in growing chunks until the first newline appears.
 */
function readMeta(file: string): CodexMeta | null {
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
    return {
      cwd: typeof payload["cwd"] === "string" ? (payload["cwd"] as string) : null,
      interactive: payload["source"] !== "exec",
    };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function parseEvents(
  file: string,
  sinceMs: number,
  untilMs: number,
  interactive: boolean
): SessionEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const events: SessionEvent[] = [];
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

    let kind: SessionEvent["kind"] = "work";
    let presence = false;
    if (interactive && r["type"] === "response_item") {
      const p = (r["payload"] ?? {}) as Record<string, unknown>;
      if (p["type"] === "message" && p["role"] === "user") {
        const content = p["content"];
        const text = Array.isArray(content)
          ? (content.find(
              (c) => c && typeof c === "object" && (c as Record<string, unknown>)["type"] === "input_text"
            ) as Record<string, unknown> | undefined)?.["text"]
          : undefined;
        // Codex injects environment/permission context as user-role messages
        // wrapped in <tags> — those are not human.
        if (typeof text === "string" && !text.trimStart().startsWith("<")) {
          kind = "prompt";
          presence = true;
        }
      }
    }
    events.push({ ts, kind, presence });
  }
  events.sort((a, b) => a.ts - b.ts);
  return events;
}

/**
 * Loads all Codex sessions whose cwd is the project path (or inside it).
 * Session names are prefixed "codex:" for --by-session readability.
 */
export function loadCodexSessions(
  projectPath: string,
  sinceMs: number,
  untilMs: number,
  baseDir: string = CODEX_SESSIONS_BASE
): NamedSession[] {
  const project = path.resolve(projectPath);
  const sessions: NamedSession[] = [];
  for (const file of walkJsonl(baseDir).sort()) {
    const meta = readMeta(file);
    if (!meta || !meta.cwd) continue;
    if (meta.cwd !== project && !meta.cwd.startsWith(project + path.sep)) continue;
    const events = parseEvents(file, sinceMs, untilMs, meta.interactive);
    if (events.length > 0) {
      sessions.push({ name: `codex:${path.relative(baseDir, file)}`, events });
    }
  }
  return sessions;
}
