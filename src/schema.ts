/** Schema canary baseline. Tuple slots are kept even when metadata is absent.
 * Seeded from the bounded real-log canary on 2026-10-05 (400 MB), plus
 * adapter branches. Bookkeeping is recognized, not necessarily excluded.
 */
export function schemaKind(record: Record<string, unknown>, source: "claude" | "codex"): string {
  const payload = (record["payload"] ?? {}) as Record<string, unknown>;
  const item = payload["item"] as Record<string, unknown> | undefined;
  const attachment = record["attachment"] as Record<string, unknown> | undefined;
  const parts = source === "claude"
    ? [record["type"], record["subtype"], attachment?.["type"], record["promptSource"]]
    : [record["type"], payload["type"], item?.["type"]];
  return parts.map((part) => typeof part === "string" ? part : "").join("|");
}

/** Object-valued sources are identified by shape, never by embedded IDs. */
export function schemaValue(value: unknown): string {
  if (value === undefined) return "(missing)";
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return Object.keys(value).sort().map((key) => {
    const nested = (value as Record<string, unknown>)[key];
    return key + (nested && typeof nested === "object" ? "." + Object.keys(nested).sort().join(".") : "");
  }).join("|");
  return typeof value;
}

export const KNOWN_CLAUDE_KINDS = new Set([
  // Handled: specific adapter branches (including explicit nonhuman input).
  "assistant|||",
  "attachment||edited_text_file|",
  "queue-operation|||",
  "system|away_summary||",
  "user|||",
  "user|||hook",
  "user|||queued",
  "user|||sdk",
  "user|||suggestion_accepted",
  "user|||system",
  "user|||typed",
  // Bookkeeping: observed by the 2026-10-05 canary; ordinary work or untimed metadata.
  "agent-name|||",
  "ai-title|||",
  "artifact-autoreact-ledger|||",
  "artifact-comment-monitor|||",
  "atis-latch|||",
  "attachment||agent_listing_delta|",
  "attachment||auto_mode|",
  "attachment||bash_output_audience_note|",
  "attachment||batching_reminder_sent|",
  "attachment||command_permissions|",
  "attachment||compact_file_reference|",
  "attachment||credential_org|",
  "attachment||date_change|",
  "attachment||date|",
  "attachment||deferred_tools_delta|",
  "attachment||deferred_tools_record|",
  "attachment||dynamic_skill|",
  "attachment||environment|",
  "attachment||file|",
  "attachment||goal_status|",
  "attachment||hook_additional_context|",
  "attachment||hook_blocking_error|",
  "attachment||hook_success|",
  "attachment||hook_system_message|",
  "attachment||inlined_image_paths|",
  "attachment||instructions|",
  "attachment||invoked_skills|",
  "attachment||language|",
  "attachment||mcp_instructions_delta|",
  "attachment||model|",
  "attachment||nested_memory|",
  "attachment||output_style_instructions|",
  "attachment||output_style|",
  "attachment||prompt_snapshot|",
  "attachment||queued_command|",
  "attachment||read_truncation_notice|",
  "attachment||remote_session_change|",
  "attachment||session_context|",
  "attachment||silent_turn_reminder|",
  "attachment||skill_listing|",
  "attachment||skill_mention|",
  "attachment||task_reminder|",
  "attachment||task_status|",
  "attachment||thinking_drop|",
  "attachment||total_tokens_reminder|",
  "bridge-session|||",
  "cost-state|||",
  "custom-title|||",
  "file-history-delta|||",
  "file-history-snapshot|||",
  "frame-link|||",
  "last-prompt|||",
  "mode|||",
  "permission-mode|||",
  "pr-link|||",
  "system|bridge_status||",
  "system|compact_boundary||",
  "system|informational||",
  "system|local_command||",
  "system|scheduled_task_fire||", // Scheduled-task trigger; machine bookkeeping.
  "system|stop_hook_summary||",
  "system|turn_duration||",
  // Seen on 2026-10-05 with full sampling; bookkeeping next to agent activity.
  "attachment||max_turns_reached|",
  "attachment||plan_mode|",
  "attachment||structured_output|",
  "system|api_error||",
]);

export const KNOWN_CODEX_KINDS = new Set([
  // Handled: specific adapter branches (including explicit nonhuman input).
  "event_msg|item_completed|AgentMessage",
  "event_msg|item_completed|CommandExecution",
  "event_msg|item_completed|FileChange",
  "event_msg|thread_settings_applied|",
  "realtime_item|transcript_segment|",
  "response_item|custom_tool_call|",
  "response_item|function_call|",
  "response_item|message|",
  "session_meta||",
  // Bookkeeping: observed by the 2026-10-05 canary; ordinary work or untimed metadata.
  "compacted||",
  "event_msg|item_completed|CollabAgentToolCall",
  "event_msg|item_completed|ContextCompaction",
  "event_msg|item_completed|Extension",
  "event_msg|item_completed|ImageView",
  "event_msg|item_completed|McpToolCall",
  "event_msg|item_completed|Reasoning",
  "event_msg|item_completed|SubAgentActivity",
  "event_msg|item_completed|UserMessage",
  "event_msg|task_complete|",
  "event_msg|task_started|",
  "event_msg|token_count|",
  "event_msg|turn_aborted|",
  "inter_agent_communication_metadata||",
  "realtime_item|bem_item_promoted|",
  "realtime_item|realtime_session_closed|",
  "realtime_item|realtime_session_started|",
  "response_item|agent_message|",
  "response_item|compaction|",
  "response_item|custom_tool_call_output|",
  "response_item|function_call_output|",
  "response_item|reasoning|",
  "token_usage_record||",
  "turn_context||",
  "world_state||",
]);

// Handled human and nonhuman prompt sources; observed: typed, system, queued.
export const KNOWN_PROMPT_SOURCES = new Set(["typed", "suggestion_accepted", "system", "queued", "sdk", "hook"]);
// Handled session routing plus observed bookkeeping originators and source shapes.
export const KNOWN_ORIGINATORS = new Set(["(missing)", "Claude Code", "codex_exec", "Codex Desktop", "codex-tui",
  "codex_work_desktop", // Human desktop front-end.
  "codex_cli_rs", // Codex CLI front-end used interactively.
]);
export const KNOWN_CODEX_SOURCES = new Set(["(missing)", "cli", "exec", "mcp", "vscode", "subagent", "subagent.spawn", "subagent.other",
  "subagent.thread_spawn", // Subagent; already treated as machine by classifyCodexSessionMeta.
]);
