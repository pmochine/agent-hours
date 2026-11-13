/** Local configuration shared by timing reports and diagnostics. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface AgentHoursConfig {
  relayPrefixes: string[];
  clients?: unknown;
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
    if (explicitPath === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") return { relayPrefixes: [] };
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
  return { relayPrefixes: prefixes, ...("clients" in config ? { clients: config["clients"] } : {}) };
}
