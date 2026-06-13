import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeMinutes,
  activeMinutesStrict,
  classifyKind,
  classifyRecord,
  computeRefinedSplit,
  computeSplit,
  detectOverlaps,
  findPauses,
  loadProject,
  mergeEvents,
  parseDate,
  projectToHash,
} from "../dist/core.js";
import { collectWorklog, describeLog, mergeLogs } from "../dist/worklog.js";
import { loadCodexSessions } from "../dist/sources/codex.js";
import { runInstall, SKILL_MD } from "../dist/install.js";
import fs from "node:fs";
import os from "node:os";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const LEGACY = path.join(FIXTURES, "legacy");
const MODERN = path.join(FIXTURES, "modern");
const SINCE = 0;
const UNTIL = Date.parse("2100-01-01T00:00:00Z");

function minutes(...mins) {
  const base = Date.parse("2026-06-01T10:00:00Z");
  return mins.map((m) => base + m * 60000);
}

test("activeMinutes caps each gap (cap bonus)", () => {
  assert.equal(activeMinutes(minutes(0, 5, 30), 10), 15);
  assert.equal(activeMinutes(minutes(0), 10), 0);
  assert.equal(activeMinutes([], 10), 0);
});

test("activeMinutesStrict drops gaps above the cap entirely", () => {
  assert.equal(activeMinutesStrict(minutes(0, 5, 30), 10), 5);
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
  // phantom prompts: scheduled tasks / hooks delivered as user messages
  assert.equal(classifyKind({ type: "user", promptSource: "system", message: { content: "x" } }), "work");
  // queued injection: typing already credited at the enqueue event
  assert.equal(classifyKind({ type: "user", promptSource: "queued", message: { content: "x" } }), "work");
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
  const sessions = loadProject(LEGACY, SINCE, UNTIL);
  assert.equal(sessions.length, 2);
  assert.equal(detectOverlaps(sessions), true);

  const merged = mergeEvents(sessions);
  assert.equal(activeMinutes(merged.map((e) => e.ts), 10), 16);

  const sum = sessions.reduce(
    (acc, s) => acc + activeMinutes(s.events.map((e) => e.ts), 10),
    0
  );
  assert.equal(sum, 18);
});

test("legacy fixtures: binary split (upper-bound heuristic)", () => {
  const merged = mergeEvents(loadProject(LEGACY, SINCE, UNTIL));
  const split = computeSplit(merged, 10, 10);
  assert.equal(split.totalMinutes, 16);
  assert.equal(split.promptCount, 2);
  assert.equal(split.humanMinutes, 10);
  assert.equal(split.aiSoloMinutes, 6);
});

test("legacy fixtures: refined three-state split", () => {
  const merged = mergeEvents(loadProject(LEGACY, SINCE, UNTIL));
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
  const sessions = loadProject(MODERN, SINCE, UNTIL);
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
  const merged = mergeEvents(loadProject(MODERN, SINCE, UNTIL));
  const r = computeRefinedSplit(merged, { capMinutes: 10, promptCapMinutes: 10, tzOffsetHours: 0 });
  assert.equal(r.totalMinutes, 10);
  assert.equal(r.handsOnMinutes, 1.5);
  // fast reaction (30s) + presence proof (external edit) => both segments fully supervised
  assert.equal(r.supervisedMinutes, 8.5);
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
  assert.match(desc, /Popup fertig gebaut/); // away_summary prose reused for free
  assert.match(desc, /2 files:/);
  // truncation respects maxLen
  assert.ok(describeLog(all, 40).length <= 40);
});

test("codex adapter: cwd matching, exec vs interactive, tag filtering", () => {
  const CODEX = path.join(FIXTURES, "codex-sessions");
  const sessions = loadCodexSessions("/tmp/proj", SINCE, UNTIL, CODEX);
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

test("since/until filter trims events", () => {
  const sessions = loadProject(LEGACY, parseDate("2026-06-01 10:04"), UNTIL);
  const merged = mergeEvents(sessions);
  assert.equal(merged.length, 3); // 10:05, 10:30, 10:31
});

test("parseDate handles the three accepted formats", () => {
  assert.equal(parseDate("2026-06-01"), Date.parse("2026-06-01T00:00:00Z"));
  assert.equal(parseDate("2026-06-01 10:30"), Date.parse("2026-06-01T10:30:00Z"));
  assert.equal(parseDate("2026-06-01T10:30:00Z"), Date.parse("2026-06-01T10:30:00Z"));
  assert.throws(() => parseDate("garbage"));
});

test("projectToHash matches Claude Code's directory naming", () => {
  assert.equal(projectToHash("/Users/x/code/foo"), "-Users-x-code-foo");
});

test("projectToHash sanitizes every non-alphanumeric char (regression: umlauts)", () => {
  // Claude Code replaces EVERY non-alphanumeric with "-", not just "/".
  // Build the path from code points so the source stays pure ASCII.
  const u = String.fromCharCode(0x00fc); // ü (NFC, single code point)
  const base = `/Users/shadrix/Documents/Coding/Cofana/manuel-m${u}hlhoffs-bot`;
  const want = "-Users-shadrix-Documents-Coding-Cofana-manuel-m-hlhoffs-bot";
  // NFC input (composed ü = U+00FC)
  assert.equal(projectToHash(base.normalize("NFC")), want);
  // NFD input (decomposed ü = u + U+0308) — what macOS process.cwd() returns.
  // Must normalize to NFC first, else the "u" survives as "mu-".
  assert.equal(projectToHash(base.normalize("NFD")), want);
  assert.equal(projectToHash("/x/my.repo"), "-x-my-repo");
  assert.equal(projectToHash("/x/a b"), "-x-a-b"); // space -> dash
});
