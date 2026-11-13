import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assignClient } from "../dist/clients.js";
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
    assert.deepEqual(loadConfig(), { relayPrefixes: [], clients: {} });
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
    fs.writeFileSync(file, "{}");
    assert.deepEqual(loadConfig(file), { relayPrefixes: [], clients: {} });
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("config validates client definitions and canonicalizes paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-clients-config-"));
  const file = path.join(dir, "config.json");
  const write = (clients) => fs.writeFileSync(file, JSON.stringify({ clients }));
  try {
    const badClient = (client) => ({ acme: client });
    for (const [clients, message] of [
      ...[null, 1, [], "clients"].map((value) => [value, /clients must be an object/]),
      [{ "": { projects: ["/tmp/acme"] } }, /names must be non-empty/],
      [{ " ": { projects: ["/tmp/acme"] } }, /names must be non-empty/],
      ...[null, true, [], "acme"].map((value) => [badClient(value), /each client must be an object/]),
      [badClient({ projects: ["/tmp/acme"], extra: true }), /unknown client key/],
      ...[null, 1, "false"].map((billable) => [badClient({ projects: ["/tmp/acme"], billable }), /billable must be a boolean/]),
      ...[undefined, null, [], "path", {}].map((projects) => [badClient({ projects }), /projects must be a non-empty array/]),
      ...[null, false, 1, []].map((entry) => [badClient({ projects: [entry] }), /project must be a path string or object/]),
      [badClient({ projects: [{ path: "/tmp/acme", extra: true }] }), /unknown project key/],
      ...[null, 1, "true"].map((descendants) => [badClient({ projects: [{ path: "/tmp/acme", descendants }] }), /descendants must be a boolean/]),
      ...[{}, { path: null }, { path: 1 }, { path: "" }, ""].map((entry) => [badClient({ projects: [entry] }), /path must be a non-empty string/]),
      ...["relative", "~someone/code"].map((entry) => [badClient({ projects: [entry] }), /path must be absolute/]),
      [badClient({ projects: ["/tmp/acme", "/tmp/acme/../acme"] }), /duplicate.*"acme" and "acme"/],
      [{ acme: { projects: ["/tmp/acme"] }, globex: { projects: ["/tmp/acme"] } }, /duplicate.*"acme" and "globex"/],
    ]) {
      write(clients);
      assert.throws(() => loadConfig(file), message);
    }
    const unicode = path.join(fs.realpathSync(dir), "caf\u00e9");
    fs.mkdirSync(unicode);
    const alias = path.join(dir, "alias");
    fs.symlinkSync(unicode, alias);
    write({ acme: { projects: ["~/code/acme", { path: unicode.normalize("NFD"), descendants: false }] }, own: { billable: false, projects: ["~"] } });
    const config = loadConfig(file);
    assert.deepEqual(config.clients, {
      acme: { billable: true, projects: [{ path: path.join(os.homedir(), "code/acme").normalize("NFC"), descendants: true }, { path: unicode, descendants: false }] },
      own: { billable: false, projects: [{ path: fs.realpathSync(os.homedir()).normalize("NFC"), descendants: true }] },
    });
    write({ acme: { projects: [unicode] }, globex: { projects: [alias] } });
    assert.throws(() => loadConfig(file), /duplicate.*"acme" and "globex"/);
    write({ acme: { projects: [unicode.normalize("NFD")] } });
    assert.equal(assignClient(unicode, loadConfig(file).clients), "acme");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
