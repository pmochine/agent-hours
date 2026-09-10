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
  dayKey,
  detectOverlaps,
  findClaudeProjectDirs,
  findPauses,
  hourKey,
  loadProject,
  mergeEvents,
  parseDate,
  projectToHash,
} from "../dist/core.js";
import { collectCodexWorklog, collectWorklog, describeLog, mergeLogs } from "../dist/worklog.js";
import {
  canonicalProjectPath,
  loadCodexSessions,
  scanCodexSessions,
} from "../dist/sources/codex.js";
import { runInstall, SKILL_MD, checkRetention, setRetention } from "../dist/install.js";
import fs from "node:fs";
import os from "node:os";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const LEGACY = path.join(FIXTURES, "legacy");
const MODERN = path.join(FIXTURES, "modern");
const CODEX_CURRENT = path.join(FIXTURES, "codex-current");
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
  assert.equal(r.handsOnMinutes, 4);
  // Same-session reaction avoids treating the parallel subagent as proof of a
  // 30-second response; the later external edit remains real presence proof.
  assert.equal(r.supervisedMinutes, 5.5);
  assert.equal(r.aiAutonomousMinutes, 0.5);
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

test("current Codex logs: subagents, multipart prompts, archives, and deduplication", () => {
  const bases = [
    path.join(CODEX_CURRENT, "sessions"),
    path.join(CODEX_CURRENT, "archived_sessions"),
  ];
  const scanned = scanCodexSessions(SINCE, UNTIL, bases);
  assert.deepEqual(scanned.map((s) => s.sessionId).sort(), ["archived-only", "current-main", "current-sub"]);

  const sessions = loadCodexSessions("/tmp/proj-current", SINCE, UNTIL, bases);
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
  const scanned = scanCodexSessions(SINCE, UNTIL, dir);
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
  const composed = "/tmp/manuel-m" + String.fromCharCode(0x00fc) + "hl";
  assert.equal(canonicalProjectPath(composed), canonicalProjectPath(composed.normalize("NFD")));
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
  assert.equal(hourKey(Date.parse("2026-10-25T01:30:00Z"), "Europe/Berlin"), "2026-10-25 02:00");
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
