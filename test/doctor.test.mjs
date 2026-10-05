import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const stamp = (minutes) => new Date(Date.now() - (60 - minutes) * 60000).toISOString();

function fixture(callback) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ah-doctor-"));
  const codexHome = path.join(home, ".codex");
  const project = path.join(home, ".claude", "projects", "project-1");
  const sessions = path.join(codexHome, "sessions");
  const write = (file, records) => fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n"));
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(path.join(codexHome, "archived_sessions"));
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ cleanupPeriodDays: 365 }));
  write(path.join(project, "session.jsonl"), [
    { type: "user", timestamp: stamp(0), cwd: "/tmp/doctor-project", promptSource: "typed", message: { content: "Private fixture prompt." } },
    { type: "assistant", timestamp: stamp(1), message: { content: "Private fixture output." } },
  ]);
  write(path.join(sessions, "rollout.jsonl"), [
    { type: "session_meta", timestamp: stamp(0), payload: { id: "doctor", cwd: "/tmp/doctor-project", source: "cli", originator: "codex-tui" } },
    { type: "response_item", timestamp: stamp(1), payload: { type: "message", role: "user", content: "Private Codex prompt." } },
  ]);
  const run = (args = [], extra = {}) => spawnSync(process.execPath, [CLI, "doctor", ...args], {
    encoding: "utf8", env: { ...process.env, HOME: home, CODEX_HOME: codexHome, PATH: home, ...extra },
  });
  try { callback({ home, project, sessions, write, run }); }
  finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test("doctor clean fixtures return OK, parseable JSON, and no project paths or content", () => {
  fixture(({ run }) => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /doctor: OK\n$/);
    assert.doesNotMatch(result.stdout, /Private|doctor-project/);
    const jsonResult = run(["--json"]);
    assert.equal(jsonResult.status, 0, jsonResult.stderr);
    const report = JSON.parse(jsonResult.stdout);
    assert.equal(report.status, "doctor: OK");
    assert.equal(report.sources.claude.projectDirectories, 1);
    assert.equal(report.sources.claude.files, 1);
    assert.equal(report.sources.codexSessions.files, 1);
    assert.equal(report.scan.filesScanned, 2);
    assert.equal(report.scan.bytesRead, report.sources.claude.bytes + report.sources.codexSessions.bytes);
    assert.doesNotMatch(jsonResult.stdout, /Private|doctor-project/);
  });
});

test("doctor warns about an unknown Claude kind and Codex originator but exits zero", () => {
  fixture(({ project, sessions, write, run }) => {
    write(path.join(project, "unknown.jsonl"), [{ type: "future_kind", timestamp: stamp(2), content: "Private unknown content." }]);
    write(path.join(sessions, "unknown.jsonl"), [{ type: "session_meta", timestamp: stamp(2), payload: { id: "future", cwd: "/tmp/doctor-project", source: "cli", originator: "future-agent" } }]);
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"future_kind\|\|\|": 1/);
    assert.match(result.stdout, /"future-agent": 1/);
    assert.match(result.stdout, /doctor: 2 warnings\n$/);
    assert.doesNotMatch(result.stdout, /Private|doctor-project/);
    const report = JSON.parse(run(["--json"]).stdout);
    assert.deepEqual(report.scan.unknownClaudeKinds, [{ kind: "future_kind|||", count: 1 }]);
    assert.equal(report.warnings.length, 2);
  });
});

test("doctor checks retention, nested workflows, continuations, unsupported files and passive candidates", () => {
  fixture(({ project, sessions, write, run }) => {
    const workflow = path.join(project, "session", "subagents", "workflows", "wf_x");
    fs.mkdirSync(workflow, { recursive: true });
    write(path.join(workflow, "agent.jsonl"), [{ type: "assistant", timestamp: stamp(1) }]);
    write(path.join(project, "passive.jsonl"), [
      { type: "assistant", timestamp: stamp(0) },
      { type: "system", subtype: "away_summary", timestamp: stamp(20), content: "Private summary." },
      { type: "assistant", timestamp: stamp(23) },
      { type: "system", subtype: "away_summary", timestamp: stamp(40) },
      { type: "user", promptSource: "typed", timestamp: stamp(41), message: { content: "Private answer." } },
    ]);
    const oldFile = path.join(project, "old.jsonl");
    write(oldFile, [{ type: "old_unscanned_kind", timestamp: stamp(1) }]);
    const oldDate = new Date(Date.now() - 360 * 86400000);
    fs.utimesSync(oldFile, oldDate, oldDate);
    write(path.join(sessions, "continuation.jsonl"), [{ type: "session_meta", timestamp: stamp(1), payload: { id: "continued", cwd: "/tmp/doctor-project", source: "cli", history_base: { end_ordinal_exclusive: 4 } } }]);
    let report = JSON.parse(run(["--json"]).stdout);
    assert.equal(report.structure.nestedSubagentDirectories, 0);
    assert.equal(report.structure.historyBaseFiles, 1);
    assert.equal(report.retention.cleanupPeriodDays, 365);
    assert.equal(report.warnings.length, 1);
    assert.deepEqual(report.scan.unknownClaudeKinds, []);
    assert.deepEqual(report.passiveCandidates, [{ kind: "claude:system|away_summary||", count: 1 }]);
    fs.mkdirSync(path.join(workflow, "unexpected"));
    fs.writeFileSync(path.join(sessions, "compressed.jsonl.zst"), "Unread compressed fixture.");
    fs.writeFileSync(path.join(sessions, "other.bin"), "Unread unknown fixture.");
    report = JSON.parse(run(["--json"]).stdout);
    assert.equal(report.structure.nestedSubagentDirectories, 1);
    assert.deepEqual(report.structure.unsupportedFiles, [{ kind: "*.jsonl.zst", count: 1 }, { kind: ".bin", count: 1 }]);
    assert.equal(report.warnings.length, 3);
  });
});

test("doctor reports unknown timestamped Codex kinds, prompt sources and source shapes", () => {
  fixture(({ project, sessions, write, run }) => {
    write(path.join(project, "source.jsonl"), [{ type: "user", promptSource: "future-source", timestamp: stamp(2), content: "Private source content." }]);
    write(path.join(sessions, "source.jsonl"), [
      { type: "session_meta", timestamp: stamp(2), payload: { id: "future", cwd: "/tmp/doctor-project", source: { future: { thread: "Private ID." } } } },
      { type: "event_msg", timestamp: stamp(3), payload: { type: "future_event", content: "Private event content." } },
      { type: "untimestamped_future", payload: { content: "Private metadata." } },
    ]);
    const result = run(["--json"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.scan.unknownPromptSources, [{ kind: "future-source", count: 1 }]);
    assert.deepEqual(report.scan.unknownSources, [{ kind: "future.thread", count: 1 }]);
    assert.deepEqual(report.scan.unknownCodexKinds, [{ kind: "event_msg|future_event|", count: 1 }]);
    assert.doesNotMatch(result.stdout, /Private|doctor-project/);
  });
});

test("doctor reports unreadable streaming files inside JSON without a second stderr warning", () => {
  fixture(({ home, project, run }) => {
    const script = path.join(home, "unreadable.cjs");
    const file = path.join(project, "session.jsonl");
    fs.writeFileSync(script, `
      const fs = require('node:fs');
      const open = fs.openSync;
      fs.openSync = (file, ...args) => {
        if (file === ${JSON.stringify(file)}) throw new Error('Unreadable fixture');
        return open(file, ...args);
      };
      require('node:module').syncBuiltinESMExports();
    `);
    const result = run(["--json"], { NODE_OPTIONS: `--require ${JSON.stringify(script)}` });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.structure.unreadableFiles, 1);
    assert.equal(report.status, "doctor: 1 warnings");
  });
});

test("doctor hides HOME in human-readable and JSON paths", () => {
  fixture(({ home, run }) => {
    for (const args of [[], ["--json"]]) {
      const result = run(args);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!result.stdout.includes(home), result.stdout);
      assert.ok(!result.stderr.includes(home), result.stderr);
      if (args.length) {
        const report = JSON.parse(result.stdout);
        assert.equal(report.sources.claude.directory, "~/.claude/projects");
        assert.equal(report.sources.codexHome, "~/.codex");
        assert.equal(report.sources.codexSessions.directory, "~/.codex/sessions");
        assert.equal(report.sources.codexArchivedSessions.directory, "~/.codex/archived_sessions");
      } else {
        assert.match(result.stdout, /Claude projects: ~\/\.claude\/projects/);
        assert.match(result.stdout, /CODEX_HOME: ~\/\.codex/);
      }
    }
    const exactHome = JSON.parse(run(["--json"], { CODEX_HOME: home }).stdout);
    assert.equal(exactHome.sources.codexHome, "~");
  });
});

test("doctor samples the first 8 MB on complete lines and continues to older files", () => {
  fixture(({ project, write, run }) => {
    const limit = 8 * 1024 * 1024;
    const file = path.join(project, "large.jsonl");
    const first = JSON.stringify({ type: "first_sample_kind", timestamp: stamp(1) }) + "\n";
    const crossing = JSON.stringify({ type: "crossing_sample_kind", timestamp: stamp(2), content: "x".repeat(limit) }) + "\n";
    const after = JSON.stringify({ type: "after_sample_kind", timestamp: stamp(3) }) + "\n";
    fs.writeFileSync(file, first + crossing + after);
    write(path.join(project, "older.jsonl"), [{ type: "older_sample_kind", timestamp: stamp(1) }]);
    const older = new Date(Date.now() - 60000);
    fs.utimesSync(path.join(project, "older.jsonl"), older, older);
    const report = JSON.parse(run(["--json"]).stdout);
    assert.equal(report.scan.filesScanned, 4);
    assert.equal(report.scan.recentFiles, 4);
    assert.equal(report.scan.sampledFiles, 1);
    assert.equal(report.scan.fileReadLimitBytes, limit);
    assert.equal(report.scan.limited, false);
    assert.deepEqual(report.scan.unknownClaudeKinds, [
      { kind: "first_sample_kind|||", count: 1 },
      { kind: "older_sample_kind|||", count: 1 },
    ]);
    const otherBytes = fs.statSync(path.join(project, "older.jsonl")).size + fs.statSync(path.join(project, "session.jsonl")).size;
    assert.equal(report.scan.bytesRead, limit + otherBytes + report.sources.codexSessions.bytes);
  });
});

test("doctor distributes the budget across every recent file within the total cap", () => {
  fixture(({ project, sessions, run }) => {
    const limit = 8 * 1024 * 1024;
    const newest = Date.now();
    for (let i = 0; i < 51; i++) {
      const file = path.join(project, `sample-${i}.jsonl`);
      fs.writeFileSync(file, JSON.stringify({ type: `sample_${i}`, timestamp: stamp(1) }) + "\n");
      // Sparse padding avoids allocating 400 MB of fixture content.
      fs.truncateSync(file, limit + 1);
      const modified = new Date(newest - i * 1000);
      fs.utimesSync(file, modified, modified);
    }
    const old = new Date(newest - 60000);
    fs.utimesSync(path.join(project, "session.jsonl"), old, old);
    fs.utimesSync(path.join(sessions, "rollout.jsonl"), old, old);
    const result = run(["--json"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    const sampleBytes = Math.floor(400 * 1024 * 1024 / 53);
    assert.equal(report.scan.fileReadLimitBytes, sampleBytes);
    assert.equal(report.scan.bytesRead, 51 * sampleBytes + report.sources.codexSessions.bytes + fs.statSync(path.join(project, "session.jsonl")).size);
    assert.ok(report.scan.bytesRead <= report.scan.readLimitBytes);
    assert.equal(report.scan.limited, false);
    assert.equal(report.scan.filesScanned, 53);
    assert.equal(report.scan.recentFiles, 53);
    assert.equal(report.scan.sampledFiles, 51);
    assert.ok(report.scan.unknownClaudeKinds.some(({ kind }) => kind === "sample_0|||"));
    assert.ok(report.scan.unknownClaudeKinds.some(({ kind }) => kind === "sample_49|||"));
    assert.ok(report.scan.unknownClaudeKinds.some(({ kind }) => kind === "sample_50|||"));
  });
});

test("doctor distinguishes passive queue operations and human enqueues cancel candidates", () => {
  fixture(({ project, write, run }) => {
    write(path.join(project, "queue.jsonl"), [
      { type: "assistant", timestamp: stamp(0) },
      { type: "queue-operation", operation: "enqueue", timestamp: stamp(20), content: "<task-notification>Private task.</task-notification>" },
      { type: "assistant", timestamp: stamp(23) },
      { type: "queue-operation", operation: "dequeue", timestamp: stamp(40), content: "Private queued content." },
      { type: "assistant", timestamp: stamp(43) },
      { type: "queue-operation", operation: "enqueue", timestamp: stamp(60), content: "<task-notification>Private second task.</task-notification>" },
      { type: "queue-operation", operation: "enqueue", timestamp: stamp(61), content: "Private human input." },
      { type: "assistant", timestamp: stamp(64) },
      { type: "queue-operation", operation: "enqueue", timestamp: stamp(80), content: "Private human input after a gap." },
      { type: "assistant", timestamp: stamp(83) },
    ]);
    const result = run(["--json"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.passiveCandidates, [
      { kind: "claude:queue-operation|dequeue|other", count: 1 },
      { kind: "claude:queue-operation|enqueue|task-notification", count: 1 },
    ]);
    assert.deepEqual(report.scan.unknownClaudeKinds, []);
    assert.doesNotMatch(result.stdout, /Private/);
  });
});

test("doctor recognizes only the three approved canary additions", () => {
  fixture(({ project, sessions, write, run }) => {
    write(path.join(project, "scheduled.jsonl"), [{ type: "system", subtype: "scheduled_task_fire", timestamp: stamp(2) }]);
    write(path.join(sessions, "desktop.jsonl"), [{ type: "session_meta", timestamp: stamp(2), payload: { id: "desktop", cwd: "/tmp/doctor-project", source: "cli", originator: "codex_work_desktop" } }]);
    write(path.join(sessions, "subagent.jsonl"), [{ type: "session_meta", timestamp: stamp(2), payload: { id: "subagent", cwd: "/tmp/doctor-project", source: { subagent: { thread_spawn: {} } }, originator: "codex-tui" } }]);
    const result = run(["--json"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "doctor: OK");
    assert.deepEqual(report.scan.unknownClaudeKinds, []);
    assert.deepEqual(report.scan.unknownOriginators, []);
    assert.deepEqual(report.scan.unknownSources, []);
  });
});

test("doctor treats a bare subagent source as machine work without unknown-source warnings", () => {
  fixture(({ sessions, write, run }) => {
    write(path.join(sessions, "bare-subagent.jsonl"), [
      { type: "session_meta", timestamp: stamp(0), payload: { id: "bare-subagent", cwd: "/tmp/doctor-project", source: { subagent: "review" } } },
      { type: "response_item", timestamp: stamp(20), payload: { type: "message", role: "user", content: "Delegated work." } },
      { type: "response_item", timestamp: stamp(23), payload: { type: "message", role: "assistant", content: "Completed." } },
    ]);
    const result = run(["--json"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.scan.unknownSources, []);
    assert.equal(report.status, "doctor: OK");
    // A human-shaped message after a long gap stays a passive candidate.
    assert.deepEqual(report.passiveCandidates, [{ kind: "codex:response_item|message|", count: 1 }]);
  });
});
