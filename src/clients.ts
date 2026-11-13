/** Client assignment and attention allocation. All values remain unrounded minutes. */
import * as path from "node:path";
import type { ClientsConfig } from "./config.js";
import { computeRefinedSplit, mergeEvents, type NamedSession, type RefinedOptions } from "./core.js";

export interface ClientProjectSessions { project: string; sessions: NamedSession[] }
export interface ClientHour {
  hour: string;
  attentionMinutes: number;
  capFactor: number | null;
  overlapMinutes: number | null;
  billableMinutes: number | null;
  projects: Record<string, number>;
  sharedWith?: Record<string, number>;
}
export interface ClientDay {
  date: string;
  attentionMinutes: number;
  overlapMinutes: number | null;
  billableMinutes: number | null;
}
export interface ClientResult {
  name: string;
  billable: boolean;
  totalMinutes: number;
  aiAutonomousMinutes: number;
  attentionMinutes: number;
  overlapMinutes: number | null;
  billableMinutes: number | null;
  projects: { project: string; attentionMinutes: number }[];
  byDay: ClientDay[];
  byHour: ClientHour[];
}
export const HOURLY_CAP_MINUTES = 60;

/** Inputs are canonical absolute cwd paths; hash-only projects have no assignment. */
export function assignClient(cwd: string, clients: ClientsConfig): string | undefined {
  let owner: string | undefined;
  let longest = -1;
  for (const [name, client] of Object.entries(clients)) {
    for (const entry of client.projects) {
      const prefix = entry.path.endsWith(path.sep) ? entry.path : entry.path + path.sep;
      if ((cwd === entry.path || (entry.descendants && cwd.startsWith(prefix))) && entry.path.length > longest) {
        owner = name;
        longest = entry.path.length;
      }
    }
  }
  return owner;
}

export function computeClients(
  clients: ClientsConfig,
  projects: readonly ClientProjectSessions[],
  options: RefinedOptions,
): { clients: ClientResult[]; unassigned: { project: string; attentionMinutes: number }[] } {
  const groups = new Map<string, ClientProjectSessions[]>();
  const unassigned: { project: string; attentionMinutes: number }[] = [];
  for (const project of projects) {
    // Claude hash-only groups are deliberately ignored in the client view.
    if (!path.isAbsolute(project.project)) continue;
    const owner = assignClient(project.project, clients);
    if (owner === undefined) {
      const split = computeRefinedSplit(mergeEvents(project.sessions), options);
      if (split.attentionMinutes > 0) unassigned.push({ project: project.project, attentionMinutes: split.attentionMinutes });
    } else {
      const group = groups.get(owner) ?? [];
      group.push(project);
      groups.set(owner, group);
    }
  }
  const results: ClientResult[] = Object.entries(clients).map(([name, config]) => {
    const group = groups.get(name) ?? [];
    const split = computeRefinedSplit(mergeEvents(group.flatMap((project) => project.sessions)), options);
    const standalone = group.map((project) => computeRefinedSplit(mergeEvents(project.sessions), options));
    const shares = group.map((project) => ({ project: project.project, attentionMinutes: 0 }));
    const byHour: ClientHour[] = [];
    for (const [hour, state] of [...split.byHour].sort(([a], [b]) => a.localeCompare(b))) {
      const attention = state.handsOn + state.supervised;
      if (attention <= 0) continue;
      let weights = standalone.map((project) => {
        const state = project.byHour.get(hour);
        return state ? state.handsOn + state.supervised : 0;
      });
      let sum = weights.reduce((a, b) => a + b, 0);
      if (sum === 0) {
        weights = standalone.map((project) => project.byHour.get(hour)?.total ?? 0);
        sum = weights.reduce((a, b) => a + b, 0);
      }
      if (sum === 0) { weights = group.map(() => 1); sum = group.length; }
      const hourProjects: Record<string, number> = {};
      weights.forEach((weight, i) => {
        const share = attention * weight / sum;
        hourProjects[group[i].project] = share;
        shares[i].attentionMinutes += share;
      });
      byHour.push({ hour, attentionMinutes: attention, capFactor: null, overlapMinutes: null, billableMinutes: null, projects: hourProjects });
    }
    return {
      name, billable: config.billable, totalMinutes: split.totalMinutes, aiAutonomousMinutes: split.aiAutonomousMinutes,
      attentionMinutes: byHour.reduce((sum, hour) => sum + hour.attentionMinutes, 0),
      overlapMinutes: config.billable ? 0 : null, billableMinutes: config.billable ? 0 : null,
      projects: shares, byDay: [], byHour,
    };
  });
  const billableHours = new Map<string, Map<string, number>>();
  for (const client of results.filter((client) => client.billable)) {
    for (const hour of client.byHour) {
      const peers = billableHours.get(hour.hour) ?? new Map<string, number>();
      peers.set(client.name, hour.attentionMinutes);
      billableHours.set(hour.hour, peers);
    }
  }
  for (const client of results) {
    const days = new Map<string, ClientDay>();
    for (const hour of client.byHour) {
      if (client.billable) {
        const peers = billableHours.get(hour.hour)!;
        const total = [...peers.values()].reduce((a, b) => a + b, 0);
        hour.capFactor = total > HOURLY_CAP_MINUTES ? HOURLY_CAP_MINUTES / total : 1;
        hour.billableMinutes = hour.attentionMinutes * hour.capFactor;
        hour.overlapMinutes = hour.attentionMinutes - hour.billableMinutes;
        if (hour.capFactor < 1) hour.sharedWith = Object.fromEntries([...peers].filter(([name]) => name !== client.name));
        client.billableMinutes! += hour.billableMinutes;
        client.overlapMinutes! += hour.overlapMinutes;
      }
      const date = hour.hour.slice(0, 10);
      const day = days.get(date) ?? { date, attentionMinutes: 0, overlapMinutes: client.billable ? 0 : null, billableMinutes: client.billable ? 0 : null };
      day.attentionMinutes += hour.attentionMinutes;
      if (client.billable) {
        day.overlapMinutes! += hour.overlapMinutes!;
        day.billableMinutes! += hour.billableMinutes!;
      }
      days.set(date, day);
    }
    client.byDay = [...days.values()];
  }
  return { clients: results, unassigned };
}
