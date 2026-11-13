/** Local configuration shared by timing reports and diagnostics. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { canonicalProjectPath } from "./sources/codex.js";

export interface ClientProject { path: string; descendants: boolean }
export interface ClientConfig { projects: ClientProject[]; billable: boolean }
export type ClientsConfig = Record<string, ClientConfig>;

export interface AgentHoursConfig {
  relayPrefixes: string[];
  clients: ClientsConfig;
}

export function defaultConfigPath(): string {
  return path.join(process.env["XDG_CONFIG_HOME"] || path.join(os.homedir(), ".config"), "agent-hours", "config.json");
}

export function loadConfig(explicitPath?: string): AgentHoursConfig {
  const file = explicitPath ?? defaultConfigPath();
  const problem = (message: string): Error => new Error(`Config ${file}: ${message}`);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (explicitPath === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") return { relayPrefixes: [], clients: {} };
    throw problem(`cannot read file (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`);
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw problem("invalid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw problem("root must be an object");
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (key !== "relayPrefixes" && key !== "clients") throw problem(`unknown top-level key ${JSON.stringify(key)}`);
  }
  const prefixes = "relayPrefixes" in config ? config["relayPrefixes"] : [];
  if (!Array.isArray(prefixes) || prefixes.some((prefix) => typeof prefix !== "string" || prefix.length === 0)) {
    throw problem("relayPrefixes must be an array of non-empty strings");
  }
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const rawClients = "clients" in config ? config["clients"] : {};
  if (!object(rawClients)) throw problem("clients must be an object");
  const clients: ClientsConfig = {};
  const owners = new Map<string, string>();
  for (const [name, value] of Object.entries(rawClients)) {
    if (!name.trim()) throw problem("client names must be non-empty");
    if (!object(value)) throw problem("each client must be an object");
    for (const key of Object.keys(value)) {
      if (key !== "projects" && key !== "billable") throw problem("unknown client key");
    }
    if ("billable" in value && typeof value["billable"] !== "boolean") throw problem("billable must be a boolean");
    const projects = value["projects"];
    if (!Array.isArray(projects) || !projects.length) throw problem("projects must be a non-empty array");
    Object.defineProperty(clients, name, { enumerable: true, value: {
      billable: value["billable"] !== false,
      projects: projects.map((entry): ClientProject => {
        if (typeof entry !== "string" && !object(entry)) throw problem("project must be a path string or object");
        if (object(entry)) {
          for (const key of Object.keys(entry)) {
            if (key !== "path" && key !== "descendants") throw problem("unknown project key");
          }
          if ("descendants" in entry && typeof entry["descendants"] !== "boolean") throw problem("descendants must be a boolean");
        }
        const rawPath = typeof entry === "string" ? entry : entry["path"];
        if (typeof rawPath !== "string" || !rawPath.length) throw problem("project path must be a non-empty string");
        let projectPath: string = rawPath;
        if (projectPath === "~") projectPath = os.homedir();
        else if (projectPath.startsWith("~/")) projectPath = path.join(os.homedir(), projectPath.slice(2));
        if (!path.isAbsolute(projectPath)) throw problem("project path must be absolute after home expansion");
        projectPath = canonicalProjectPath(projectPath);
        const owner = owners.get(projectPath);
        if (owner !== undefined) throw problem(`duplicate project path in clients ${JSON.stringify(owner)} and ${JSON.stringify(name)}`);
        owners.set(projectPath, name);
        return { path: projectPath, descendants: typeof entry === "string" || entry["descendants"] !== false };
      }),
    } });
  }
  return { relayPrefixes: prefixes, clients };
}
