import { test } from "node:test";
import assert from "node:assert/strict";
import { assignClient, computeClients } from "../dist/clients.js";

const options = { capMinutes: 10, promptCapMinutes: 10, timeZone: "UTC" };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const client = (paths, billable = true) => ({ billable, projects: paths.map((path) => ({ path, descendants: true })) });
const start = Date.parse("2026-10-01T10:00:00Z");
// Consecutive human prompts give full attention to each interval.
const project = (path, minutes = 40, offset = 0) => ({ project: path, sessions: [{ name: path,
  events: Array.from({ length: minutes / 10 + 1 }, (_, i) => ({ ts: start + (offset + i * 10) * 60000, kind: "prompt", presence: true })),
}] });

test("assignment uses longest canonical path, exact-only entries, and path boundaries", () => {
  const clients = { acme: { billable: true, projects: [{ path: "/w/root", descendants: false }] }, globex: client(["/w/root/shop"]) };
  assert.equal(assignClient("/w/root", clients), "acme");
  assert.equal(assignClient("/w/root/shop/sub", clients), "globex");
  assert.equal(assignClient("/w/root/other", clients), undefined);
  assert.equal(assignClient("/w/root/shopping", clients), undefined);
  clients.acme.projects[0].descendants = true;
  assert.equal(assignClient("/w/root/shop/sub", clients), "globex");
  assert.equal(assignClient("/w/root/other", clients), "acme");
  assert.equal(assignClient("/other", clients), undefined);
});

test("two billable clients share a 60-minute hourly cap and exclude non-billable clients", () => {
  const clients = { acme: client(["/tmp/acme"]), globex: client(["/tmp/globex"]), own: client(["/tmp/own"], false) };
  const data = [project("/tmp/acme"), project("/tmp/globex"), project("/tmp/own")];
  const report = computeClients(clients, data, options);
  for (const result of report.clients.slice(0, 2)) {
    near(result.attentionMinutes, 40);
    near(result.billableMinutes, 30);
    near(result.overlapMinutes, 10);
    near(result.byHour[0].capFactor, 0.75);
    assert.deepEqual(result.byHour[0].sharedWith, { [result.name === "acme" ? "globex" : "acme"]: 40 });
  }
  const own = report.clients[2];
  near(own.attentionMinutes, 40);
  for (const field of ["billableMinutes", "overlapMinutes"]) {
    assert.equal(own[field], null); assert.equal(own.byHour[0][field], null); assert.equal(own.byDay[0][field], null);
  }
  assert.equal(own.byHour[0].capFactor, null);
  assert.equal(own.byHour[0].sharedWith, undefined);
  assert.deepEqual(computeClients(clients, data.slice(0, 2), options).clients.slice(0, 2), report.clients.slice(0, 2));
});

test("cap factors at or below 60 are one; three clients scale proportionally", () => {
  const clients = { acme: client(["/tmp/acme"]), globex: client(["/tmp/globex"]), initech: client(["/tmp/initech"]) };
  for (const minutes of [20, 30]) {
    const report = computeClients(clients, [project("/tmp/acme", minutes), project("/tmp/globex", minutes)], options);
    for (const result of report.clients.slice(0, 2)) {
      near(result.byHour[0].capFactor, 1); near(result.overlapMinutes, 0);
      assert.equal(result.byHour[0].sharedWith, undefined);
    }
  }
  const report = computeClients(clients, [project("/tmp/acme", 20), project("/tmp/globex", 40), project("/tmp/initech", 30)], options);
  report.clients.forEach((result, i) => {
    near(result.byHour[0].capFactor, 2 / 3);
    near(result.billableMinutes, [20, 40, 30][i] * 2 / 3);
  });
  near(report.clients.reduce((sum, result) => sum + result.billableMinutes, 0), 60);
});

test("client union counts overlapping repositories once and allocates project shares by standalone weights", () => {
  const clients = { acme: client(["/tmp/acme"]) };
  const report = computeClients(clients, [project("/tmp/acme/shop", 40), project("/tmp/acme/api", 20)], options);
  const result = report.clients[0];
  near(result.attentionMinutes, 40);
  near(result.projects[0].attentionMinutes, 40 * 2 / 3);
  near(result.projects[1].attentionMinutes, 40 / 3);
  near(Object.values(result.byHour[0].projects).reduce((a, b) => a + b), result.byHour[0].attentionMinutes);
  near(result.projects.reduce((sum, p) => sum + p.attentionMinutes, 0), result.attentionMinutes);
  const identical = computeClients(clients, [project("/tmp/acme/shop"), project("/tmp/acme/api")], options).clients[0];
  near(identical.attentionMinutes, 40);
  identical.projects.forEach((p) => near(p.attentionMinutes, 20));
});

test("daily and range values sum their hours; unassigned excludes zero attention and hash-only groups", () => {
  const clients = { acme: client(["/tmp/acme"]), globex: client(["/tmp/globex"]) };
  const data = [project("/tmp/acme", 40, 40), project("/tmp/globex", 40, 40), project("/tmp/other"), project("legacy-hash"), project("/tmp/zero", 0)];
  data[0].sessions.push(...project("next", 40, 24 * 60).sessions);
  const report = computeClients(clients, data, options);
  assert.deepEqual(report.unassigned, [{ project: "/tmp/other", attentionMinutes: 40 }]);
  for (const result of report.clients) {
    for (const day of result.byDay) {
      for (const key of ["attentionMinutes", "overlapMinutes", "billableMinutes"]) near(day[key], result.byHour.filter((h) => h.hour.startsWith(day.date)).reduce((sum, h) => sum + h[key], 0));
    }
    for (const key of ["attentionMinutes", "overlapMinutes", "billableMinutes"]) near(result[key], result.byDay.reduce((sum, day) => sum + day[key], 0));
  }
});

test("clipped hours and repeated DST hours each retain the fixed 60-minute cap", () => {
  const clients = { acme: client(["/tmp/acme"]), globex: client(["/tmp/globex"]) };
  const report = computeClients(clients, [project("/tmp/acme"), project("/tmp/globex")], { ...options, rangeStartMs: start + 10 * 60000, rangeEndMs: start + 30 * 60000 });
  report.clients.forEach((c) => { near(c.attentionMinutes, 20); near(c.byHour[0].capFactor, 1); });
  const data = [project("/tmp/acme", 120), project("/tmp/globex", 120)];
  data.forEach((p) => p.sessions[0].events.forEach((e, i) => { e.ts = Date.parse("2026-10-25T00:00:00Z") + i * 10 * 60000; }));
  const dst = computeClients(clients, data, { ...options, timeZone: "Europe/Berlin" });
  for (const c of dst.clients) {
    assert.deepEqual(c.byHour.map((h) => h.hour), ["2026-10-25 02:00", "2026-10-25 02:00 (repeated)"]);
    c.byHour.forEach((h) => { near(h.capFactor, 0.5); near(h.billableMinutes, 30); });
  }
});

test("project shares fall back to standalone activity, then equal shares", () => {
  const clients = { acme: client(["/tmp/acme"]) };
  const event = (minute, kind, extra = {}) => ({ ts: start + minute * 60000, kind, presence: kind === "prompt", ...extra });
  const data = [
    { project: "/tmp/acme/a", sessions: [{ name: "a", events: [event(0, "work"), event(10, "prompt")] }] },
    { project: "/tmp/acme/b", sessions: [{ name: "b", events: [event(0, "work", { reactionAnchor: true }), event(10, "work"), event(20, "prompt")] }] },
  ];
  const result = computeClients(clients, data, options).clients[0];
  near(result.attentionMinutes, 10);
  near(result.projects[0].attentionMinutes, 10 / 3);
  near(result.projects[1].attentionMinutes, 20 / 3);
  data[0].sessions[0].events = [event(0, "prompt")];
  data[1].sessions[0].events = [event(10, "prompt", { midTurn: true })];
  const even = computeClients(clients, data, options).clients[0];
  near(even.attentionMinutes, 10);
  even.projects.forEach((p) => near(p.attentionMinutes, 5));
});

test("a parent project without its own sessions remains visible when another client owns the subdirectory", () => {
  const report = computeClients({ a: client(["/w/app"]), b: client(["/w/app/sub"]) }, [project("/w/app/sub")], options);
  assert.deepEqual(report.clients[0].projects, [{ project: "/w/app", attentionMinutes: 0 }]);
  near(report.clients[0].attentionMinutes, 0);
  near(report.clients[1].attentionMinutes, 40);
});
