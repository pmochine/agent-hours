import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cappedMinutesInRange,
  countByDay,
  classifyKind,
  classifyRecord,
  computeRefinedSplit,
  dayKey,
  detectOverlaps,
  findClaudeProjectDirs,
  findPauses,
  hourKey,
  loadProject,
  loadSessionEvents,
  mergeEvents,
  parseDate,
  projectToHash,
  readClaudeProjectCwd,
  subagentJsonlFiles,
} from "../dist/core.js";
import { collectCodexWorklog, collectWorklog, describeLog, mergeLogs } from "../dist/worklog.js";
import {
  canonicalProjectPath,
  findCodexSessionFiles,
  isSyntheticCodexUserText,
  loadCodexSessions,
  scanCodexSessions,
} from "../dist/sources/codex.js";
import { runInstall, SKILL_MD, checkRetention, setRetention } from "../dist/install.js";
import { forEachJsonlRecord, unreadableFileCount } from "../dist/jsonl.js";
import fs from "node:fs";
import os from "node:os";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const LEGACY = path.join(FIXTURES, "legacy");
const MODERN = path.join(FIXTURES, "modern");
const CODEX_CURRENT = path.join(FIXTURES, "codex-current");
const COUNTING = path.join(FIXTURES, "counting");
const COUNTING_CODEX = [path.join(COUNTING, "codex", "sessions"), path.join(COUNTING, "codex", "archived_sessions")];
const SINCE = 0;
const UNTIL = Date.parse("2100-01-01T00:00:00Z");

function minutes(...mins) {
  const base = Date.parse("2026-06-01T10:00:00Z");
  return mins.map((m) => base + m * 60000);
}

test("cappedMinutesInRange caps each gap (cap bonus)", () => {
  assert.equal(cappedMinutesInRange(minutes(0, 5, 30), 10), 15);
  assert.equal(cappedMinutesInRange(minutes(0), 10), 0);
  assert.equal(cappedMinutesInRange([], 10), 0);
});

test("cappedMinutesInRange strict drops gaps above the cap entirely", () => {
  assert.equal(cappedMinutesInRange(minutes(0, 5, 30), 10, -Infinity, Infinity, true), 5);
});

test("findPauses returns gaps >= min, longest first", () => {
  const pauses = findPauses(minutes(0, 5, 30, 80), 10);
  assert.deepEqual(pauses.map((p) => p.minutes), [50, 25]);
});

test("classify: legacy shape heuristic (no promptSource)", () => {
  assert.equal(classifyKind({ type: "user", message: { content: "hi" } }), "prompt");
  assert.equal(
    classifyKind({ type: "user", message: { content: [{ type: "text", text: "hi" }] } }),
    "prompt"
  );
  assert.equal(
    classifyKind({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] } }),
    "work"
  );
  assert.equal(classifyKind({ type: "user", isMeta: true, message: { content: "x" } }), "work");
  assert.equal(classifyKind({ type: "assistant", message: { content: "x" } }), "work");
});

test("classify: promptSource overrides the shape heuristic", () => {
  assert.equal(classifyKind({ type: "user", promptSource: "typed", message: { content: "x" } }), "prompt");
  assert.equal(
    classifyKind({ type: "user", promptSource: "suggestion_accepted", message: { content: "x" } }),
    "prompt"
  );
  // phantom prompts: scheduled tasks / hooks delivered as user messages
  assert.equal(classifyKind({ type: "user", promptSource: "system", message: { content: "x" } }), "work");
  // queued injection: typing already credited at the enqueue event
  assert.equal(classifyKind({ type: "user", promptSource: "queued", message: { content: "x" } }), "work");
  assert.equal(classifyKind({ type: "user", promptSource: "sdk", message: { content: "x" } }), "work");
});

test("classify: legacy machine envelopes do not become human prompts", () => {
  for (const text of [
    "<task-notification>done</task-notification>",
    "<local-command-stdout>ok</local-command-stdout>",
    "<command-name>/review</command-name>",
    "<system-reminder>automated</system-reminder>",
  ]) {
    assert.equal(classifyKind({ type: "user", message: { content: text } }), "work");
  }
  assert.equal(
    classifyKind({ type: "user", message: { content: "<bash-input>git status</bash-input>" } }),
    "prompt"
  );
  assert.equal(
    classifyKind({ type: "user", message: { content: "[Request interrupted by user]" } }),
    "prompt"
  );
  assert.equal(
    classifyKind({
      type: "queue-operation",
      operation: "enqueue",
      content: "<cross-session-message>worker done</cross-session-message>",
    }),
    "work"
  );
});

test("classify: queue-operation enqueue = human typing mid-turn", () => {
  const human = classifyRecord({ type: "queue-operation", operation: "enqueue", content: "do this next" });
  assert.deepEqual(human, { kind: "prompt", presence: true });
  const system = classifyRecord({
    type: "queue-operation",
    operation: "enqueue",
    content: "<task-notification>\n...</task-notification>",
  });
  assert.equal(system.kind, "work");
  assert.equal(classifyRecord({ type: "queue-operation", operation: "dequeue", content: "x" }).kind, "work");
});

test("classify: compact summaries, sidechains, edited-file attachments", () => {
  assert.equal(
    classifyKind({ type: "user", isCompactSummary: true, message: { content: "This session is being continued" } }),
    "work"
  );
  assert.equal(
    classifyKind({ type: "user", isSidechain: true, message: { content: "subagent task" } }),
    "work"
  );
  const att = classifyRecord({ type: "attachment", attachment: { type: "edited_text_file", filename: "/x" } });
  assert.deepEqual(att, { kind: "work", presence: true });
});

test("legacy fixtures: merged timeline avoids double counting parallel sessions", () => {
  const sessions = loadProject(LEGACY);
  assert.equal(sessions.length, 2);
  assert.equal(detectOverlaps(sessions), true);

  const merged = mergeEvents(sessions);
  assert.equal(cappedMinutesInRange(merged.map((e) => e.ts), 10), 16);

  const sum = sessions.reduce(
    (acc, s) => acc + cappedMinutesInRange(s.events.map((e) => e.ts), 10),
    0
  );
  assert.equal(sum, 18);
});

test("legacy fixtures: refined split preserves frozen totals and upper bound", () => {
  const merged = mergeEvents(loadProject(LEGACY));
  const split = computeRefinedSplit(merged, { capMinutes: 10, promptCapMinutes: 10 });
  assert.equal(split.totalMinutes, 16);
  assert.equal(split.promptCount, 2);
  assert.equal(split.upperBoundMinutes, 10);
});

test("legacy fixtures: refined three-state split", () => {
  const merged = mergeEvents(loadProject(LEGACY));
  const r = computeRefinedSplit(merged, { capMinutes: 10, promptCapMinutes: 10, tzOffsetHours: 0 });
  // 25-min reaction before the second prompt => nobody watched => no supervision
  assert.equal(r.totalMinutes, 16);
  assert.equal(r.handsOnMinutes, 10);
  assert.equal(r.supervisedMinutes, 0);
  assert.equal(r.aiAutonomousMinutes, 6);
  assert.equal(r.upperBoundMinutes, 10);
  // states always sum to total
  assert.equal(r.handsOnMinutes + r.supervisedMinutes + r.aiAutonomousMinutes, r.totalMinutes);
});

test("modern fixtures: subagent transcripts load as machine work", () => {
  const sessions = loadProject(MODERN);
  assert.equal(sessions.length, 2); // session-c + sess-1/subagents/agent-001
  const sub = sessions.find((s) => s.name.includes("subagents"));
  assert.ok(sub);
  assert.ok(sub.events.every((e) => e.kind === "work"));

  const merged = mergeEvents(sessions);
  const prompts = merged.filter((e) => e.kind === "prompt");
  // typed 12:00, human enqueue 12:03, typed 12:10 — NOT: queued injection,
  // system prompt, compact summary, system enqueue, subagent user message
  assert.equal(prompts.length, 3);
});

test("modern fixtures: refined split rewards watch evidence", () => {
  const merged = mergeEvents(loadProject(MODERN));
  const r = computeRefinedSplit(merged, { capMinutes: 10, promptCapMinutes: 10, tzOffsetHours: 0 });
  assert.equal(r.totalMinutes, 10);
  assert.equal(r.handsOnMinutes, 4);
  // Same-session reaction avoids treating the parallel subagent as proof of a
  // 30-second response; queued typing and the external edit prove presence.
  assert.equal(r.supervisedMinutes, 6);
  assert.equal(r.aiAutonomousMinutes, 0);
});

test("refined split ignores background-session noise for reaction evidence", () => {
  const base = Date.parse("2026-06-01T10:00:00Z");
  const main = {
    name: "main",
    events: [
      { ts: base, kind: "prompt", presence: true },
      { ts: base + 60_000, kind: "work", presence: false, reactionAnchor: true },
      { ts: base + 9 * 60_000, kind: "prompt", presence: true },
    ],
  };
  const background = {
    name: "background",
    events: Array.from({ length: 47 }, (_, i) => ({
      ts: base + (70 + i * 10) * 1000,
      kind: "work",
      // Foreign-session presence must not prove the main session was watched.
      presence: i === 20,
      reactionAnchor: true,
    })),
  };
  const r = computeRefinedSplit(mergeEvents([main, background]), {
    capMinutes: 10,
    promptCapMinutes: 10,
    timeZone: "UTC",
  });
  assert.equal(r.supervisedMinutes, 0);
  assert.equal(r.handsOnMinutes, 8);
});

test("refined split preserves non-negative global and hourly invariants for unequal caps", () => {
  const events = [
    { ts: minutes(0)[0], kind: "prompt", presence: true },
    { ts: minutes(1)[0], kind: "work", presence: false, reactionAnchor: true },
    { ts: minutes(31)[0], kind: "prompt", presence: true },
  ];
  for (const [capMinutes, promptCapMinutes] of [[5, 10], [10, 5], [10, 60], [10, 10]]) {
    const r = computeRefinedSplit(events, { capMinutes, promptCapMinutes, timeZone: "UTC" });
    assert.ok(r.handsOnMinutes >= 0 && r.supervisedMinutes >= 0 && r.aiAutonomousMinutes >= 0);
    assert.ok(Math.abs(r.handsOnMinutes + r.supervisedMinutes + r.aiAutonomousMinutes - r.totalMinutes) < 1e-9);
    const sums = [...r.byHour.values()].reduce(
      (a, h) => ({
        total: a.total + h.total,
        handsOn: a.handsOn + h.handsOn,
        supervised: a.supervised + h.supervised,
        ai: a.ai + h.ai,
      }),
      { total: 0, handsOn: 0, supervised: 0, ai: 0 }
    );
    assert.ok(Math.abs(sums.total - r.totalMinutes) < 1e-9);
    assert.ok(Math.abs(sums.handsOn - r.handsOnMinutes) < 1e-9);
    assert.ok(Math.abs(sums.supervised - r.supervisedMinutes) < 1e-9);
    assert.ok(Math.abs(sums.ai - r.aiAutonomousMinutes) < 1e-9);
  }
});

test("refined split falls back to the previous same-session prompt when no answer exists", () => {
  const events = [
    { ts: minutes(0)[0], kind: "prompt", presence: true, session: "main" },
    { ts: minutes(3)[0], kind: "prompt", presence: true, session: "main" },
  ];
  const r = computeRefinedSplit(events, {
    capMinutes: 10,
    promptCapMinutes: 10,
    timeZone: "UTC",
  });
  assert.equal(r.handsOnMinutes, 3);
  assert.equal(r.supervisedMinutes, 0);
  assert.equal(r.aiAutonomousMinutes, 0);
});

test("modern fixtures: worklog extraction", () => {
  const log = collectWorklog(MODERN, SINCE, UNTIL, 0);
  const hour = log.get("2026-06-02 12:00");
  assert.ok(hour);
  assert.equal(hour.prompts.length, 3); // typed, human enqueue, typed — no dupes
  assert.deepEqual([...hour.filesEdited].sort(), ["/tmp/a11y-fix.liquid", "/tmp/popup.liquid"]);
  assert.deepEqual(hour.commits, ["Add newsletter popup"]);
  assert.equal(hour.awaySummaries.length, 1);
});

test("modern fixtures: rule-based description prefers commits + away summary", () => {
  const log = collectWorklog(MODERN, SINCE, UNTIL, 0);
  const all = mergeLogs([...log.values()]);
  const desc = describeLog(all);
  assert.match(desc, /Commits: Add newsletter popup/);
  assert.match(desc, /Popup completed/); // away_summary prose reused for free
  assert.match(desc, /2 files:/);
  // truncation respects maxLen
  assert.ok(describeLog(all, 40).length <= 40);
});

test("codex adapter: cwd matching, exec vs interactive, tag filtering", () => {
  const CODEX = path.join(FIXTURES, "codex-sessions");
  const sessions = loadCodexSessions("/tmp/proj", {}, CODEX);
  // other-project session excluded by cwd
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every((s) => s.name.startsWith("codex:")));

  const interactive = sessions.find((s) => s.name.includes("interactive"));
  const exec = sessions.find((s) => s.name.includes("exec"));
  // interactive: real prompt counts, <environment_context> filtered
  assert.equal(interactive.events.filter((e) => e.kind === "prompt").length, 1);
  // exec sessions are machine-driven end to end
  assert.ok(exec.events.every((e) => e.kind === "work"));
});

test("current Codex logs: subagents, multipart prompts, archives, and deduplication", () => {
  const bases = [
    path.join(CODEX_CURRENT, "sessions"),
    path.join(CODEX_CURRENT, "archived_sessions"),
  ];
  const scanned = scanCodexSessions({}, bases);
  assert.deepEqual(scanned.map((s) => s.sessionId).sort(), ["archived-only", "current-main", "current-sub"]);

  const sessions = loadCodexSessions("/tmp/proj-current", {}, bases);
  assert.equal(sessions.length, 3);
  assert.equal(sessions.flatMap((s) => s.events).filter((e) => e.kind === "prompt").length, 2);
  const sub = scanned.find((s) => s.sessionId === "current-sub");
  assert.ok(sub);
  assert.equal(sub.subagent, true);
  assert.ok(sub.session.events.every((e) => e.kind === "work"));
  assert.ok(sub.session.events.every((e) => e.ts >= sub.startedAt));
});

test("Codex source classification keeps legacy humans and rejects MCP automation", () => {
  const dir = path.join(FIXTURES, "codex-source-kinds");
  const scanned = scanCodexSessions({}, dir);
  const legacy = scanned.find((s) => s.sessionId === "missing-source");
  const mcp = scanned.find((s) => s.sessionId === "mcp-source");
  assert.ok(legacy?.interactive);
  assert.equal(legacy.session.events.filter((e) => e.kind === "prompt").length, 1);
  assert.equal(mcp?.interactive, false);
  assert.ok(mcp.session.events.every((e) => e.kind === "work"));
});

test("Codex worklog extracts evidence from current and archived schemas", () => {
  const bases = [
    path.join(CODEX_CURRENT, "sessions"),
    path.join(CODEX_CURRENT, "archived_sessions"),
  ];
  const log = collectCodexWorklog("/tmp/proj-current", SINCE, UNTIL, "UTC", bases);
  const all = mergeLogs([...log.values()]);
  assert.deepEqual(all.prompts.sort(), ["fix the current bug", "review archived work"]);
  assert.deepEqual([...all.filesEdited].sort(), [
    "/tmp/proj-current/src/app.ts",
    "/tmp/proj-current/src/extra.ts",
    "/tmp/proj-current/src/helper.ts",
  ]);
  assert.equal(all.commands.filter((command) => command === "npm test").length, 1);
  assert.deepEqual(all.commits, ["Archive fix"]);
  assert.match(all.awaySummaries[0], /Fixed the current bug/);
});

test("Codex project matching normalizes NFC and NFD paths", () => {
  const composed = "/tmp/m" + String.fromCharCode(0x00fc) + "ller";
  assert.equal(canonicalProjectPath(composed), canonicalProjectPath(composed.normalize("NFD")));
});

test("Codex continuations merge into one thread and archived segments count once", () => {
  const files = findCodexSessionFiles("/tmp/proj-x", COUNTING_CODEX);
  assert.equal(files.length, 2);
  assert.ok(files.every((meta) => meta.file.includes(`${path.sep}sessions${path.sep}`)));
  assert.deepEqual(files.map((meta) => meta.historyBaseEndOrdinal).sort(), [4, null]);
  const sessions = loadCodexSessions("/tmp/proj-x", {}, COUNTING_CODEX);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].name, "codex:rollout-z-base.jsonl");
  const events = mergeEvents(sessions);
  assert.equal(events.length, 7);
  assert.deepEqual(events.map((e) => e.ts), [...events.map((e) => e.ts)].sort((a, b) => a - b));
  const split = computeRefinedSplit(events, { capMinutes: 10, promptCapMinutes: 10, timeZone: "UTC" });
  assert.equal(split.promptCount, 2);
  assert.equal(split.totalMinutes, 9);
  // Both the answer anchor and writing-edit presence precede the segment boundary.
  assert.equal(split.handsOnMinutes, 4.25);
  assert.equal(split.supervisedMinutes, 4);
  assert.equal(split.attentionMinutes, 8.25);
  const log = mergeLogs([...collectCodexWorklog("/tmp/proj-x", SINCE, UNTIL, "UTC", COUNTING_CODEX).values()]);
  assert.deepEqual(log.prompts, ["Improve the layout.", "Add layout tests."]);
  const late = loadCodexSessions("/tmp/proj-x", { pruneBeforeMs: Date.parse("2026-06-03T10:07:00Z") }, COUNTING_CODEX);
  assert.equal(late.length, 1);
  assert.equal(late[0].name, sessions[0].name);
  // Pruning is per file: both complete segments remain available as context.
  assert.equal(late[0].events.filter((e) => e.kind === "prompt").length, 2);
  assert.equal(computeRefinedSplit(mergeEvents(late), {
    capMinutes: 10, promptCapMinutes: 10, rangeStartMs: Date.parse("2026-06-03T10:07:00Z"),
  }).promptCount, 1);
});

test("Codex continuation classification inherits the base segment metadata", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-continuation-"));
  try {
    for (const name of ["rollout-z-base.jsonl", "rollout-a-continuation.jsonl"]) {
      const lines = fs.readFileSync(path.join(COUNTING_CODEX[0], name), "utf8").trim().split("\n");
      if (name.includes("continuation")) {
        const meta = JSON.parse(lines[0]);
        meta.payload.source = "exec";
        meta.payload.parent_thread_id = "parent-x";
        lines[0] = JSON.stringify(meta);
      }
      fs.writeFileSync(path.join(dir, name), lines.join("\n") + "\n");
    }
    const files = findCodexSessionFiles("/tmp/proj-x", dir);
    assert.ok(files.every((meta) => meta.interactive && !meta.subagent));
    const sessions = loadCodexSessions("/tmp/proj-x", {}, dir);
    assert.equal(sessions[0].events.filter((e) => e.kind === "prompt").length, 2);
    const log = mergeLogs([...collectCodexWorklog("/tmp/proj-x", SINCE, UNTIL, "UTC", dir).values()]);
    assert.equal(log.prompts.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude away summaries add no time after departure and remain worklog evidence", () => {
  const dir = path.join(COUNTING, "claude-passive");
  const events = loadSessionEvents(path.join(dir, "session.jsonl"));
  assert.deepEqual(events.map((e) => e.ts), ["00:00", "02:00", "25:00", "25:00"].map((t) => Date.parse(`2026-06-03T10:${t}Z`)));
  assert.equal(cappedMinutesInRange(events.map((e) => e.ts), 10), 12);
  assert.equal(readClaudeProjectCwd(dir), "/tmp/proj-passive");
  const log = mergeLogs([...collectWorklog(dir, SINCE, UNTIL, "UTC").values()]);
  assert.deepEqual(log.prompts, ["Check the layout."]);
  assert.deepEqual(log.awaySummaries, ["Layout checked and ready for review."]);
});

test("Codex thread settings add no time during a pause; other event types remain", () => {
  const sessions = loadCodexSessions("/tmp/proj-passive", {}, COUNTING_CODEX);
  const events = mergeEvents(sessions);
  assert.equal(events.length, 5); // session_meta, prompt, two answers, other_bookkeeping
  assert.ok(events.every((e) => e.ts !== Date.parse("2026-06-03T10:05:00Z")));
  assert.equal(cappedMinutesInRange(events.map((e) => e.ts), 10), 12);
  const log = mergeLogs([...collectCodexWorklog("/tmp/proj-passive", SINCE, UNTIL, "UTC", COUNTING_CODEX).values()]);
  assert.deepEqual(log.prompts, ["Check the layout."]);
});

test("nested Claude workflow agents count as machine work and supply edited files", () => {
  const dir = path.join(COUNTING, "claude-workflow");
  const subDir = path.join(dir, "session", "subagents");
  assert.deepEqual(subagentJsonlFiles(subDir).map((file) => path.relative(subDir, file)), ["workflows/wf_x/agent-x.jsonl"]);
  const sessions = loadProject(dir);
  assert.equal(sessions.length, 2);
  const sub = sessions.find((session) => session.name.includes("workflows/wf_x"));
  assert.ok(sub);
  assert.equal(sub.events.length, 2);
  assert.ok(sub.events.every((event) => event.kind === "work" && !event.presence));
  const split = computeRefinedSplit(mergeEvents(sessions), { capMinutes: 10, promptCapMinutes: 10 });
  assert.equal(split.totalMinutes, 8);
  assert.equal(split.promptCount, 1);
  const log = mergeLogs([...collectWorklog(dir, SINCE, UNTIL, "UTC").values()]);
  assert.deepEqual([...log.filesEdited], ["/tmp/proj-x/src/helper.ts"]);
  assert.deepEqual(log.prompts, ["Add a helper."]);
});

test("Codex speech, question replies, writing edits, and delegation agree with the worklog", () => {
  const sessions = loadCodexSessions("/tmp/proj-voice", {}, COUNTING_CODEX);
  const events = sessions[0].events;
  const at = (time) => events.find((event) => event.ts === Date.parse(`2026-06-03T10:${time}Z`));
  assert.equal(at("01:00").kind, "prompt");
  assert.equal(at("01:00").presence, true);
  assert.equal(at("03:00").kind, "work");
  assert.equal(at("03:00").presence, false);
  assert.equal(at("03:00").reactionAnchor, true);
  assert.equal(at("03:06").kind, "work");
  assert.equal(at("03:06").presence, false);
  assert.equal(at("04:00").kind, "work");
  assert.equal(at("04:00").presence, true);
  assert.equal(at("08:00").kind, "prompt");
  assert.equal(at("08:00").presence, true);
  assert.equal(isSyntheticCodexUserText("<send_user_message_question_reply>Use blue.</send_user_message_question_reply>"), false);
  assert.equal(isSyntheticCodexUserText("<realtime_delegation>Derived input.</realtime_delegation>"), true);
  const split = computeRefinedSplit(mergeEvents(sessions), { capMinutes: 10, promptCapMinutes: 10 });
  assert.equal(split.promptCount, 2);
  assert.equal(split.handsOnMinutes, 5);
  assert.equal(split.supervisedMinutes, 2);
  const log = mergeLogs([...collectCodexWorklog("/tmp/proj-voice", SINCE, UNTIL, "UTC", COUNTING_CODEX).values()]);
  assert.deepEqual(log.prompts, ["Please improve the layout.", "<send_user_message_question_reply>Use blue.</send_user_message_question_reply>"]);
});

test("Codex plugin, exec, and subagent sessions keep all human-shaped input machine work", () => {
  for (const name of ["plugin", "exec-voice", "subagent-voice"]) {
    const scanned = scanCodexSessions({}, COUNTING_CODEX, `/tmp/proj-${name}`);
    assert.equal(scanned.length, 1);
    assert.equal(scanned[0].interactive, false);
    assert.ok(scanned[0].session.events.every((event) => event.kind === "work" && !event.presence));
    const spokenAnswer = scanned[0].session.events.find((event) => event.ts === Date.parse("2026-06-03T10:03:00Z"));
    assert.equal(spokenAnswer.reactionAnchor, false);
    const log = mergeLogs([...collectCodexWorklog(`/tmp/proj-${name}`, SINCE, UNTIL, "UTC", COUNTING_CODEX).values()]);
    assert.deepEqual(log.prompts, []);
  }
});

test("install: writes skills, skips missing codex, is idempotent", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ah-test-"));
  try {
    let results = runInstall("all", home);
    assert.equal(results[0].status, "installed");
    assert.equal(results[1].status, "skipped"); // no ~/.codex in temp home
    const skillPath = path.join(home, ".claude", "skills", "agent-hours", "SKILL.md");
    assert.equal(fs.readFileSync(skillPath, "utf8"), SKILL_MD);

    fs.mkdirSync(path.join(home, ".codex"));
    results = runInstall("all", home);
    assert.equal(results[0].status, "updated");
    assert.equal(results[1].status, "installed");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("install: honors an explicit CODEX_HOME without leaking the real environment", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ah-home-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "ah-codex-home-"));
  try {
    const results = runInstall("codex", home, codexHome);
    assert.equal(results[0].status, "installed");
    assert.equal(results[0].path, path.join(codexHome, "skills", "agent-hours", "SKILL.md"));
    assert.equal(fs.readFileSync(results[0].path, "utf8"), SKILL_MD);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("retention: check + set with backup, never lowers, refuses bad JSON", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ret-"));
  const settings = path.join(home, ".claude", "settings.json");
  try {
    // unset → not sufficient
    assert.equal(checkRetention(home).current, null);
    assert.equal(checkRetention(home).sufficient, false);

    // setting on a missing file creates it
    let r = setRetention(365, home);
    assert.equal(r.ok, true);
    assert.equal(r.previous, null);
    assert.equal(checkRetention(home).current, 365);
    assert.equal(checkRetention(home).sufficient, true);

    // preserves other keys + writes a backup when a file already exists
    fs.writeFileSync(settings, JSON.stringify({ language: "German", cleanupPeriodDays: 30 }));
    r = setRetention(365, home);
    assert.equal(r.ok, true);
    assert.equal(r.previous, 30);
    assert.ok(fs.existsSync(r.backupPath));
    const after = JSON.parse(fs.readFileSync(settings, "utf8"));
    assert.equal(after.cleanupPeriodDays, 365);
    assert.equal(after.language, "German");

    // never lowers an already-higher value
    fs.writeFileSync(settings, JSON.stringify({ cleanupPeriodDays: 999 }));
    r = setRetention(365, home);
    assert.equal(r.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).cleanupPeriodDays, 999);

    // refuses to clobber invalid JSON
    fs.writeFileSync(settings, "{ not json");
    r = setRetention(365, home);
    assert.equal(r.ok, false);
    assert.match(r.error, /not valid JSON/);
    assert.equal(fs.readFileSync(settings, "utf8"), "{ not json");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("timeline loaders preserve context and the split filters prompt counts", () => {
  const sessions = loadProject(LEGACY, { pruneBeforeMs: parseDate("2026-06-01 10:04") });
  const merged = mergeEvents(sessions);
  assert.equal(merged.length, 7);
  assert.equal(computeRefinedSplit(merged, {
    capMinutes: 10, promptCapMinutes: 10, rangeStartMs: parseDate("2026-06-01 10:04"),
  }).promptCount, 1);
});

test("parseDate handles the three accepted formats", () => {
  assert.equal(parseDate("2026-06-01"), Date.parse("2026-06-01T00:00:00Z"));
  assert.equal(parseDate("2026-06-01 10:30"), Date.parse("2026-06-01T10:30:00Z"));
  assert.equal(parseDate("2026-06-01T10:30:00Z"), Date.parse("2026-06-01T10:30:00Z"));
  assert.throws(() => parseDate("garbage"));
  assert.throws(() => parseDate("2026-13-01"));
  assert.throws(() => parseDate("2026-02-30 12:00"));
  assert.throws(() => parseDate("2026-02-30T12:00:00Z"));
  assert.throws(() => parseDate("2026-03-29 02:30", "Europe/Berlin"), /does not exist/);
});

test("IANA timezone parsing and buckets follow Berlin winter and summer time", () => {
  assert.equal(
    parseDate("2026-01-15 12:00", "Europe/Berlin"),
    Date.parse("2026-01-15T11:00:00Z")
  );
  assert.equal(
    parseDate("2026-07-15 12:00", "Europe/Berlin"),
    Date.parse("2026-07-15T10:00:00Z")
  );
  assert.equal(dayKey(Date.parse("2026-01-01T23:30:00Z"), "Europe/Berlin"), "2026-01-02");
  assert.equal(hourKey(Date.parse("2026-07-15T22:30:00Z"), "Europe/Berlin"), "2026-07-16 00:00");
});

test("IANA buckets reflect both sides of daylight-saving transitions", () => {
  assert.equal(hourKey(Date.parse("2026-03-29T00:30:00Z"), "Europe/Berlin"), "2026-03-29 01:00");
  assert.equal(hourKey(Date.parse("2026-03-29T01:30:00Z"), "Europe/Berlin"), "2026-03-29 03:00");
  assert.equal(hourKey(Date.parse("2026-10-25T00:30:00Z"), "Europe/Berlin"), "2026-10-25 02:00");
  assert.equal(hourKey(Date.parse("2026-10-25T01:30:00Z"), "Europe/Berlin"), "2026-10-25 02:00 (repeated)");
});

test("projectToHash matches Claude Code's directory naming", () => {
  assert.equal(projectToHash("/Users/x/code/foo"), "-Users-x-code-foo");
});

test("projectToHash sanitizes every non-alphanumeric char (regression: umlauts)", () => {
  // Claude Code replaces EVERY non-alphanumeric with "-", not just "/".
  // Build the path from code points so the source stays pure ASCII.
  const u = String.fromCharCode(0x00fc); // ü (NFC, single code point)
  const base = `/Users/x/code/m${u}ller-repo`;
  const want = "-Users-x-code-m-ller-repo";
  // NFC input (composed ü = U+00FC)
  assert.equal(projectToHash(base.normalize("NFC")), want);
  // NFD input (decomposed ü = u + U+0308) — what macOS process.cwd() returns.
  // Must normalize to NFC first, else the "u" survives as "mu-".
  assert.equal(projectToHash(base.normalize("NFD")), want);
  assert.equal(projectToHash("/x/my.repo"), "-x-my-repo");
  assert.equal(projectToHash("/x/a b"), "-x-a-b"); // space -> dash
});

test("Claude descendant-project discovery confirms cwd and excludes hash-prefix siblings", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ah-projects-"));
  try {
    const project = path.join(base, "target-project");
    const cases = [
      [projectToHash(project), project],
      [projectToHash(project + "/sub"), project + "/sub"],
      [projectToHash(project + "-sibling"), project + "-sibling"],
    ];
    for (const [name, cwd] of cases) {
      const dir = path.join(base, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "session.jsonl"),
        JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:00Z", cwd }) + "\n"
      );
    }
    assert.deepEqual(
      findClaudeProjectDirs(project, base).map((p) => path.basename(p)).sort(),
      [projectToHash(project), projectToHash(project + "/sub")].sort()
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

function assertHourInvariants(split) {
  let total = 0;
  let upper = 0;
  for (const bucket of split.byHour.values()) {
    assert.ok(bucket.total <= 60 + 1e-9);
    near(bucket.total, bucket.handsOn + bucket.supervised + bucket.ai);
    assert.ok(bucket.handsOn + bucket.supervised <= bucket.upper + 1e-9);
    assert.ok(bucket.upper <= bucket.total + 1e-9);
    total += bucket.total;
    upper += bucket.upper;
  }
  near(total, split.totalMinutes);
  near(upper, split.upperBoundMinutes);
}

test("credited segments clip at range and hour boundaries", () => {
  const events = ["2026-06-01T09:59:00Z", "2026-06-01T10:04:00Z"].map((ts) => ({
    ts: Date.parse(ts), kind: "work", presence: false,
  }));
  const split = computeRefinedSplit(events, {
    capMinutes: 10, promptCapMinutes: 10, timeZone: "UTC",
    rangeStartMs: Date.parse("2026-06-01T10:00:00Z"),
    rangeEndMs: Date.parse("2026-06-01T10:05:00Z"),
  });
  assert.equal(split.totalMinutes, 4);
  assert.equal(split.byHour.get("2026-06-01 10:00").total, 4);
  assertHourInvariants(split);
  assert.equal(cappedMinutesInRange(events.map((e) => e.ts), 2, events[0].ts + 60000, events[1].ts), 1);
  assert.equal(cappedMinutesInRange(events.map((e) => e.ts), 2, events[0].ts + 60000, events[1].ts, true), 0);
});

test("midnight segments give two minutes to the first day and three to the next", () => {
  const events = ["2026-06-01T23:58:00Z", "2026-06-02T00:03:00Z"].map((ts) => ({
    ts: Date.parse(ts), kind: "work", presence: false,
  }));
  const split = computeRefinedSplit(events, { capMinutes: 10, promptCapMinutes: 10, timeZone: "UTC" });
  assert.equal(split.byHour.get("2026-06-01 23:00").total, 2);
  assert.equal(split.byHour.get("2026-06-02 00:00").total, 3);
  assertHourInvariants(split);
});

test("range clipping is additive for every state, upper budget, prompts and hour buckets", () => {
  const event = (minute, kind, extra = {}) => ({ ts: minutes(minute)[0], kind, presence: kind === "prompt", ...extra });
  const merged = mergeEvents([
    { name: "main", events: [event(0, "prompt"), event(2, "work", { reactionAnchor: true }), event(8, "prompt", { midTurn: true }), event(13, "work", { reactionAnchor: true }), event(17, "prompt"), event(90, "work"), event(94, "prompt")] },
    { name: "parallel", events: [event(3, "work"), event(10, "work", { presence: true }), event(55, "work"), event(92, "work", { reactionAnchor: true })] },
  ]);
  for (const [capMinutes, promptCapMinutes] of [[10, 10], [1, 10], [10, 3]]) {
    const split = (a, b) => computeRefinedSplit(merged, {
      capMinutes, promptCapMinutes, timeZone: "UTC", rangeStartMs: minutes(a)[0], rangeEndMs: minutes(b)[0],
    });
    for (const boundary of [8, 14, 60]) {
      const left = split(1, boundary), right = split(boundary, 95), whole = split(1, 95);
      for (const key of ["totalMinutes", "handsOnMinutes", "supervisedMinutes", "attentionMinutes", "aiAutonomousMinutes", "upperBoundMinutes", "promptCount"]) {
        near(left[key] + right[key], whole[key]);
      }
      for (const [hour, bucket] of whole.byHour) {
        for (const state of ["total", "handsOn", "supervised", "ai", "upper"]) {
          near((left.byHour.get(hour)?.[state] ?? 0) + (right.byHour.get(hour)?.[state] ?? 0), bucket[state]);
        }
      }
      for (const result of [left, right, whole]) assertHourInvariants(result);
    }
  }
  assert.equal([...countByDay(minutes(0, 8, 17), "UTC", minutes(8)[0], minutes(17)[0]).values()][0], 1);
});

test("DST fold has separate ordinary and repeated hour buckets in worklogs too", () => {
  const start = Date.parse("2026-10-25T00:00:00Z");
  const events = Array.from({ length: 24 }, (_, i) => ({ ts: start + i * 5 * 60000, kind: "work", presence: false }));
  events.push({ ts: start + 119 * 60000, kind: "work", presence: false });
  const split = computeRefinedSplit(events, { capMinutes: 10, promptCapMinutes: 10, timeZone: "Europe/Berlin" });
  assert.deepEqual([...split.byHour.keys()].sort(), ["2026-10-25 02:00", "2026-10-25 02:00 (repeated)"]);
  assert.equal(split.byHour.get("2026-10-25 02:00").total, 60);
  assert.equal(split.byHour.get("2026-10-25 02:00 (repeated)").total, 59);
  assertHourInvariants(split);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-fold-"));
  try {
    fs.writeFileSync(path.join(dir, "session.jsonl"), [30, 90].map((minute) => JSON.stringify({
      type: "user", timestamp: new Date(start + minute * 60000).toISOString(), message: { content: "Review." },
    })).join("\n"));
    assert.deepEqual([...collectWorklog(dir, SINCE, UNTIL, "Europe/Berlin").keys()].sort(), [...split.byHour.keys()].sort());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("streaming JSONL preserves split UTF-8 and final lines, skips invalid records and stops early", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-jsonl-"));
  try {
    const file = path.join(dir, "records.jsonl");
    // The first byte of this two-byte character is byte 6, at the chunk border.
    const first = { x: "\u00e9" }, last = { final: true };
    fs.writeFileSync(file, JSON.stringify(first) + "\nnull\n{invalid\n\n42\n[]\n" + JSON.stringify(last));
    const records = [];
    forEachJsonlRecord(file, (r) => { records.push(r); }, { chunkSize: 7 });
    assert.deepEqual(records, [first, last]);
    const early = [];
    forEachJsonlRecord(file, (r) => { early.push(r); return false; }, { chunkSize: 7 });
    assert.deepEqual(early, [first]);
    const limited = [];
    forEachJsonlRecord(file, (r) => { limited.push(r); }, { chunkSize: 7, maxLines: 3 });
    assert.deepEqual(limited, [first]);
    const before = unreadableFileCount;
    forEachJsonlRecord(path.join(dir, "missing.jsonl"), () => assert.fail("missing file yielded a record"));
    assert.equal(unreadableFileCount, before + 1);
    assert.throws(() => forEachJsonlRecord(file, () => {}, { chunkSize: 0 }), /chunkSize/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("mtime pruning skips old Claude parents, subagents and Codex rollouts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-mtime-"));
  try {
    const since = Date.parse("2026-06-01T00:00:00Z");
    const timestamp = "2026-06-02T00:00:00Z";
    const parent = path.join(dir, "session.jsonl");
    const sub = path.join(dir, "session", "subagents", "agent.jsonl");
    fs.mkdirSync(path.dirname(sub), { recursive: true });
    for (const file of [parent, sub]) {
      fs.writeFileSync(file, JSON.stringify({ type: "user", timestamp, message: { content: "Review." } }));
      fs.utimesSync(file, new Date(since - 1), new Date(since - 1));
    }
    assert.deepEqual(loadProject(dir, { pruneBeforeMs: since }), []);
    assert.equal(collectWorklog(dir, since, UNTIL, "UTC").size, 0);
    assert.equal(loadProject(dir).length, 2);
    const rollout = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(rollout, [
      { type: "session_meta", timestamp, payload: { cwd: "/tmp/project", source: "cli" } },
      { type: "response_item", timestamp, payload: { type: "message", role: "user", content: "Review." } },
    ].map((r) => JSON.stringify(r)).join("\n"));
    fs.utimesSync(rollout, new Date(since - 1), new Date(since - 1));
    assert.deepEqual(loadCodexSessions("/tmp/project", { pruneBeforeMs: since }, dir), []);
    assert.equal(collectCodexWorklog("/tmp/project", since, UNTIL, "UTC", dir).size, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("hash collisions match each cwd and attach subagents to their own parent", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ah-collision-"));
  const projects = ["/tmp/project-a", "/tmp/project/a"];
  const dir = path.join(base, projectToHash(projects[0]));
  try {
    assert.equal(projectToHash(projects[0]), projectToHash(projects[1]));
    fs.mkdirSync(dir);
    for (const [i, cwd] of projects.entries()) {
      const record = { type: "user", cwd, timestamp: "2026-06-01T10:00:00Z", message: { content: `Prompt ${i}` } };
      fs.writeFileSync(path.join(dir, `${i}.jsonl`), JSON.stringify(record));
      const subdir = path.join(dir, String(i), "subagents", "workflows");
      fs.mkdirSync(subdir, { recursive: true });
      // Contradictory child cwd must not override an existing parent's identity.
      fs.writeFileSync(path.join(subdir, "agent.jsonl"), JSON.stringify({ ...record, cwd: projects[1 - i] }));
    }
    fs.writeFileSync(path.join(dir, "legacy.jsonl"), JSON.stringify({ type: "assistant", timestamp: "2026-06-01T10:00:00Z" }));
    const orphan = path.join(dir, "orphan", "subagents");
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, "agent.jsonl"), JSON.stringify({ type: "assistant", cwd: projects[1], timestamp: "2026-06-01T10:00:00Z" }));
    for (const [i, project] of projects.entries()) {
      assert.deepEqual(findClaudeProjectDirs(project, base), [dir]);
      const sessions = loadProject(dir, {}, project);
      assert.ok(sessions.some((s) => s.name === `${i}.jsonl`));
      assert.ok(!sessions.some((s) => s.name === `${1 - i}.jsonl`));
      assert.ok(sessions.some((s) => s.name === `${i}/subagents/workflows/agent.jsonl`));
      assert.ok(sessions.some((s) => s.name === "legacy.jsonl"));
      assert.equal(sessions.some((s) => s.name === "orphan/subagents/agent.jsonl"), i === 1);
      const log = mergeLogs([...collectWorklog(dir, SINCE, UNTIL, "UTC", project).values()]);
      assert.deepEqual(log.prompts, [`Prompt ${i}`]);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("queued human typing at the ending prompt proves supervised presence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-queue-"));
  try {
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(file, [
      { type: "user", timestamp: new Date(minutes(0)[0]).toISOString(), message: { content: "Start." } },
      { type: "assistant", timestamp: new Date(minutes(1)[0]).toISOString() },
      { type: "queue-operation", operation: "enqueue", timestamp: new Date(minutes(8)[0]).toISOString(), content: "Next." },
    ].map((r) => JSON.stringify(r)).join("\n"));
    const merged = mergeEvents(loadProject(dir));
    assert.equal(merged.at(-1).midTurn, true);
    const split = computeRefinedSplit(merged, { capMinutes: 10, promptCapMinutes: 10 });
    assert.equal(split.supervisedMinutes, 1);
    assertHourInvariants(split);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Claude question answers are prompts, preserve worklog excerpts and credit reaction tails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-question-"));
  try {
    const answer = {
      type: "user", timestamp: new Date(minutes(4)[0]).toISOString(),
      message: { content: [{ type: "tool_result", tool_use_id: "question-1", content: "Answered." }] },
      toolUseResult: { questions: [{ question: "Which color?" }], answers: { "Which color?": "Blue" } },
    };
    assert.deepEqual(classifyRecord(answer), { kind: "prompt", presence: true });
    assert.equal(classifyKind({ ...answer, isSidechain: true }), "work");
    assert.equal(classifyKind({ ...answer, promptSource: "system" }), "work");
    assert.equal(classifyKind({ ...answer, toolUseResult: { answers: { choice: "Blue" } } }), "work");
    fs.writeFileSync(path.join(dir, "session.jsonl"), [
      // The initiating prompt is context outside the measured range.
      { type: "user", timestamp: new Date(minutes(-1)[0]).toISOString(), message: { content: "Change the color." } },
      { type: "assistant", timestamp: new Date(minutes(0)[0]).toISOString(), message: { content: [{ type: "tool_use", id: "question-1", name: "AskUserQuestion", input: {} }] } },
      answer,
    ].map((r) => JSON.stringify(r)).join("\n"));
    const split = computeRefinedSplit(mergeEvents(loadProject(dir)), {
      capMinutes: 10, promptCapMinutes: 10, rangeStartMs: minutes(0)[0], rangeEndMs: minutes(5)[0],
    });
    assert.equal(split.promptCount, 1);
    assert.ok(split.handsOnMinutes > 0);
    near(split.handsOnMinutes, 4);
    assertHourInvariants(split);
    const log = mergeLogs([...collectWorklog(dir, minutes(0)[0], minutes(5)[0], "UTC").values()]);
    assert.deepEqual(log.prompts, ["Blue"]);
    assert.equal(loadSessionEvents(path.join(dir, "session.jsonl"), {}, true).at(-1).kind, "work");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Codex pruning keeps old base metadata to classify a fresh continuation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-base-mtime-"));
  try {
    const cutoff = Date.parse("2026-09-19T00:00:00Z");
    const base = path.join(dir, "base.jsonl");
    fs.writeFileSync(base, [
      { type: "session_meta", timestamp: "2026-09-01T00:00:00Z", payload: { id: "thread-1", cwd: "/tmp/project", source: "cli" } },
      { type: "response_item", timestamp: "2026-09-01T00:01:00Z", payload: { type: "message", role: "user", content: "Old input." } },
    ].map((r) => JSON.stringify(r)).join("\n"));
    fs.utimesSync(base, new Date(cutoff - 1), new Date(cutoff - 1));
    fs.writeFileSync(path.join(dir, "continuation.jsonl"), [
      { type: "session_meta", timestamp: "2026-09-20T00:00:00Z", payload: { id: "thread-1", cwd: "/tmp/project", source: "exec", history_base: { end_ordinal_exclusive: 2 } } },
      { type: "response_item", timestamp: "2026-09-20T00:01:00Z", payload: { type: "message", role: "user", content: "Continue." } },
    ].map((r) => JSON.stringify(r)).join("\n"));
    const sessions = loadCodexSessions("/tmp/project", { pruneBeforeMs: cutoff }, dir);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].name, "codex:base.jsonl");
    assert.equal(sessions[0].events.filter((event) => event.kind === "prompt").length, 1);
    assert.ok(sessions[0].events.every((event) => event.ts >= cutoff));
    assert.deepEqual(mergeLogs([...collectCodexWorklog("/tmp/project", cutoff, UNTIL, "UTC", dir).values()]).prompts, ["Continue."]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
