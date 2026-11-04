import type { BetaManagedAgentsEventParams } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { BackendCustomTool, SessionRecord } from "./types";
import { customToolFrom, toolsFingerprint } from "./tools";

export const STATE_TOOL = "ag_ui_update_state";
export const STATE_HEADER = "AG-UI shared state v1\n";
export interface StateCommit {
  version: 1;
  owner: { sessionId: string; sessionThreadId: null };
  revision: number;
  kind: "snapshot";
  state: Record<string, unknown>;
}
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
function validate(value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach(validate);
    return;
  }
  if (!object(value)) throw new Error("State must contain JSON values only.");
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key))
      throw new Error("Unsafe state key.");
    validate(item);
  }
}
const same = (a: unknown, b: unknown) =>
  toolsFingerprint([a]) === toolsFingerprint([b]);
export function stateCommit(
  record: SessionRecord,
  state: unknown,
): StateCommit {
  if (record.sessionThreadId)
    throw new Error("Shared state writes belong to the primary session.");
  if (!object(state)) throw new Error("Shared state must be a JSON object.");
  validate(state);
  if ((record.sharedState?.revision ?? 0) >= Number.MAX_SAFE_INTEGER)
    throw new Error("Shared-state revision exhausted.");
  return {
    version: 1,
    owner: { sessionId: record.sessionId, sessionThreadId: null },
    revision: (record.sharedState?.revision ?? 0) + 1,
    kind: "snapshot",
    state: structuredClone(state),
  };
}
export const stateText = (commit: StateCommit) =>
  STATE_HEADER + JSON.stringify(commit);
export function parseState(
  content: unknown,
  record: SessionRecord,
): StateCommit | undefined {
  if (record.sessionThreadId || !Array.isArray(content)) return;
  const blocks = content.filter(
    (block) =>
      block?.type === "text" &&
      typeof block.text === "string" &&
      block.text.startsWith(STATE_HEADER),
  );
  if (blocks.length !== 1) return;
  const text = blocks[0].text;
  try {
    const c = JSON.parse(text.slice(STATE_HEADER.length));
    if (
      c.version !== 1 ||
      c.kind !== "snapshot" ||
      c.owner?.sessionId !== record.sessionId ||
      c.owner?.sessionThreadId !== null ||
      !Number.isSafeInteger(c.revision) ||
      c.revision < 1 ||
      !object(c.state)
    )
      return;
    validate(c.state);
    return c;
  } catch {
    return;
  }
}
export function acceptState(
  record: SessionRecord,
  commit: StateCommit,
): boolean {
  if (record.sharedState && commit.revision <= record.sharedState.revision)
    return false;
  record.sharedState = commit;
  return true;
}
export function attachState(
  events: BetaManagedAgentsEventParams[],
  input: unknown,
  record: SessionRecord,
) {
  if (
    input === undefined ||
    input === null ||
    record.sessionThreadId ||
    !events.length
  )
    return;
  if (record.sharedState && same(input, record.sharedState.state)) return;
  const commit = stateCommit(record, input);
  // Approval-only requests do not accept system messages. Keep state unchanged until a real companion.
  const results = events.filter(
    (e) => e.type !== "user.message" && e.type !== "system.message",
  );
  const companion = results.length
    ? results.at(-1)!
    : events.findLast((e) => e.type === "user.message");
  if (
    !companion ||
    !["user.message", "user.custom_tool_result", "user.tool_result"].includes(
      companion.type,
    )
  )
    return;
  const next = events[events.indexOf(companion) + 1];
  if (next?.type === "system.message")
    next.content.push({ type: "text", text: stateText(commit) });
  else
    events.splice(events.indexOf(companion) + 1, 0, {
      type: "system.message",
      content: [{ type: "text", text: stateText(commit) }],
    });
  return { commit, withResults: results.length > 0 };
}
function merge(
  target: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = object(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else
      result[key] = object(value)
        ? merge(result[key], value)
        : structuredClone(value);
  }
  return result;
}
export const stateTool = (record: SessionRecord): BackendCustomTool => ({
  name: STATE_TOOL,
  description:
    "Update shared application state. Read the latest AG-UI shared state v1 snapshot. Supply its expectedRevision. replace replaces the whole object; merge_patch recursively merges objects, deletes null members, and replaces arrays.",
  parameters: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["replace", "merge_patch"] },
      expectedRevision: { type: "integer", minimum: 0 },
      state: { type: "object" },
      patch: { type: "object" },
    },
    required: ["operation", "expectedRevision"],
    additionalProperties: false,
  },
  handler(input) {
    if (
      !object(input) ||
      input.expectedRevision !== (record.sharedState?.revision ?? 0)
    )
      throw new Error(
        "Stale or missing expectedRevision; read the latest shared state snapshot.",
      );
    let state: unknown;
    if (input.operation === "replace") state = input.state;
    else if (input.operation === "merge_patch" && object(input.patch)) {
      validate(input.patch);
      if (!record.sharedState && Object.keys(input.patch).length === 0)
        return "Shared state unchanged.";
      state = merge(record.sharedState?.state ?? {}, input.patch);
    } else
      throw new Error("Expected replace with state or merge_patch with patch.");
    if (record.sharedState && same(state, record.sharedState.state))
      return stateText(record.sharedState);
    const commit = stateCommit(record, state);
    return stateText(commit);
  },
});
export const stateToolDefinition = () =>
  customToolFrom(
    stateTool({ sessionId: "", toolNames: [], pendingClientToolUseIds: [] }),
  );

/** Root feed may contain child cross-posts. Resolve native thread ownership before trusting them. */
export async function primaryThread(
  client: import("@anthropic-ai/sdk").default,
  record: SessionRecord,
  signal: AbortSignal,
) {
  if (record.primaryThreadId) return record.primaryThreadId;
  for await (const thread of client.beta.sessions.threads.list(
    record.sessionId,
    {},
    { signal },
  )) {
    if (
      thread.parent_thread_id === null &&
      thread.session_id === record.sessionId
    ) {
      record.primaryThreadId = thread.id;
      return thread.id;
    }
  }
  throw new Error("Native primary thread metadata is unavailable.");
}
export async function restoreStateHistory(
  client: import("@anthropic-ai/sdk").default,
  record: SessionRecord,
  events: readonly import("@anthropic-ai/sdk/resources/beta/sessions/events").BetaManagedAgentsSessionEvent[],
  signal: AbortSignal,
) {
  if (record.sessionThreadId) return;
  // A persisted binding is a cache, never evidence of a native commit.
  delete record.sharedState;
  const calls = new Set<string>();
  for (const event of events) {
    if (
      "session_id" in event &&
      event.session_id !== undefined &&
      event.session_id !== record.sessionId
    )
      continue;
    if (
      event.type !== "system.message" &&
      event.type !== "user.custom_tool_result" &&
      !(event.type === "agent.custom_tool_use" && event.name === STATE_TOOL)
    )
      continue;
    if (event.type === "system.message" && !parseState(event.content, record))
      continue;
    if (
      event.type === "user.custom_tool_result" &&
      (event.is_error !== false || !calls.has(event.custom_tool_use_id))
    )
      continue;
    if (
      "session_thread_id" in event &&
      event.session_thread_id &&
      event.session_thread_id !== (await primaryThread(client, record, signal))
    )
      continue;
    if (event.type === "agent.custom_tool_use") {
      calls.add(event.id);
      continue;
    }
    if (
      event.type === "user.custom_tool_result" &&
      (event.is_error !== false || !calls.has(event.custom_tool_use_id))
    )
      continue;
    const commit = parseState(event.content, record);
    if (commit) acceptState(record, commit);
  }
}
