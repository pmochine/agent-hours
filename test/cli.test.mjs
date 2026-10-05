import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, "dist", "cli.js");
const CODEX_HOME = path.join(ROOT, "test", "fixtures", "codex-current");

function run(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME, ...env },
  });
}

test("CLI worklog respects --source codex and includes Codex evidence", () => {
  const result = run([
    "--project",
    "/tmp/proj-current",
    "--source",
    "codex",
    "--worklog-json",
    "--timezone",
    "UTC",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  const prompts = out.hours.flatMap((h) => h.prompts);
  assert.deepEqual(prompts.sort(), ["fix the current bug", "review archived work"]);
  assert.ok(out.hours.flatMap((h) => h.filesEdited).some((f) => f.endsWith("src/helper.ts")));
});

test("CLI --all-projects honors a Codex-only source and scans archives", () => {
  const result = run(["--all-projects", "--source", "codex", "--json", "--timezone", "UTC"]);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.source, "codex");
  assert.ok(out.projects.some((p) => p.project === "/tmp/proj-current"));
  assert.ok(out.projects.some((p) => p.events > 0));
  assert.ok(out.totalHours >= 0);
});

test("CLI CSV headers default to English and preserve localized headers and data", () => {
  const base = ["--project", "/tmp/proj-current", "--source", "codex", "--timezone", "UTC", "--csv"];
  // Encode localized words to keep tracked test text in English.
  const cases = [
    [[], "Date;Duration (h);Duration (h:mm)", "\u0044\u0061\u0074\u0075\u006d;\u0044\u0061\u0075\u0065\u0072 (h);\u0044\u0061\u0075\u0065\u0072 (\u0053\u0074\u0075\u006e\u0064\u0065\u006e:\u004d\u0069\u006e\u0075\u0074\u0065\u006e)"],
    [["--split"], "Date;Duration (h);Duration (h:mm);Direct interaction (h);Supervised (h);Human attention (h);AI autonomous (h)", "\u0044\u0061\u0074\u0075\u006d;\u0044\u0061\u0075\u0065\u0072 (h);\u0044\u0061\u0075\u0065\u0072 (\u0053\u0074\u0075\u006e\u0064\u0065\u006e:\u004d\u0069\u006e\u0075\u0074\u0065\u006e);Direct interaction (h);Supervised (h);\u004d\u0065\u006e\u0073\u0063\u0068 \u0067\u0065\u0073\u0061\u006d\u0074 (h);AI-solo (h)"],
    [["--worklog", "--by-day"], "Date;Active (h);Direct interaction (h);Supervised (h);AI (h);Description", "\u0044\u0061\u0074\u0075\u006d;\u0041\u006b\u0074\u0069\u0076 (h);Direct interaction (h);Supervised (h);AI (h);\u0042\u0065\u0073\u0063\u0068\u0072\u0065\u0069\u0062\u0075\u006e\u0067"],
    [["--worklog"], "Date;Hour;Active (min);Direct interaction (min);Supervised (min);AI (min);Description", "\u0044\u0061\u0074\u0075\u006d;\u0053\u0074\u0075\u006e\u0064\u0065;\u0041\u006b\u0074\u0069\u0076 (min);Direct interaction (min);Supervised (min);AI (min);\u0042\u0065\u0073\u0063\u0068\u0072\u0065\u0069\u0062\u0075\u006e\u0067"],
  ];
  for (const [flags, englishHeader, localizedHeader] of cases) {
    const english = run([...base, ...flags]);
    const explicitEnglish = run([...base, ...flags, "--lang", "en"]);
    const localized = run([...base, ...flags, "--lang", "de"]);
    assert.equal(english.status, 0, english.stderr);
    assert.equal(explicitEnglish.status, 0, explicitEnglish.stderr);
    assert.equal(localized.status, 0, localized.stderr);
    assert.equal(explicitEnglish.stdout, english.stdout);
    const englishLines = english.stdout.trimEnd().split("\n");
    const localizedLines = localized.stdout.trimEnd().split("\n");
    assert.equal(englishLines[0], englishHeader);
    assert.equal(localizedLines[0], localizedHeader);
    if (flags.includes("--worklog")) {
      assert.match(englishLines.at(-1), /^TOTAL;/);
      assert.ok(localizedLines.at(-1).startsWith("\u0047\u0045\u0053\u0041\u004d\u0054;"));
      localizedLines[localizedLines.length - 1] = localizedLines.at(-1).replace(/^[^;]+/, "TOTAL");
    }
    assert.deepEqual(localizedLines.slice(1), englishLines.slice(1));
  }
});

test("CLI rejects an unsupported CSV language", () => {
  const result = run(["--lang", "fr"]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "--lang must be en or de.\n");
});

function withClaudeStub(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-claude-stub-"));
  const capture = path.join(dir, "capture.json");
  // A private PATH contains only Node and the stub, never the real claude executable.
  fs.symlinkSync(process.execPath, path.join(dir, "node"));
  fs.writeFileSync(path.join(dir, "claude"), `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const buckets = JSON.parse(input);
  fs.writeFileSync(process.env.STUB_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), buckets }));
  if (process.env.STUB_MODE === "exit") process.exit(2);
  if (process.env.STUB_MODE === "invalid-json") return process.stdout.write("not JSON");
  if (process.env.STUB_MODE === "null") return process.stdout.write("null");
  if (process.env.STUB_MODE === "array") return process.stdout.write("[]");
  const result = { [buckets[0].key]: process.env.STUB_TEXT || "Reviewed layout.", OVERALL: "Period reviewed.", UNKNOWN: "Ignore this summary.", ["__proto__"]: "Ignore this too." };
  if (buckets[1]) result[buckets[1].key] = { invalid: "Ignore non-string values." };
  process.stdout.write(JSON.stringify(result));
});
`, { mode: 0o755 });
  try {
    callback({ PATH: dir, STUB_CAPTURE: capture }, capture);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SUMMARY_ARGS = ["--project", "/tmp/proj-current", "--source", "codex", "--timezone", "UTC", "--worklog", "--csv"];

test("CLI summarizes with isolated claude flags and accepts only known JSON string values", () => {
  withClaudeStub((env, capture) => {
    const baseline = run(SUMMARY_ARGS);
    const result = run([...SUMMARY_ARGS, "--summarize"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const call = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.equal(call.args[0], "-p");
    assert.match(call.args[1], /JSON object/);
    assert.deepEqual(call.args.slice(2), ["--tools", "", "--strict-mcp-config", "--no-session-persistence"]);
    assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(os.tmpdir()));
    assert.ok(call.buckets.length >= 2);
    assert.match(result.stdout, /;Reviewed layout\./);
    assert.match(result.stdout, /;Period reviewed\./);
    assert.doesNotMatch(result.stdout, /Ignore|invalid|UNKNOWN/);
    const baselineRows = baseline.stdout.trimEnd().split("\n");
    const rows = result.stdout.trimEnd().split("\n");
    assert.equal(rows[2], baselineRows[2]); // non-string value falls back for this bucket
    assert.deepEqual(rows.map((row) => row.split(";").slice(0, 6)), baselineRows.map((row) => row.split(";").slice(0, 6)));
  });
});

test("CLI summarize failures warn and retain rule-based output", () => {
  withClaudeStub((env) => {
    const baseline = run(SUMMARY_ARGS);
    for (const mode of ["exit", "invalid-json", "null", "array", "missing"]) {
      const result = run([...SUMMARY_ARGS, "--summarize"], {
        ...env,
        STUB_MODE: mode,
        ...(mode === "missing" ? { PATH: path.join(env.PATH, "missing") } : {}),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /^Warning: --summarize failed; using rule-based descriptions\./);
      assert.equal(result.stdout, baseline.stdout);
    }
  });
});

test("CLI CSV protects formula-leading descriptions without changing numeric cells", () => {
  withClaudeStub((env) => {
    for (const text of ["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1", '=SUM(1;"2")']) {
      for (const flags of [[], ["--by-day"]]) {
        const baseline = run([...SUMMARY_ARGS, ...flags]);
        const result = run([...SUMMARY_ARGS, ...flags, "--summarize"], { ...env, STUB_TEXT: text });
        assert.equal(result.status, 0, result.stderr);
        const row = result.stdout.split("\n")[1];
        const baselineRow = baseline.stdout.split("\n")[1];
        const prefix = baselineRow.split(";").slice(0, flags.length ? 5 : 6).join(";") + ";";
        const safe = "'" + text;
        const quoted = /[;"\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
        assert.ok(row.startsWith(prefix + quoted), row);
        // Numeric cells retain their original unprefixed representation.
        assert.equal(row.slice(0, prefix.length), prefix);
      }
    }
  });
});
