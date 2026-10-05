/** File edit extraction shared by timelines and worklogs. */
import * as path from "node:path";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function normalizeEditedPath(file: string, cwd: string): string {
  return path.resolve(cwd, file).normalize("NFC");
}

export function parseArguments(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function agentEditedFiles(record: Record<string, unknown>, source: "claude" | "codex"): string[] {
  const files = new Set<string>();
  if (source === "claude" && record["type"] === "assistant") {
    const message = record["message"] as Record<string, unknown> | undefined;
    const content = message?.["content"];
    if (Array.isArray(content)) for (const item of content) {
      const input = item?.input;
      if (item?.type === "tool_use" && EDIT_TOOLS.has(item.name) && typeof input?.file_path === "string") {
        files.add(input.file_path);
      }
    }
  }
  if (source === "codex") {
    const payload = (record["payload"] ?? {}) as Record<string, unknown>;
    const item = (payload["item"] ?? {}) as Record<string, unknown>;
    if (record["type"] === "event_msg" && payload["type"] === "item_completed" && item["type"] === "FileChange") {
      const changes = item["changes"];
      if (changes && typeof changes === "object" && !Array.isArray(changes)) {
        for (const file of Object.keys(changes)) files.add(file);
      }
    }
    if (record["type"] === "response_item" &&
        (payload["type"] === "function_call" || payload["type"] === "custom_tool_call") && payload["name"] === "apply_patch") {
      const raw = payload["arguments"] ?? payload["input"];
      const args = parseArguments(raw);
      const patch = (args && (args["patch"] ?? args["input"])) ?? (typeof raw === "string" && !args ? raw : null);
      if (typeof patch === "string") for (const line of patch.split("\n")) {
        const match = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s+(.+?)\s*$/);
        if (match) files.add(match[1]);
      }
    }
  }
  return [...files];
}
