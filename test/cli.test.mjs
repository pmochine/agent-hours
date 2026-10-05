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
