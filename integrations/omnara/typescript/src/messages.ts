import type { Message, ToolMessage } from "@ag-ui/core";
import type { AgentEvent } from "./api";

/**
 * One mapping from Omnara's log to AG-UI messages, shared by live streaming and
 * the end-of-request snapshot, so the ids always match and the snapshot
 * replaces what was streamed instead of duplicating it.
 *
 * - assistant message: the model call id (`mcc_...`)
 * - reasoning message: `<model call id>:block:<index>`
 * - tool call: Omnara's tool-call id
 * - tool message: the tool result's event id
 * - user message: the client's id (from the `agui:<id>` input key), or
 *   Omnara's input id for messages from anyone else (see `Author`)
 */

export const INPUT_KEY_PREFIX = "agui:";

export const reasoningId = (modelCallId: string, index: number) =>
  `${modelCallId}:block:${index}`;

type Blocks = ReadonlyArray<{
  type: string;
  text?: string;
  metadata?: Record<string, unknown>;
}>;

const hidden = (block: { metadata?: Record<string, unknown> }) =>
  block.metadata?.omnara_hidden === "true";

/** The visible text of a set of content blocks. */
export function visibleText(blocks: Blocks): string {
  return blocks
    .filter((b) => b.type === "text" && !hidden(b))
    .map((b) => b.text ?? "")
    .join("");
}

/**
 * Where a file was. Omnara files (artifacts) can only be downloaded with the
 * API key, so the chat can't show them; it gets a marker in their place.
 */
const FILE_MARKER = "[file]";

/** A message's visible text, with a marker for each attached file. */
export function inputText(
  blocks: ReadonlyArray<{
    type: string;
    text?: string;
    metadata?: Record<string, unknown>;
  }>,
): string {
  return blocks
    .flatMap((b) => {
      if (b.type === "text") return hidden(b) ? [] : [b.text ?? ""];
      return b.type === "media_ref" ? [FILE_MARKER] : [];
    })
    .join("\n");
}

/** A tool result as text: text as is, structured data as JSON, a marker for each file. */
export function toolResultText(
  blocks: ReadonlyArray<{
    type: string;
    text?: string;
    value?: unknown;
    artifact_id?: string;
  }>,
): string {
  return blocks
    .map((b) => {
      if (b.type === "text") return b.text ?? "";
      if (b.type === "structured_data") return JSON.stringify(b.value);
      if (b.type === "media_ref") return FILE_MARKER;
      return "";
    })
    .join("\n");
}

/** The client message id behind an input key, if the input came from this adapter. */
export function clientIdOf(event: AgentEvent): string | undefined {
  if (event.event_kind !== "agent_input") return undefined;
  const key = event.input_idempotency_key;
  return key?.startsWith(INPUT_KEY_PREFIX)
    ? key.slice(INPUT_KEY_PREFIX.length)
    : undefined;
}

/**
 * Who wrote an input that did not come from this adapter, in AG-UI's terms: a
 * subagent's report is the agent's side (as LangGraph and ADK show subagent
 * output by default), anyone else is a user. `name` is AG-UI's sender name.
 */
export type Author = { role: "user" | "assistant"; name?: string };

interface SnapshotContext {
  /** The client's messages to keep (usually what it sent this request). */
  clientMessages: Message[];
  /** Browser-tool calls: their results come only from the client. */
  isBrowserCall: (name: string, type: string) => boolean;
  /** Author of each other-writer input, by actor id. */
  authors: ReadonlyMap<string, Author>;
}

/**
 * The messages to restate at the end of a request: Omnara's log from the
 * oldest message the chat holds onward. The user's own messages and
 * browser-tool results are the client's copies; the agent's messages come
 * from the log, which drops partial replies left by failed previews.
 */
export function snapshotMessages(
  events: AgentEvent[],
  ctx: SnapshotContext,
): Message[] {
  const held = new Map(ctx.clientMessages.map((m) => [m.id, m]));
  const clientResults = new Map(
    ctx.clientMessages
      .filter((m): m is ToolMessage => m.role === "tool")
      .map((m) => [m.toolCallId, m]),
  );

  const calls = new Map<string, { name: string; type: string }>();
  const cancelledBrowserCalls = new Set<string>();
  for (const e of events) {
    if (e.event_kind === "model_output") {
      for (const b of e.content_blocks) {
        if (b.type === "tool_call")
          calls.set(b.tool_call_id, { name: b.name, type: b.tool_type });
      }
    }
  }
  const isBrowserCall = (id: string) => {
    const call = calls.get(id);
    return call !== undefined && ctx.isBrowserCall(call.name, call.type);
  };
  for (const e of events) {
    if (
      e.event_kind === "tool_result" &&
      e.outcome === "canceled" &&
      isBrowserCall(e.tool_call_id) &&
      !clientResults.has(e.tool_call_id)
    ) {
      cancelledBrowserCalls.add(e.tool_call_id);
    }
  }

  const out: Message[] = [];
  for (const e of events) {
    if (e.event_kind === "agent_input") {
      if (e.input_kind !== "content") continue;
      const clientId = clientIdOf(e);
      if (clientId !== undefined) {
        out.push(
          held.get(clientId) ?? {
            id: clientId,
            role: "user",
            content: inputText(e.content_blocks),
          },
        );
        continue;
      }
      const text = inputText(e.content_blocks);
      if (!text) continue;
      const author = (e.actor_id && ctx.authors.get(e.actor_id)) || {
        role: "user" as const,
      };
      out.push({
        id: e.agent_input_id,
        role: author.role,
        content: text,
        ...(author.name ? { name: author.name } : {}),
      });
    } else if (e.event_kind === "model_output") {
      e.content_blocks.forEach((b, i) => {
        if (b.type === "reasoning" && b.text) {
          out.push({
            id: reasoningId(e.model_call_context_id, i),
            role: "reasoning",
            content: b.text,
          });
        }
      });
      const text = visibleText(e.content_blocks);
      const toolCalls = e.content_blocks.flatMap((b) =>
        b.type === "tool_call" && !cancelledBrowserCalls.has(b.tool_call_id)
          ? [
              {
                id: b.tool_call_id,
                type: "function" as const,
                function: {
                  name: b.name,
                  arguments: JSON.stringify(b.input ?? {}),
                },
              },
            ]
          : [],
      );
      if (!text && toolCalls.length === 0) continue;
      out.push({
        id: e.model_call_context_id,
        role: "assistant",
        ...(text ? { content: text } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
      });
    } else if (e.event_kind === "tool_result") {
      // The page's copy of its own (browser) results; the log's for the rest.
      const own = isBrowserCall(e.tool_call_id)
        ? clientResults.get(e.tool_call_id)
        : undefined;
      if (own) out.push(own);
      else if (!cancelledBrowserCalls.has(e.tool_call_id)) {
        out.push({
          id: e.id,
          role: "tool",
          toolCallId: e.tool_call_id,
          content: toolResultText(e.content_blocks),
        });
      }
    }
  }

  // Start at the oldest message the chat holds: history it lacks (after a
  // server restart, say) would land below the new message, so it stays out.
  // An empty chat gets all of it.
  const anchor = out.findIndex((m) => held.has(m.id));
  const kept = anchor >= 0 ? out.slice(anchor) : held.size ? [] : out;

  // The page's own messages the log doesn't have yet stay where they are: a
  // message not delivered yet, a browser tool's result. Anything else the log
  // doesn't have (a preview from a failed model call, say) goes.
  const ids = new Set(kept.map((m) => m.id));
  for (const m of ctx.clientMessages) {
    if (ids.has(m.id)) continue;
    if (m.role === "user" || (m.role === "tool" && isBrowserCall(m.toolCallId)))
      kept.push(m);
  }
  return kept;
}
