import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";
import { randomBytes } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { forEachJsonlRecord, unreadableFileCount } from "../dist/jsonl.js";
import { findCodexSessionFiles, loadCodexSessions } from "../dist/sources/codex.js";
import { mergeEvents, computeRefinedSplit } from "../dist/core.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const zstd = { skip: typeof zlib.zstdDecompressSync !== "function" ? "Reading *.jsonl.zst needs Node >= 22.15 (zlib.zstdDecompressSync unavailable)" : false };

async function fixture(callback) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ah-zstd-"));
  const sessions = path.join(home, "sessions");
  fs.mkdirSync(sessions);
  const run = (args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8", env: { ...process.env, HOME: home, CODEX_HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), PATH: home, ...extra },
  });
  try { return await callback({ home, sessions, run }); }
  finally { fs.rmSync(home, { recursive: true, force: true }); }
}

const records = [
  { type: "session_meta", timestamp: "2026-06-01T10:00:00Z", payload: { id: "compressed-thread", cwd: "/tmp/compressed-project", source: "cli" } },
  { type: "response_item", timestamp: "2026-06-01T10:00:00Z", payload: { type: "message", role: "user", content: "Start compressed work." } },
  { type: "response_item", timestamp: "2026-06-01T10:01:00Z", payload: { type: "message", role: "assistant", content: "Ready." } },
  { type: "response_item", timestamp: "2026-06-01T10:05:00Z", payload: { type: "message", role: "user", content: "Review compressed work." } },
];
const jsonl = records.map(JSON.stringify).join("\n");

test("compressed-only Codex session contributes prompts and time to both reports", zstd, async (t) => {
  for (const directory of ["sessions", "archived_sessions"]) {
    await t.test(directory, async (t) => {
      await fixture(async ({ home, run }) => {
        fs.mkdirSync(path.join(home, directory), { recursive: true });
        fs.writeFileSync(path.join(home, directory, "rollout.jsonl.zst"), zlib.zstdCompressSync(Buffer.from(jsonl)));
        const common = ["--source", "codex", "--json", "--timezone", "UTC"];
        await t.test("single project", () => {
          const result = run(["--project", "/tmp/compressed-project", ...common]);
          assert.equal(result.status, 0, result.stderr);
          const report = JSON.parse(result.stdout);
          assert.equal(report.prompts, 2);
          assert.equal(report.totalHours, 0.08);
          assert.ok(report.attentionHours > 0);
        });
        await t.test("all projects", () => {
          const result = run(["--all-projects", ...common]);
          assert.equal(result.status, 0, result.stderr);
          const report = JSON.parse(result.stdout);
          assert.equal(report.projects.length, 1);
          assert.equal(report.projects[0].events, 4);
          assert.equal(report.totalHours, 0.08);
          assert.ok(report.projects[0].attentionHours > 0);
        });
      });
    });
  }
});

test("plain copies win across active and archived directories and count once", zstd, async () => {
  await fixture(({ home, sessions, run }) => {
    const archived = path.join(home, "archived_sessions");
    fs.mkdirSync(archived);
    // A compressed active copy must not hide the preferred plain archive.
    fs.writeFileSync(path.join(sessions, "a.jsonl.zst"), zlib.zstdCompressSync(Buffer.from(jsonl)));
    const plain = path.join(archived, "z.jsonl");
    fs.writeFileSync(plain, jsonl);
    const files = findCodexSessionFiles("/tmp/compressed-project", [sessions, archived]);
    assert.deepEqual(files.map((meta) => meta.file), [plain]);
    const result = run(["--project", "/tmp/compressed-project", "--source", "codex", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.sessions, 1);
    assert.equal(report.prompts, 2);
    assert.equal(report.events, 4);
    assert.equal(report.totalHours, 0.08);
  });
});

test("compressed base or continuation merges each segment once", zstd, async () => {
  for (const compressedName of ["rollout-z-base.jsonl", "rollout-a-continuation.jsonl"]) {
    await fixture(({ home, sessions }) => {
      const archived = path.join(home, "archived_sessions");
      fs.mkdirSync(archived);
      for (const name of ["rollout-z-base.jsonl", "rollout-a-continuation.jsonl"]) {
        const bytes = fs.readFileSync(new URL(`./fixtures/counting/codex/sessions/${name}`, import.meta.url));
        fs.writeFileSync(path.join(sessions, name + (name === compressedName ? ".zst" : "")), name === compressedName ? zlib.zstdCompressSync(bytes) : bytes);
        fs.writeFileSync(path.join(archived, name + ".zst"), zlib.zstdCompressSync(bytes));
      }
      const dirs = [sessions, archived];
      assert.equal(findCodexSessionFiles("/tmp/proj-x", dirs).length, 2);
      const threads = loadCodexSessions("/tmp/proj-x", {}, dirs);
      assert.equal(threads.length, 1);
      assert.equal(threads[0].events.length, 7);
      const split = computeRefinedSplit(mergeEvents(threads), { capMinutes: 10, promptCapMinutes: 10, timeZone: "UTC" });
      assert.equal(split.promptCount, 2);
      assert.equal(split.totalMinutes, 9);
      assert.equal(split.attentionMinutes, 8.25);
    });
  }
});

test("compressed reader shares UTF-8, byte budgets, line limits and complete EOF rules", zstd, async () => {
  await fixture(({ sessions }) => {
    const file = path.join(sessions, "lines.jsonl.zst");
    const first = { x: "\u00e9" }, last = { final: true };
    const bytes = Buffer.from(JSON.stringify(first) + "\nnull\n{invalid\n\n42\n[]\n" + JSON.stringify(last));
    fs.writeFileSync(file, zlib.zstdCompressSync(bytes));
    const read = (options) => {
      const records = [];
      let total = 0;
      forEachJsonlRecord(file, (record) => { records.push(record); }, { ...options, onBytesRead: (size) => { total += size; } });
      return { records, total };
    };
    assert.deepEqual(read({ chunkSize: 7 }), { records: [first, last], total: bytes.length });
    assert.deepEqual(read({ chunkSize: 7, maxLines: 3 }).records, [first]);
    assert.deepEqual(read({ maxBytes: bytes.length - 1 }), { records: [first], total: bytes.length - 1 });
    assert.deepEqual(read({ maxBytes: bytes.length }), { records: [first, last], total: bytes.length });
    assert.deepEqual(read({ maxBytes: 1 }), { records: [], total: 1 });
  });
});

test("budgeted compressed reads grow prefixes for long first lines and stop before the whole file", zstd, async () => {
  await fixture(async ({ sessions }) => {
    // Incompressible text forces the compressed prefix to grow past 256 KiB.
    const first = { text: randomBytes(600 * 1024).toString("base64") };
    const tail = Array.from({ length: 6 }, () => JSON.stringify({ text: randomBytes(512 * 1024).toString("base64") })).join("\n");
    const bytes = Buffer.from(JSON.stringify(first) + "\n" + tail);
    const compressed = zlib.zstdCompressSync(bytes);
    const file = path.join(sessions, "large.jsonl.zst");
    fs.writeFileSync(file, compressed);
    // Measure actual decompression too, so an eager whole-file decoder cannot
    // pass merely by limiting the byte accounting after decompression.
    const builtin = createRequire(import.meta.url)("node:zlib");
    const original = builtin.zstdDecompressSync;
    const inputs = [], outputs = [];
    builtin.zstdDecompressSync = (data) => {
      inputs.push(data.length);
      const output = original(data);
      outputs.push(output.length);
      return output;
    };
    syncBuiltinESMExports();
    let reader;
    try { reader = await import(`../dist/jsonl.js?budget=${Date.now()}`); }
    finally { builtin.zstdDecompressSync = original; syncBuiltinESMExports(); }
    const records = [];
    let total = 0;
    reader.forEachJsonlRecord(file, (r) => { records.push(r); }, { maxLines: 1, onBytesRead: (size) => { total += size; } });
    assert.deepEqual(records, [first]);
    assert.deepEqual(inputs, [256 * 1024, 512 * 1024, 1024 * 1024]);
    assert.ok(Math.max(...outputs) < bytes.length);
    assert.ok(total >= Buffer.byteLength(JSON.stringify(first)) + 1);
    assert.ok(total < bytes.length);
    inputs.length = 0;
    let budgetBytes = 0;
    reader.forEachJsonlRecord(file, () => assert.fail("Partial first line was parsed"), { maxBytes: 128, onBytesRead: (size) => { budgetBytes += size; } });
    assert.equal(budgetBytes, 128);
    assert.deepEqual(inputs, [256 * 1024]);
  });
});

test("corrupt compressed files count as unreadable once without crashing", zstd, async () => {
  await fixture(({ sessions }) => {
    const file = path.join(sessions, "corrupt.jsonl.zst");
    fs.writeFileSync(file, "Not a zstd frame.");
    const before = unreadableFileCount;
    for (let i = 0; i < 2; i++) forEachJsonlRecord(file, () => assert.fail("Corrupt file yielded records"));
    assert.equal(unreadableFileCount, before + 1);
  });
});

test("doctor inventories and samples compressed sessions and worklog JSON includes their prompts", zstd, async () => {
  await fixture(({ sessions, run }) => {
    const current = records.map((record) => ({ ...record, timestamp: new Date().toISOString() }));
    current[0].payload = { ...current[0].payload, history_base: { end_ordinal_exclusive: 4 } };
    const bytes = Buffer.from(current.map(JSON.stringify).join("\n"));
    const compressed = zlib.zstdCompressSync(bytes);
    fs.writeFileSync(path.join(sessions, "rollout.jsonl.zst"), compressed);
    const result = run(["doctor", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.sources.codexSessions.files, 1);
    assert.equal(report.sources.codexSessions.bytes, compressed.length);
    assert.equal(report.scan.bytesRead, bytes.length);
    assert.equal(report.scan.filesScanned, 1);
    assert.equal(report.structure.historyBaseFiles, 1);
    assert.deepEqual(report.structure.unsupportedFiles, []);
    assert.equal(report.status, "doctor: OK");
    assert.doesNotMatch(run(["doctor"]).stdout, /"\*\.jsonl\.zst"/);
    const worklog = run(["--project", "/tmp/compressed-project", "--source", "codex", "--worklog-json"]);
    assert.equal(worklog.status, 0, worklog.stderr);
    assert.deepEqual(JSON.parse(worklog.stdout).hours.flatMap((hour) => hour.prompts), ["Start compressed work.", "Review compressed work."]);
  });
});

test("runtimes without zstd skip each compressed file once and doctor explains the Node requirement", async () => {
  await fixture(({ home, sessions, run }) => {
    const file = path.join(sessions, "rollout.jsonl.zst");
    fs.writeFileSync(file, "Must never be opened.");
    fs.writeFileSync(path.join(sessions, "plain.jsonl"), jsonl);
    const preload = path.join(home, "no-zstd.cjs");
    fs.writeFileSync(preload, `
      const zlib = require('node:zlib');
      zlib.zstdDecompressSync = undefined;
      const fs = require('node:fs');
      const open = fs.openSync;
      fs.openSync = (file, ...args) => {
        if (String(file).endsWith('.zst')) throw new Error('Compressed file must not be read');
        return open(file, ...args);
      };
      require('node:module').syncBuiltinESMExports();
    `);
    const env = { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };
    const result = run(["--project", "/tmp/compressed-project", "--source", "codex", "--worklog-json"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "warning: 1 compressed Codex logs were skipped; reading *.jsonl.zst needs Node >= 22.15\n");
    const doctor = run(["doctor", "--json"], env);
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.equal(doctor.stderr, "");
    const report = JSON.parse(doctor.stdout);
    assert.deepEqual(report.structure.unsupportedFiles, [{ kind: "*.jsonl.zst", count: 1 }]);
    assert.equal(report.structure.unreadableFiles, 0);
    assert.match(report.warnings.join("\n"), /Node >= 22\.15/);
  });
});

test("compressed metadata preserves first-object handling after malformed lines", zstd, async () => {
  await fixture(({ sessions }) => {
    const file = path.join(sessions, "metadata.jsonl.zst");
    fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from("\nmalformed\nnull\n" + jsonl)));
    assert.equal(findCodexSessionFiles("/tmp/compressed-project", sessions).length, 1);
    assert.equal(loadCodexSessions("/tmp/compressed-project", {}, sessions)[0].events.length, 4);
    const rejected = path.join(sessions, "rejected.jsonl.zst");
    fs.writeFileSync(rejected, zlib.zstdCompressSync(Buffer.from(JSON.stringify(records[1]) + "\n" + jsonl)));
    assert.deepEqual(findCodexSessionFiles("/tmp/compressed-project", sessions).map((meta) => meta.file), [file]);
  });
});
