import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfigPath, loadConfig } from "../dist/config.js";

test("config resolves XDG or home defaults and tolerates only a missing default file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-config-"));
  const previous = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = "";
    assert.equal(defaultConfigPath(), path.join(os.homedir(), ".config/agent-hours/config.json"));
    delete process.env.XDG_CONFIG_HOME;
    assert.equal(defaultConfigPath(), path.join(os.homedir(), ".config/agent-hours/config.json"));
    process.env.XDG_CONFIG_HOME = dir;
    const file = path.join(dir, "agent-hours/config.json");
    assert.equal(defaultConfigPath(), file);
    assert.deepEqual(loadConfig(), { relayPrefixes: [] });
    assert.throws(() => loadConfig(file), (error) => error.message.includes(file) && /cannot read file/.test(error.message));
    fs.mkdirSync(path.dirname(file));
    for (const [value, problem] of [
      ["{", /invalid JSON/], ["null", /root must be an object/], ["[]", /root must be an object/],
      ['{"other":true}', /unknown top-level key/],
      ...[null, "prefix", [""], [1], {}].map((relayPrefixes) => [JSON.stringify({ relayPrefixes }), /relayPrefixes must be an array of non-empty strings/]),
    ]) {
      fs.writeFileSync(file, value);
      assert.throws(() => loadConfig(), (error) => error.message.includes(file) && problem.test(error.message));
    }
    for (const clients of [null, 1, ["reserved"], { future: true }]) {
      const config = { relayPrefixes: ["[orch]"], clients };
      fs.writeFileSync(file, JSON.stringify(config));
      assert.deepEqual(loadConfig(file), config);
    }
    fs.writeFileSync(file, "{}");
    assert.deepEqual(loadConfig(file), { relayPrefixes: [] });
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
