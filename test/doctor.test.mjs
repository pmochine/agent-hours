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
