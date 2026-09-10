import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, "dist", "cli.js");
const CODEX_HOME = path.join(ROOT, "test", "fixtures", "codex-current");

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME },
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
