import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRelayedPrompt, loadSessionEvents, computeRefinedSplit } from "../dist/core.js";
import { loadCodexSessions } from "../dist/sources/codex.js";

const texts = [
  "[orch] Continue with step 2.",
  '  <pasted_content id="8124">\n[orch] New task.\n</pasted_content>',
  '[Image #1]\n\n<pasted_content id="5386">\n[orch] Task.',
];
test("relay prefixes match only the start after whitespace, image and paste wrappers", () => {
  for (const text of texts) assert.equal(isRelayedPrompt(text, ["[orch]"]), true);
  for (const text of ["Continue [orch] now.", "/cmd [orch] Task.", "[other] Task.", "[ORCH] Task."]) {
    assert.equal(isRelayedPrompt(text, ["[orch]"]), false);
  }
  assert.equal(isRelayedPrompt(texts[0], []), false);
});

test("Claude relays become work without presence or mid-turn evidence and contribute no attention", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-relay-"));
  try {
    const file = path.join(dir, "session.jsonl");
    const records = [
      ...texts.map((content) => ({ type: "user", promptSource: "typed", message: { role: "user", content } })),
      { type: "user", promptSource: "typed", message: { role: "user", content: [{ type: "image" }, { type: "text", text: "[orch] Task." }, { type: "text", text: "Continue." }] } },
      { type: "queue-operation", operation: "enqueue", content: "[orch] STOP." },
    ].map((record, index) => ({ ...record, timestamp: new Date(Date.UTC(2026, 5, 1, 10, index)).toISOString() }));
    fs.writeFileSync(file, records.map(JSON.stringify).join("\n"));
    const relayed = loadSessionEvents(file, { relayPrefixes: ["[orch]"] });
    assert.equal(relayed.length, records.length);
    assert.ok(relayed.every((event) => event.kind === "work" && event.presence === false && event.relayed === true && event.midTurn === undefined));
    const baseline = loadSessionEvents(file);
    assert.ok(baseline.every((event) => event.kind === "prompt" && event.presence && !event.relayed));
    const options = { capMinutes: 10, promptCapMinutes: 10 };
    assert.equal(computeRefinedSplit(relayed, options).attentionMinutes, 0);
    assert.equal(computeRefinedSplit(relayed, options).promptCount, 0);
    assert.ok(computeRefinedSplit(baseline, options).attentionMinutes > 0);
    assert.ok(computeRefinedSplit(baseline, options).promptCount > 0);
    fs.writeFileSync(file, JSON.stringify({ type: "user", timestamp: records[0].timestamp,
      toolUseResult: { questions: [], answers: { answer: "[orch] Reply." } },
      message: { content: [{ type: "tool_result", content: "[orch] Reply." }] } }));
    for (const relayPrefixes of [["[orch]"], [""]]) {
      assert.equal(loadSessionEvents(file, { relayPrefixes })[0].kind, "prompt");
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Codex relay user messages become work without presence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-relay-codex-"));
  try {
    const timestamp = "2026-06-01T10:00:00Z";
    fs.writeFileSync(path.join(dir, "session.jsonl"), [
      { type: "session_meta", timestamp, payload: { id: "relay", cwd: "/tmp/relay-project", source: "cli" } },
      { type: "response_item", timestamp, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "[orch] Continue." }] } },
    ].map(JSON.stringify).join("\n"));
    const event = loadCodexSessions("/tmp/relay-project", { relayPrefixes: ["[orch]"] }, dir)[0].events.at(-1);
    assert.equal(event.kind, "work");
    assert.equal(event.presence, false);
    assert.equal(event.relayed, true);
    assert.equal(loadCodexSessions("/tmp/relay-project", {}, dir)[0].events.at(-1).kind, "prompt");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
