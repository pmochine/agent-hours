/**
 * agent-hours timing core. The legacy binary calculation remains compatible
 * with reference/claude_hours.py + reference/prototype-split.py.
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
  /** Session identity, attached by mergeEvents for same-session reasoning. */
  session?: string;
  /** True for assistant output a later human prompt can genuinely react to. */
  reactionAnchor?: boolean;
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
    const candidate = path.resolve(projectArg);
    hashName =
      path.isAbsolute(projectArg) ||
      projectArg.startsWith(".") ||
      projectArg.includes(path.sep) ||
      fs.existsSync(candidate)
        ? projectToHash(candidate)
        : projectArg;
  } else {
    hashName = projectToHash(process.cwd());
  }
  return path.join(PROJECTS_BASE, hashName);
}

function canonicalPath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved).normalize("NFC");
  } catch {
    return resolved.normalize("NFC");
  }
}

function cwdFromJsonl(file: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n").slice(0, 200)) {
    if (!line.trim()) continue;
    try {
      const cwd = (JSON.parse(line) as Record<string, unknown>)["cwd"];
      if (typeof cwd === "string") return cwd;
    } catch {
      // Keep looking: one malformed record must not hide a usable cwd.
    }
  }
  return null;
}

/** Best-effort readable cwd for a Claude project directory. */
export function readClaudeProjectCwd(projectDir: string): string | null {
  let files: string[];
  try {
    files = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return null;
  }
  for (const file of files) {
    const cwd = cwdFromJsonl(path.join(projectDir, file));
    if (cwd) return canonicalPath(cwd);
  }
  return null;
}

/**
 * Find the exact Claude project plus transcripts started in its descendants.
 * Hash-prefix candidates are confirmed using the cwd stored in the JSONL so
 * `/tmp/proj-sibling` cannot be mistaken for `/tmp/proj`.
 */
export function findClaudeProjectDirs(
  projectPath: string,
  projectsBase: string = PROJECTS_BASE,
  includeDescendants = true
): string[] {
  const project = canonicalPath(projectPath);
  const exactHash = projectToHash(project);
  let names: string[];
  try {
    names = fs
      .readdirSync(projectsBase, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => name === exactHash || (includeDescendants && name.startsWith(exactHash + "-")))
      .sort();
  } catch {
    return [];
  }
  return names
    .map((name) => path.join(projectsBase, name))
    .filter((dir) => {
      const cwd = readClaudeProjectCwd(dir);
      if (cwd === null) return path.basename(dir) === exactHash;
      return cwd === project || (includeDescendants && cwd.startsWith(project + path.sep));
    });
}

export interface Classified {
  kind: EventKind;
  presence: boolean;
}

/**
 * Claude sometimes stores internal XML-like envelopes as ordinary user-role
 * records. Without promptSource metadata these must not become human prompts.
 * A shell escape and an explicit interrupt are genuine user actions.
 */
export function isMachineGeneratedText(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("<bash-input>")) return false;
  if (trimmed.startsWith("[Request interrupted")) return false;
  return trimmed.startsWith("<");
}

/** Explicit Claude sources known to represent a person's input. */
export function isHumanPromptSource(source: unknown): boolean {
  return source === "typed" || source === "suggestion_accepted";
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
      !isMachineGeneratedText(content)
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
    if (isHumanPromptSource(src)) return { kind: "prompt", presence: true };
    // Any explicit non-typed source (system, queued, sdk, hooks, or a future
    // source) is machine-delivered. The shape fallback is legacy-only.
    if (src !== undefined) return work;
    const msg = r["message"] as Record<string, unknown> | undefined;
    const c = msg?.["content"];
    if (typeof c === "string" && !isMachineGeneratedText(c)) {
      return { kind: "prompt", presence: true };
    }
    if (Array.isArray(c)) {
      const items = c.filter(
        (i): i is Record<string, unknown> => i !== null && typeof i === "object"
      );
      const hasHumanText = items.some(
        (i) =>
          i["type"] === "text" &&
          typeof i["text"] === "string" &&
          !isMachineGeneratedText(i["text"] as string)
      );
      const hasToolResult = items.some((i) => i["type"] === "tool_result");
      if (hasHumanText && !hasToolResult) return { kind: "prompt", presence: true };
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
    const rawRecord = record as Record<string, unknown>;
    const reactionAnchor = rawRecord["type"] === "assistant";
    if (forceWork) {
      events.push({ ts, kind: "work", presence: false, reactionAnchor });
    } else {
      const c = classifyRecord(record);
      events.push({ ts, kind: c.kind, presence: c.presence, reactionAnchor });
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
 * Common activity-log estimate: sum inter-event gaps, with each gap capped at
 * capMinutes ("cap bonus" — a longer pause still contributes capMinutes).
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
  for (const s of sessions) {
    for (const event of s.events) merged.push({ ...event, session: event.session ?? s.name });
  }
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

export type TimeZoneSpec = number | string;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zonedParts(tsMs: number, timeZone: string): Record<string, string> {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, formatter);
  }
  return Object.fromEntries(
    formatter.formatToParts(new Date(tsMs)).filter((p) => p.type !== "literal").map((p) => [p.type, p.value])
  );
}

function localParts(tsMs: number, zone: TimeZoneSpec): Record<string, string> {
  if (typeof zone === "number") {
    const iso = new Date(tsMs + zone * 3600_000).toISOString();
    return {
      year: iso.slice(0, 4),
      month: iso.slice(5, 7),
      day: iso.slice(8, 10),
      hour: iso.slice(11, 13),
      minute: iso.slice(14, 16),
      second: iso.slice(17, 19),
    };
  }
  return zonedParts(tsMs, zone);
}

/** Local-date key (YYYY-MM-DD), supporting fixed offsets and IANA zones. */
export function dayKey(tsMs: number, zone: TimeZoneSpec): string {
  const p = localParts(tsMs, zone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Local-hour key (YYYY-MM-DD HH:00), supporting daylight-saving changes. */
export function hourKey(tsMs: number, zone: TimeZoneSpec): string {
  const p = localParts(tsMs, zone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:00`;
}

export function dateTimeKey(tsMs: number, zone: TimeZoneSpec): string {
  const p = localParts(tsMs, zone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export interface HourStates {
  total: number;
  handsOn: number;
  supervised: number;
  ai: number;
}

export interface RefinedSplit {
  totalMinutes: number;
  /** Credited reaction tails right before prompts — an interaction estimate. */
  handsOnMinutes: number;
  /** Agent-working time weighted by watch probability. */
  supervisedMinutes: number;
  /** handsOn + supervised — an evidence-based human-attention estimate. */
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
  /** Preferred DST-aware zone. tzOffsetHours remains for API compatibility. */
  timeZone?: TimeZoneSpec;
  tzOffsetHours?: number;
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
 * 1. direct interaction — the credited reaction tail between the latest
 *    assistant output in the same session and the next prompt. If a person
 *    submits two prompts without assistant output between them, the previous
 *    prompt is the fallback anchor. This remains an estimate, not proof of
 *    continuous work throughout the whole tail.
 * 2. supervised — the agent-working part of the capped window, weighted by
 *    watch evidence: reaction < 30 s ⇒ they were watching ⇒ 100 %, < 5 min ⇒
 *    50 %, else 0 %. Hard presence proof in the same session (message typed
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
  const timeZone = opts.timeZone ?? opts.tzOffsetHours ?? 0;
  const n = merged.length;

  const promptIdx: number[] = [];
  for (let i = 0; i < n; i++) if (merged[i].kind === "prompt") promptIdx.push(i);

  // Pass 1: totals per hour over the full event timeline.
  let total = 0;
  const byHour = new Map<string, HourStates>();
  const hourOf = (tsMs: number) => hourKey(tsMs, timeZone);
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

    // A prompt is a reaction to output in its own session. Busy subagents or
    // another terminal must not manufacture a near-zero reaction time.
    const promptSession = merged[p2].session;
    let previousSessionPrompt = -1;
    for (let j = p2 - 1; j >= 0; j--) {
      if (merged[j].kind === "prompt" && (!promptSession || merged[j].session === promptSession)) {
        previousSessionPrompt = j;
        break;
      }
    }
    let reactionAnchor = -1;
    for (let j = p2 - 1; j > previousSessionPrompt; j--) {
      if (
        merged[j].reactionAnchor === true &&
        (!promptSession || merged[j].session === promptSession)
      ) {
        reactionAnchor = j;
        break;
      }
    }
    if (reactionAnchor < 0) reactionAnchor = previousSessionPrompt;
    const reactionMin =
      reactionAnchor >= 0 ? (merged[p2].ts - merged[reactionAnchor].ts) / 60000 : Infinity;

    // Attention may only be allocated from time that Pass 1 actually credited.
    // This keeps all states non-negative even when promptCapMinutes > capMinutes.
    const gaps: Array<{ key: string; credit: number; remaining: number }> = [];
    let creditedWindow = 0;
    for (let i = p1 + 1; i <= p2; i++) {
      const credit = Math.min((merged[i].ts - merged[i - 1].ts) / 60000, opts.capMinutes);
      creditedWindow += credit;
      gaps.push({ key: hourOf(merged[i - 1].ts), credit, remaining: credit });
    }
    const attentionBudget = Math.min(creditedWindow, opts.promptCapMinutes);
    const creditedReaction = Number.isFinite(reactionMin) ? reactionMin : 0;
    const tail = Math.min(creditedReaction, attentionBudget);
    const agentPart = attentionBudget - tail;

    let proof = false;
    for (let j = p2 - 1; j > p1; j--) {
      if (
        merged[j].presence &&
        (!promptSession || merged[j].session === promptSession)
      ) {
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

    // Allocate attention out of the exact gap credits that make up total.
    // This guarantees every hourly bucket and the global result obey the same
    // non-negative state invariant.
    let tailLeft = tail;
    for (let i = gaps.length - 1; i >= 0 && tailLeft > 0; i--) {
      const take = Math.min(gaps[i].remaining, tailLeft);
      gaps[i].remaining -= take;
      tailLeft -= take;
      bucket(gaps[i].key).handsOn += take;
    }
    let supLeft = sup;
    let remainingCapacity = gaps.reduce((sum, gap) => sum + gap.remaining, 0);
    for (const gap of gaps) {
      if (supLeft <= 0 || remainingCapacity <= 0) break;
      const capacity = gap.remaining;
      const share = (supLeft * capacity) / remainingCapacity;
      const take = Math.min(capacity, share);
      gap.remaining -= take;
      supLeft -= take;
      remainingCapacity -= capacity;
      bucket(gap.key).supervised += take;
    }
  }
  for (const b of byHour.values()) {
    b.ai = Math.max(0, b.total - b.handsOn - b.supervised);
  }

  const promptTimes = promptIdx.map((i) => merged[i].ts);
  const upperBound = Math.min(activeMinutes(promptTimes, opts.promptCapMinutes), total);
  const attention = Math.min(handsOn + supervised, total);

  return {
    totalMinutes: total,
    handsOnMinutes: handsOn,
    supervisedMinutes: supervised,
    attentionMinutes: attention,
    upperBoundMinutes: upperBound,
    aiAutonomousMinutes: Math.max(0, total - attention),
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
  timeZone: TimeZoneSpec
): Map<string, number> {
  const days = new Map<string, number>();
  for (let i = 1; i < timesMs.length; i++) {
    const gap = Math.min((timesMs[i] - timesMs[i - 1]) / 60000, capMinutes);
    const day = dayKey(timesMs[i - 1], timeZone);
    days.set(day, (days.get(day) ?? 0) + gap);
  }
  return days;
}

export function countByDay(timesMs: number[], timeZone: TimeZoneSpec): Map<string, number> {
  const days = new Map<string, number>();
  for (const t of timesMs) {
    const day = dayKey(t, timeZone);
    days.set(day, (days.get(day) ?? 0) + 1);
  }
  return days;
}

/**
 * Parses YYYY-MM-DD, "YYYY-MM-DD HH:MM[:SS]" or an ISO timestamp. Values
 * without an explicit offset are interpreted in the requested local zone.
 */
export function parseDate(s: string, zone: TimeZoneSpec = 0): number {
  if (/T.*(?:Z|[+-]\d\d:\d\d)$/.test(s)) {
    const calendar = s.match(/^(\d{4})-(\d{2})-(\d{2})T/);
    if (calendar) {
      const check = new Date(Date.UTC(+calendar[1], +calendar[2] - 1, +calendar[3]));
      if (
        check.getUTCFullYear() !== +calendar[1] ||
        check.getUTCMonth() !== +calendar[2] - 1 ||
        check.getUTCDate() !== +calendar[3]
      ) {
        throw new Error(`Cannot parse date '${s}' (invalid calendar date)`);
      }
    }
    const ts = Date.parse(s);
    if (Number.isNaN(ts)) throw new Error(`Cannot parse date '${s}'`);
    return ts;
  }
  const normalized = s.replace("T", " ");
  const m = normalized.match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) throw new Error(`Cannot parse date '${s}' (expected YYYY-MM-DD [HH:MM[:SS]])`);
  const localUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  const check = new Date(localUtc);
  if (
    check.getUTCFullYear() !== +m[1] ||
    check.getUTCMonth() !== +m[2] - 1 ||
    check.getUTCDate() !== +m[3] ||
    check.getUTCHours() !== +(m[4] ?? 0) ||
    check.getUTCMinutes() !== +(m[5] ?? 0) ||
    check.getUTCSeconds() !== +(m[6] ?? 0)
  ) {
    throw new Error(`Cannot parse date '${s}' (invalid calendar date)`);
  }
  if (typeof zone === "number") return localUtc - zone * 3600_000;

  // Two passes account for the fact that the first UTC guess can fall on the
  // other side of a daylight-saving transition.
  let instant = localUtc;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(instant, zone);
    const represented = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    instant = localUtc - (represented - instant);
  }
  const final = zonedParts(instant, zone);
  if (
    +final.year !== +m[1] ||
    +final.month !== +m[2] ||
    +final.day !== +m[3] ||
    +final.hour !== +(m[4] ?? 0) ||
    +final.minute !== +(m[5] ?? 0) ||
    +final.second !== +(m[6] ?? 0)
  ) {
    throw new Error(`Cannot parse date '${s}' (local time does not exist in ${zone})`);
  }
  return instant;
}
