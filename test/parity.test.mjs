/**
 * Golden-master parity: the same fixtures through the battle-tested Python
 * prototype (reference/prototype-split.py) and the TypeScript port must
 * yield identical numbers. Skipped when python3 is not available.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeSplit, loadProject, mergeEvents } from "../dist/core.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Parity holds for LEGACY-format logs (the prototype predates promptSource,
// queue-operations and subagent folders — the modern fixtures intentionally
// diverge from it, that's the whole point of the upgrade).
const FIXTURES = path.join(ROOT, "test", "fixtures", "legacy");
const PROTOTYPE = path.join(ROOT, "reference", "prototype-split.py");

test("parity with Python prototype on fixtures (cap 10)", (t) => {
  const res = spawnSync("python3", [PROTOTYPE, FIXTURES], { encoding: "utf8" });
  if (res.error || res.status !== 0) {
    t.skip("python3 not available — parity check skipped");
    return;
  }
  const out = res.stdout;
  const py = {
    total: out.match(/Gesamt \(Cap 10\):\s+([\d.]+) h/)?.[1],
    human: out.match(/Mensch-aktiv \(Cap 10\):\s+([\d.]+) h/)?.[1],
    aiSolo: out.match(/AI-solo:\s+([\d.]+) h/)?.[1],
  };
  assert.ok(py.total && py.human && py.aiSolo, `unexpected prototype output:\n${out}`);

  const merged = mergeEvents(loadProject(FIXTURES, 0, Date.parse("2100-01-01T00:00:00Z")));
  const split = computeSplit(merged, 10, 10);
  assert.equal((split.totalMinutes / 60).toFixed(1), py.total);
  assert.equal((split.humanMinutes / 60).toFixed(1), py.human);
  assert.equal(((split.totalMinutes - split.humanMinutes) / 60).toFixed(1), py.aiSolo);
});
