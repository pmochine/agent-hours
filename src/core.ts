/**
 * agent-hours timing core: merged timelines and the three-state human/AI split.
 * Regression coverage lives in test/core.test.mjs.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { forEachJsonlRecord, isLogFileBefore } from "./jsonl.js";

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
  /** A human enqueue typed while the agent was running. */
  midTurn?: boolean;
}

export interface TimelineLoadOptions {
  /** Skip event bodies in append-only files older than this cutoff. */
  pruneBeforeMs?: number;
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
 *     path separators — so "café-bot" -> "caf--bot".
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
  let cwd: string | null = null;
  forEachJsonlRecord(file, (record) => {
    if (typeof record["cwd"] === "string") {
      cwd = record["cwd"];
      return false;
    }
  }, { maxLines: 200 });
  return cwd;
}

/** Match each transcript's own cwd, allowing cwd-less exact-hash history. */
export function claudeFileMatchesProject(
  file: string,
  projectDir: string,
  projectPath: string,
  includeDescendants = true
): boolean {
  const project = canonicalPath(projectPath);
  const cwd = cwdFromJsonl(file);
  if (cwd === null) return path.basename(projectDir) === projectToHash(project);
  const actual = canonicalPath(cwd);
  return actual === project || (includeDescendants && actual.startsWith(project + path.sep));
}

/** Top-level sessions and their subagents share the parent's project identity. */
export function claudeProjectFiles(
  projectDir: string,
  projectPath?: string,
  includeDescendants = true
): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const matches = (file: string) => !projectPath ||
    claudeFileMatchesProject(file, projectDir, projectPath, includeDescendants);
  const parents = new Map<string, boolean>();
  const files: string[] = [];
  for (const entry of entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const file = path.join(projectDir, entry.name);
    const include = matches(file);
    parents.set(entry.name.slice(0, -6), include);
    if (include) files.push(file);
  }
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const parent = parents.get(entry.name);
    if (parent === false) continue;
    for (const file of subagentJsonlFiles(path.join(projectDir, entry.name, "subagents"))) {
      if (parent === true || matches(file)) files.push(file);
    }
  }
  return files;
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
    .filter((dir) => claudeProjectFiles(dir, project, includeDescendants).length > 0);
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

/** Answers to Claude's question tool carry structured human answer values. */
export function claudeQuestionAnswers(record: Record<string, unknown>): Record<string, unknown> | null {
  const result = record["toolUseResult"];
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const r = result as Record<string, unknown>;
  const answers = r["answers"];
  if (!("questions" in r) || !answers || typeof answers !== "object" || Array.isArray(answers)) return null;
  const message = record["message"] as Record<string, unknown> | undefined;
  const content = message?.["content"];
  return Array.isArray(content) && content.some((item) => item?.type === "tool_result")
    ? answers as Record<string, unknown> : null;
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
    if (claudeQuestionAnswers(r)) return { kind: "prompt", presence: true };
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
 * Reads the complete timeline of one session JSONL, with optional file pruning.
 * With forceWork (subagent transcripts) every event counts as machine work —
 * subagent "user" messages are task prompts from the orchestrator, not humans.
 */
export function loadSessionEvents(
  jsonlPath: string,
  options: TimelineLoadOptions = {},
  forceWork = false
): SessionEvent[] {
  if (isLogFileBefore(jsonlPath, options.pruneBeforeMs)) return [];
  const events: SessionEvent[] = [];
  forEachJsonlRecord(jsonlPath, (record) => {
    const tsStr = record["timestamp"];
    if (typeof tsStr !== "string") return;
    const ts = Date.parse(tsStr);
    if (Number.isNaN(ts)) return;
    // Written after the last record, when the person has left.
    if (record["type"] === "system" && record["subtype"] === "away_summary") return;
    const reactionAnchor = record["type"] === "assistant";
    if (forceWork) {
      events.push({ ts, kind: "work", presence: false, reactionAnchor });
    } else {
      const c = classifyRecord(record);
      const midTurn = c.kind === "prompt" && record["type"] === "queue-operation";
      events.push({ ts, kind: c.kind, presence: c.presence, reactionAnchor, ...(midTurn ? { midTurn: true } : {}) });
    }
  });
  events.sort((a, b) => a.ts - b.ts);
  return events;
}

/**
 * Loads all sessions of a project directory: top-level *.jsonl PLUS subagent
 * transcripts recursively below <sessionUuid>/subagents/ (newer Claude Code
 * versions store parallel-agent work there — missing them undercounts total
 * activity whenever only subagents were running).
 */
export function loadProject(
  projectDir: string,
  options: TimelineLoadOptions = {},
  projectPath?: string,
  includeDescendants = true
): NamedSession[] {
  const sessions: NamedSession[] = [];
  for (const file of claudeProjectFiles(projectDir, projectPath, includeDescendants)) {
    const forceWork = file.includes(`${path.sep}subagents${path.sep}`);
    const events = loadSessionEvents(file, options, forceWork);
    if (events.length > 0) sessions.push({ name: path.relative(projectDir, file), events });
  }
  return sessions;
}

/** Flat and workflow subagent transcripts; journals contain no timeline records. */
export function subagentJsonlFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...subagentJsonlFiles(file));
    else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name !== "journal.jsonl") {
      files.push(file);
    }
  }
  return files.sort();
}

/** Capped segments clipped to a start-inclusive, end-exclusive range. */
export function cappedMinutesInRange(
  timesMs: number[],
  capMinutes: number,
  rangeStartMs = -Infinity,
  rangeEndMs = Infinity,
  strict = false
): number {
  let total = 0;
  for (let i = 1; i < timesMs.length; i++) {
    const gap = timesMs[i] - timesMs[i - 1];
    if (strict && gap > capMinutes * 60000) continue;
    const start = Math.max(timesMs[i - 1], rangeStartMs);
    const end = Math.min(timesMs[i - 1] + Math.min(gap, capMinutes * 60000), rangeEndMs);
    total += Math.max(0, end - start) / 60000;
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
  const label = `${p.year}-${p.month}-${p.day} ${p.hour}:00`;
  const previous = localParts(tsMs - 3600_000, zone);
  const previousLabel = `${previous.year}-${previous.month}-${previous.day} ${previous.hour}:00`;
  return previousLabel === label ? label + " (repeated)" : label;
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
  upper: number;
}

export interface RefinedSplit {
  totalMinutes: number;
  /** Credited reaction tails right before prompts — an interaction estimate. */
  handsOnMinutes: number;
  /** Agent-working time weighted by watch probability. */
  supervisedMinutes: number;
  /** handsOn + supervised — an evidence-based human-attention estimate. */
  attentionMinutes: number;
  /** Full attention budget, allocated and clipped per credited gap. */
  upperBoundMinutes: number;
  /** total − attention. */
  aiAutonomousMinutes: number;
  promptCount: number;
  byHour: Map<string, HourStates>;
}

export interface RefinedOptions {
  capMinutes: number;
  promptCapMinutes: number;
  rangeStartMs?: number;
  rangeEndMs?: number;
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
 * Per prompt-to-prompt window, the attention budget is limited by the credited
 * gap capacity and promptCapMinutes:
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
 * Invariant, per credited gap: handsOn + supervised <= upperBound <= total.
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
  const rangeStart = opts.rangeStartMs ?? -Infinity;
  const rangeEnd = opts.rangeEndMs ?? Infinity;
  const gaps = merged.slice(1).map((event, i) => ({
    start: merged[i].ts,
    credit: Math.min((event.ts - merged[i].ts) / 60000, opts.capMinutes),
    handsOn: 0,
    supervised: 0,
    upper: 0,
  }));

  // Track same-session evidence before each prompt in one forward pass.
  type Evidence = { prompt: number; anchor: number; presence: number };
  const emptyEvidence = (): Evidence => ({ prompt: -1, anchor: -1, presence: -1 });
  const sessions = new Map<string | undefined, Evidence>();
  const global = emptyEvidence();
  let previousPrompt = -1;
  let promptCount = 0;
  for (let i = 0; i < merged.length; i++) {
    const event = merged[i];
    const session = sessions.get(event.session) ?? emptyEvidence();
    sessions.set(event.session, session);
    const evidence = event.session ? session : global;
    if (event.kind === "prompt") {
      if (event.ts >= rangeStart && event.ts < rangeEnd) promptCount++;
      if (previousPrompt >= 0) {
        const anchor = evidence.anchor > evidence.prompt ? evidence.anchor : evidence.prompt;
        const reactionMin = anchor >= 0 ? (event.ts - merged[anchor].ts) / 60000 : Infinity;
        let creditedWindow = 0;
        for (let j = previousPrompt; j < i; j++) creditedWindow += gaps[j].credit;
        const budget = Math.min(creditedWindow, opts.promptCapMinutes);
        const tail = Math.min(Number.isFinite(reactionMin) ? reactionMin : 0, budget);
        const proof = event.midTurn === true || evidence.presence > previousPrompt;
        const weight = proof || reactionMin <= WATCH_FULL ? 1 : reactionMin <= WATCH_HALF ? 0.5 : 0;

        let tailLeft = tail;
        for (let j = i - 1; j >= previousPrompt && tailLeft > 0; j--) {
          const take = Math.min(gaps[j].credit, tailLeft);
          gaps[j].handsOn = take;
          tailLeft -= take;
        }
        // Full supervision gives the upper amount; actual supervision uses
        // the same proportional capacities with the evidence weight.
        let upperLeft = budget - tail;
        let supLeft = upperLeft * weight;
        let remainingCapacity = 0;
        for (let j = previousPrompt; j < i; j++) remainingCapacity += gaps[j].credit - gaps[j].handsOn;
        for (let j = previousPrompt; j < i; j++) {
          const gap = gaps[j];
          const capacity = gap.credit - gap.handsOn;
          const upper = remainingCapacity > 0 ? Math.min(capacity, upperLeft * capacity / remainingCapacity) : 0;
          const supervised = remainingCapacity > 0 ? Math.min(capacity, supLeft * capacity / remainingCapacity) : 0;
          gap.supervised = supervised;
          gap.upper = gap.handsOn + upper;
          upperLeft -= upper;
          supLeft -= supervised;
          remainingCapacity -= capacity;
        }
      }
      previousPrompt = i;
      session.prompt = global.prompt = i;
    }
    if (event.reactionAnchor === true) session.anchor = global.anchor = i;
    if (event.presence) session.presence = global.presence = i;
  }

  // Allocation is independent of the range. Clip uniformly spread gap states,
  // then divide the segments at UTC quarter-hours (including DST folds).
  const byHour = new Map<string, HourStates>();
  const hourCache = new Map<number, string>();
  const SLOT = 15 * 60000;
  let total = 0;
  let handsOn = 0;
  let supervised = 0;
  let upperBound = 0;
  let ai = 0;
  for (const gap of gaps) {
    const end = Math.min(gap.start + gap.credit * 60000, rangeEnd);
    let start = Math.max(gap.start, rangeStart);
    while (start < end) {
      const slot = Math.floor(start / SLOT) * SLOT;
      const partEnd = Math.min(end, slot + SLOT);
      let key = hourCache.get(slot);
      if (!key) {
        key = hourKey(slot, timeZone);
        hourCache.set(slot, key);
      }
      const bucket = byHour.get(key) ?? { total: 0, handsOn: 0, supervised: 0, ai: 0, upper: 0 };
      const minutes = (partEnd - start) / 60000;
      const fraction = minutes / gap.credit;
      const direct = gap.handsOn * fraction;
      const watched = gap.supervised * fraction;
      const upper = gap.upper * fraction;
      const autonomous = Math.max(0, minutes - direct - watched);
      bucket.total += minutes;
      bucket.handsOn += direct;
      bucket.supervised += watched;
      bucket.upper += upper;
      bucket.ai += autonomous;
      byHour.set(key, bucket);
      total += minutes;
      handsOn += direct;
      supervised += watched;
      upperBound += upper;
      ai += autonomous;
      start = partEnd;
    }
  }
  return {
    totalMinutes: total,
    handsOnMinutes: handsOn,
    supervisedMinutes: supervised,
    attentionMinutes: handsOn + supervised,
    upperBoundMinutes: upperBound,
    aiAutonomousMinutes: ai,
    promptCount,
    byHour,
  };
}

export function countByDay(
  timesMs: number[],
  timeZone: TimeZoneSpec,
  rangeStartMs = -Infinity,
  rangeEndMs = Infinity
): Map<string, number> {
  const days = new Map<string, number>();
  for (const t of timesMs) {
    if (t < rangeStartMs || t >= rangeEndMs) continue;
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
