/**
 * claude-hours core — ported 1:1 from the battle-tested Python reference
 * (reference/claude_hours.py + reference/prototype-split.py).
 *
 * Parity is enforced by test/parity.test.mjs: same fixtures through both
 * implementations must yield identical numbers.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export type EventKind = "prompt" | "work";

export interface SessionEvent {
  /** epoch milliseconds, UTC */
  ts: number;
  /** "prompt" = real human input; "work" = assistant/tool/meta traffic */
  kind: EventKind;
  /**
   * Hard evidence the human was present at this moment (typed prompt, queued
   * message typed mid-turn, file edited in an external editor, interrupt).
   * Used by the three-state model to upgrade "supervised" confidence.
   */
  presence: boolean;
}

export interface NamedSession {
  name: string;
  events: SessionEvent[];
}

export interface Pause {
  startMs: number;
  endMs: number;
  minutes: number;
}

export const PROJECTS_BASE = path.join(os.homedir(), ".claude", "projects");

/**
 * /Users/x/code/foo -> -Users-x-code-foo (Claude Code's project dir naming).
 * Two non-obvious rules, both verified against real dirs:
 *  1. Claude Code replaces EVERY non-alphanumeric character with "-", not just
 *     path separators — so "manuel-mühlhoffs-bot" -> "manuel-m-hlhoffs-bot".
 *  2. macOS hands paths to a process in NFD form (the "ü" arrives decomposed
 *     as "u" + combining diaeresis), but Claude Code stores the dir in NFC.
 *     Without normalizing first, the decomposed "u" survives as "mu-" and the
 *     folder is missed. Normalize to NFC before sanitizing.
 */
export function projectToHash(p: string): string {
  return path.resolve(p).normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
}

export function findProjectDir(projectArg?: string): string {
  let hashName: string;
  if (projectArg) {
    hashName =
      projectArg.includes(path.sep) || projectArg.startsWith("/")
        ? projectToHash(projectArg)
        : projectArg;
  } else {
    hashName = projectToHash(process.cwd());
  }
  return path.join(PROJECTS_BASE, hashName);
}

export interface Classified {
  kind: EventKind;
  presence: boolean;
}

/**
 * Event classification, verified against real Claude Code logs (2026-06):
 *
 * - `promptSource` (newer logs): "typed" = human, "system" = scheduled
 *   tasks/hooks (phantom prompts!), "queued" = injection moment of a queued
 *   message — the human typing already happened at the queue-operation
 *   enqueue event, so the injection itself is NOT human time.
 * - `queue-operation` enqueue with human content = the moment of real typing
 *   WHILE Claude was running (strong presence proof). Enqueues carrying
 *   `<task-notification>` payloads are system traffic.
 * - `isSidechain` = subagent transcript — machine, never a human prompt.
 * - `isCompactSummary` = synthetic continuation prompt, not human.
 * - `attachment` edited_text_file = user edited a file in an external editor
 *   (presence proof, not a prompt).
 * - Legacy logs without `promptSource` fall back to the shape heuristic:
 *   type=user, not isMeta, content is a string or has text but no tool_result.
 */
export function classifyRecord(record: unknown): Classified {
  const work: Classified = { kind: "work", presence: false };
  const r = record as Record<string, unknown> | null;
  if (!r) return work;
  if (r["isSidechain"] === true) return work;

  const t = r["type"];
  if (t === "queue-operation") {
    const content = r["content"];
    if (
      r["operation"] === "enqueue" &&
      typeof content === "string" &&
      !content.trimStart().startsWith("<task-notification")
    ) {
      return { kind: "prompt", presence: true };
    }
    return work;
  }
  if (t === "attachment") {
    const a = r["attachment"] as Record<string, unknown> | undefined;
    if (a?.["type"] === "edited_text_file") return { kind: "work", presence: true };
    return work;
  }
  if (t === "user" && !r["isMeta"] && !r["isCompactSummary"]) {
    const src = r["promptSource"];
    if (src === "system" || src === "queued") return work;
    if (src === "typed") return { kind: "prompt", presence: true };
    const msg = r["message"] as Record<string, unknown> | undefined;
    const c = msg?.["content"];
    if (typeof c === "string") return { kind: "prompt", presence: true };
    if (Array.isArray(c)) {
      const items = c.filter(
        (i): i is Record<string, unknown> => i !== null && typeof i === "object"
      );
      const hasText = items.some((i) => i["type"] === "text");
      const hasToolResult = items.some((i) => i["type"] === "tool_result");
      if (hasText && !hasToolResult) return { kind: "prompt", presence: true };
    }
  }
  return work;
}

/** Convenience wrapper: just the kind. */
export function classifyKind(record: unknown): EventKind {
  return classifyRecord(record).kind;
}

/**
 * Reads all events of one session JSONL, filtered to [sinceMs, untilMs].
 * With forceWork (subagent transcripts) every event counts as machine work —
 * subagent "user" messages are task prompts from the orchestrator, not humans.
 */
export function loadSessionEvents(
  jsonlPath: string,
  sinceMs: number,
  untilMs: number,
  forceWork = false
): SessionEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(jsonlPath, "utf8");
  } catch {
    return [];
  }
  const events: SessionEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const tsStr = (record as Record<string, unknown>)?.["timestamp"];
    if (typeof tsStr !== "string") continue;
    const ts = Date.parse(tsStr);
    if (Number.isNaN(ts)) continue;
    if (ts < sinceMs || ts > untilMs) continue;
    if (forceWork) {
      events.push({ ts, kind: "work", presence: false });
    } else {
      const c = classifyRecord(record);
      events.push({ ts, kind: c.kind, presence: c.presence });
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  return events;
}

/**
 * Loads all sessions of a project directory: top-level *.jsonl PLUS subagent
 * transcripts in <sessionUuid>/subagents/agent-*.jsonl (newer Claude Code
 * versions store parallel-agent work there — missing them undercounts total
 * activity whenever only subagents were running).
 */
export function loadProject(
  projectDir: string,
  sinceMs: number,
  untilMs: number
): NamedSession[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions: NamedSession[] = [];
  for (const f of entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => e.name).sort()) {
    const events = loadSessionEvents(path.join(projectDir, f), sinceMs, untilMs);
    if (events.length > 0) sessions.push({ name: f, events });
  }
  for (const dir of entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const subDir = path.join(projectDir, dir, "subagents");
    let subFiles: string[];
    try {
      subFiles = fs.readdirSync(subDir).filter((f) => f.endsWith(".jsonl")).sort();
    } catch {
      continue;
    }
    for (const f of subFiles) {
      const events = loadSessionEvents(path.join(subDir, f), sinceMs, untilMs, true);
      if (events.length > 0) sessions.push({ name: `${dir}/subagents/${f}`, events });
    }
  }
  return sessions;
}

/**
 * Industry-standard active time (WakaTime/RescueTime style): sum of
 * inter-event gaps, each gap capped at capMinutes ("cap bonus" — a pause
 * longer than the cap still contributes capMinutes).
 */
export function activeMinutes(timesMs: number[], capMinutes: number): number {
  if (timesMs.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < timesMs.length; i++) {
    const gap = (timesMs[i] - timesMs[i - 1]) / 60000;
    total += Math.min(gap, capMinutes);
  }
  return total;
}

/** Strict variant: gaps > cap count 0 (no cap bonus). Honest lower bound. */
export function activeMinutesStrict(timesMs: number[], capMinutes: number): number {
  if (timesMs.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < timesMs.length; i++) {
    const gap = (timesMs[i] - timesMs[i - 1]) / 60000;
    if (gap <= capMinutes) total += gap;
  }
  return total;
}

/** All gaps >= minMinutes, sorted by duration descending. */
export function findPauses(timesMs: number[], minMinutes: number): Pause[] {
  const pauses: Pause[] = [];
  for (let i = 1; i < timesMs.length; i++) {
    const minutes = (timesMs[i] - timesMs[i - 1]) / 60000;
    if (minutes >= minMinutes) {
      pauses.push({ startMs: timesMs[i - 1], endMs: timesMs[i], minutes });
    }
  }
  pauses.sort((a, b) => b.minutes - a.minutes);
  return pauses;
}

/**
 * Merge all sessions into ONE sorted timeline. Critical for parallel
 * sessions/agents: per-session sums would double-count overlapping wall-clock
 * time; the merged timeline counts every real minute exactly once.
 */
export function mergeEvents(sessions: NamedSession[]): SessionEvent[] {
  const merged: SessionEvent[] = [];
  for (const s of sessions) merged.push(...s.events);
  merged.sort((a, b) => a.ts - b.ts);
  return merged;
}

/** True if at least two sessions' time windows overlap. */
export function detectOverlaps(sessions: NamedSession[]): boolean {
  const ranges = sessions
    .filter((s) => s.events.length >= 2)
    .map((s) => [s.events[0].ts, s.events[s.events.length - 1].ts] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i][0] < ranges[i - 1][1]) return true;
  }
  return false;
}

export interface SplitResult {
  totalMinutes: number;
  humanMinutes: number;
  aiSoloMinutes: number;
  promptCount: number;
}

/**
 * The core USP. Total = capped inter-event time over the merged timeline of
 * ALL events. Human-active = capped inter-PROMPT time (its own cap — "waiting
 * for Claude and testing" counts as active). AI-solo = total − human.
 */
export function computeSplit(
  merged: SessionEvent[],
  capMinutes: number,
  promptCapMinutes: number
): SplitResult {
  const allTimes = merged.map((e) => e.ts);
  const promptTimes = merged.filter((e) => e.kind === "prompt").map((e) => e.ts);
  const totalMinutes = activeMinutes(allTimes, capMinutes);
  const humanMinutes = activeMinutes(promptTimes, promptCapMinutes);
  return {
    totalMinutes,
    humanMinutes: Math.min(humanMinutes, totalMinutes),
    aiSoloMinutes: Math.max(0, totalMinutes - humanMinutes),
    promptCount: promptTimes.length,
  };
}

/** Local-date key (YYYY-MM-DD) for a UTC timestamp at the given offset. */
export function dayKey(tsMs: number, tzOffsetHours: number): string {
  return new Date(tsMs + tzOffsetHours * 3600_000).toISOString().slice(0, 10);
}

/** Local-hour key (YYYY-MM-DD HH:00) for a UTC timestamp at the given offset. */
export function hourKey(tsMs: number, tzOffsetHours: number): string {
  return (
    new Date(tsMs + tzOffsetHours * 3600_000).toISOString().slice(0, 13).replace("T", " ") +
    ":00"
  );
}

export interface HourStates {
  total: number;
  handsOn: number;
  supervised: number;
  ai: number;
}

export interface RefinedSplit {
  totalMinutes: number;
  /** Idle gaps + reaction tails right before prompts — provably human. */
  handsOnMinutes: number;
  /** Claude-working time weighted by watch probability. */
  supervisedMinutes: number;
  /** handsOn + supervised — the defensible "human attention" estimate. */
  attentionMinutes: number;
  /** Old inter-prompt heuristic — everything between prompts counts. */
  upperBoundMinutes: number;
  /** total − attention. */
  aiAutonomousMinutes: number;
  promptCount: number;
  byHour: Map<string, HourStates>;
}

export interface RefinedOptions {
  capMinutes: number;
  promptCapMinutes: number;
  tzOffsetHours: number;
  /** Reaction faster than this (minutes) ⇒ user watched the whole window. */
  watchFullMinutes?: number;
  /** Reaction up to this (minutes) ⇒ half the window counts as supervised. */
  watchHalfMinutes?: number;
}

/**
 * Three-state model (replaces the binary inter-prompt heuristic, which counts
 * Claude-working time inside prompt windows as fully human):
 *
 * Per prompt-to-prompt window, capped at promptCapMinutes (same cap semantics
 * as the old heuristic, so the old number stays a true upper bound):
 *
 * 1. hands-on  — the reaction tail: time between the last event of any kind
 *    and the next prompt. The human provably read/thought/typed then.
 * 2. supervised — the agent-working part of the capped window, weighted by
 *    watch evidence: reaction < 30 s ⇒ they were watching ⇒ 100 %, < 5 min ⇒
 *    50 %, else 0 %. Hard presence proof inside the window (message typed
 *    mid-turn, external file edit) forces 100 %.
 * 3. AI autonomous — total minus the two above.
 *
 * Invariant: handsOn + supervised <= upperBound (old heuristic) <= total.
 * A fast reaction proves presence at the END of a window, not throughout —
 * capping supervision at the prompt-cap window encodes exactly that.
 */
export function computeRefinedSplit(
  merged: SessionEvent[],
  opts: RefinedOptions
): RefinedSplit {
  const WATCH_FULL = opts.watchFullMinutes ?? 0.5;
  const WATCH_HALF = opts.watchHalfMinutes ?? 5;
  const n = merged.length;

  const promptIdx: number[] = [];
  for (let i = 0; i < n; i++) if (merged[i].kind === "prompt") promptIdx.push(i);

  // Pass 1: totals per hour over the full event timeline.
  let total = 0;
  const byHour = new Map<string, HourStates>();
  const hourOf = (tsMs: number) => hourKey(tsMs, opts.tzOffsetHours);
  const bucket = (key: string): HourStates => {
    let b = byHour.get(key);
    if (!b) {
      b = { total: 0, handsOn: 0, supervised: 0, ai: 0 };
      byHour.set(key, b);
    }
    return b;
  };
  for (let i = 1; i < n; i++) {
    const capped = Math.min((merged[i].ts - merged[i - 1].ts) / 60000, opts.capMinutes);
    total += capped;
    bucket(hourOf(merged[i - 1].ts)).total += capped;
  }

  // Pass 2: human states per prompt-to-prompt segment.
  let handsOn = 0;
  let supervised = 0;
  for (let k = 1; k < promptIdx.length; k++) {
    const p1 = promptIdx[k - 1];
    const p2 = promptIdx[k];
    const windowMin = (merged[p2].ts - merged[p1].ts) / 60000;
    const cappedWindow = Math.min(windowMin, opts.promptCapMinutes);
    const reactionMin = (merged[p2].ts - merged[p2 - 1].ts) / 60000;

    const tail = Math.min(reactionMin, cappedWindow);
    const agentPart = cappedWindow - tail;

    let proof = false;
    for (let j = p2 - 1; j > p1; j--) {
      if (merged[j].presence) {
        proof = true;
        break;
      }
    }
    let w = 0;
    if (proof || reactionMin <= WATCH_FULL) w = 1;
    else if (reactionMin <= WATCH_HALF) w = 0.5;
    const sup = agentPart * w;

    handsOn += tail;
    supervised += sup;

    // Hour attribution: tail to the hour of the tail gap's start; supervised
    // distributed over the segment's work gaps proportionally to capped time.
    bucket(hourOf(merged[p2 - 1].ts)).handsOn += tail;
    if (sup > 0) {
      let denom = 0;
      for (let i = p1 + 1; i < p2; i++) {
        denom += Math.min((merged[i].ts - merged[i - 1].ts) / 60000, opts.capMinutes);
      }
      if (denom > 0) {
        for (let i = p1 + 1; i < p2; i++) {
          const g = Math.min((merged[i].ts - merged[i - 1].ts) / 60000, opts.capMinutes);
          bucket(hourOf(merged[i - 1].ts)).supervised += (sup * g) / denom;
        }
      } else {
        bucket(hourOf(merged[p1].ts)).supervised += sup;
      }
    }
  }
  for (const b of byHour.values()) {
    b.ai = Math.max(0, b.total - b.handsOn - b.supervised);
  }

  const promptTimes = promptIdx.map((i) => merged[i].ts);
  const upperBound = Math.min(activeMinutes(promptTimes, opts.promptCapMinutes), total);
  const attention = handsOn + supervised;

  return {
    totalMinutes: total,
    handsOnMinutes: handsOn,
    supervisedMinutes: supervised,
    attentionMinutes: attention,
    upperBoundMinutes: upperBound,
    aiAutonomousMinutes: total - attention,
    promptCount: promptIdx.length,
    byHour,
  };
}

/**
 * Per-day capped minutes. Each gap is attributed to the day of its EARLIER
 * event (same convention as the Python reference's --by-day and --csv).
 */
export function bucketMinutesByDay(
  timesMs: number[],
  capMinutes: number,
  tzOffsetHours: number
): Map<string, number> {
  const days = new Map<string, number>();
  for (let i = 1; i < timesMs.length; i++) {
    const gap = Math.min((timesMs[i] - timesMs[i - 1]) / 60000, capMinutes);
    const day = dayKey(timesMs[i - 1], tzOffsetHours);
    days.set(day, (days.get(day) ?? 0) + gap);
  }
  return days;
}

export function countByDay(timesMs: number[], tzOffsetHours: number): Map<string, number> {
  const days = new Map<string, number>();
  for (const t of timesMs) {
    const day = dayKey(t, tzOffsetHours);
    days.set(day, (days.get(day) ?? 0) + 1);
  }
  return days;
}

/**
 * Parses YYYY-MM-DD, "YYYY-MM-DD HH:MM[:SS]" or an ISO timestamp — all
 * interpreted as UTC (same contract as the Python reference).
 */
export function parseDate(s: string): number {
  if (s.includes("T")) {
    const ts = Date.parse(s);
    if (Number.isNaN(ts)) throw new Error(`Cannot parse date '${s}'`);
    return ts;
  }
  let iso: string;
  if (s.includes(" ")) {
    const m = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(:\d{2})?$/);
    if (!m) throw new Error(`Cannot parse date '${s}' (expected YYYY-MM-DD or YYYY-MM-DD HH:MM)`);
    iso = `${m[1]}T${m[2]}${m[3] ?? ":00"}Z`;
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      throw new Error(`Cannot parse date '${s}' (expected YYYY-MM-DD)`);
    }
    iso = `${s}T00:00:00Z`;
  }
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) throw new Error(`Cannot parse date '${s}'`);
  return ts;
}
