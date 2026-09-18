import { EventType as E, type BaseEvent, type SubagentStartedEvent } from "@ag-ui/core";
import type { SessionEvent } from "@github/copilot-sdk";

const MAX_OUTPUT_BYTES = 64 * 1024;

interface TextBlock {
  id: string;
  text: string;
  closed: boolean;
  reasoning: boolean;
  subagentRunId?: string;
}

interface ToolBlock {
  id: string;
  name?: string;
  args: string;
  started: boolean;
  ended: boolean;
  completed: boolean;
  subagentRunId?: string;
}

/** Native events raised inside a subagent carry its `agentId`; AG-UI calls it `subagentRunId`. */
type Attributed = { agentId?: string };

export function boundedText(text: string, bytes = MAX_OUTPUT_BYTES): string {
  const encoded = Buffer.from(text);
  if (encoded.length <= bytes) return text;
  // TextDecoder drops a trailing incomplete UTF-8 sequence, never splitting a code point.
  return new TextDecoder().decode(encoded.subarray(0, bytes), { stream: true });
}

/**
 * Stateful projection of one native Copilot SDK session onto AG-UI events.
 *
 * The mapper is retained across frontend-tool handoffs: a run can end while a
 * tool call is still open, and the next run continues the same native session.
 */
export class CopilotEventMapper {
  private readonly seen = new Set<string>();
  private readonly blocks = new Map<string, TextBlock>();
  private readonly tools = new Map<string, ToolBlock>();
  private readonly subagents = new Map<string, SubagentStartedEvent>();
  private suspended = false;

  private block(id: string, reasoning: boolean, out: BaseEvent[], agentId?: string): TextBlock {
    const key = `${reasoning ? "reasoning" : "text"}:${id}`;
    let block = this.blocks.get(key);
    if (!block) {
      block = { id, text: "", closed: false, reasoning, subagentRunId: agentId };
      this.blocks.set(key, block);
      if (reasoning) {
        out.push(this.tag({ type: E.REASONING_START, messageId: id }, agentId));
        out.push(this.tag({ type: E.REASONING_MESSAGE_START, messageId: id, role: "reasoning" }, agentId));
      } else {
        out.push(this.tag({ type: E.TEXT_MESSAGE_START, messageId: id, role: "assistant" }, agentId));
      }
    }
    return block;
  }

  /** Append only the suffix a final event adds beyond what already streamed. */
  private append(block: TextBlock, content: string, out: BaseEvent[], final = false): void {
    if (block.closed) return;
    const delta = final
      ? content.startsWith(block.text)
        ? content.slice(block.text.length)
        : ""
      : content;
    if (!delta) return;
    block.text += delta;
    out.push(
      this.tag(
        { type: block.reasoning ? E.REASONING_MESSAGE_CONTENT : E.TEXT_MESSAGE_CONTENT, messageId: block.id, delta },
        block.subagentRunId,
      ),
    );
  }

  private close(block: TextBlock, out: BaseEvent[]): void {
    if (block.closed) return;
    block.closed = true;
    out.push(
      this.tag(
        { type: block.reasoning ? E.REASONING_MESSAGE_END : E.TEXT_MESSAGE_END, messageId: block.id },
        block.subagentRunId,
      ),
    );
    if (block.reasoning) out.push(this.tag({ type: E.REASONING_END, messageId: block.id }, block.subagentRunId));
  }

  /** The native toolCallId is globally unique and is the browser's correlation key. */
  private tool(id: string, agentId?: string): ToolBlock {
    let tool = this.tools.get(id);
    if (!tool) {
      tool = { id, args: "", started: false, ended: false, completed: false, subagentRunId: agentId };
      this.tools.set(id, tool);
    }
    return tool;
  }

  private tag<T extends BaseEvent>(event: T, subagentRunId?: string): T {
    return subagentRunId ? { ...event, subagentRunId } : event;
  }

  private startToolCall(tool: ToolBlock, out: BaseEvent[]): void {
    if (tool.started || !tool.name) return;
    tool.started = true;
    out.push(
      this.tag({ type: E.TOOL_CALL_START, toolCallId: tool.id, toolCallName: tool.name }, tool.subagentRunId),
    );
  }

  /** Streams an argument fragment; the first fragment opens the call. */
  private streamToolArgs(tool: ToolBlock, delta: string, out: BaseEvent[]): void {
    if (tool.ended) return;
    const started = tool.started;
    tool.args += delta;
    this.startToolCall(tool, out);
    const fragment = started ? delta : tool.args;
    if (tool.started && fragment) {
      out.push(this.tag({ type: E.TOOL_CALL_ARGS, toolCallId: tool.id, delta: fragment }, tool.subagentRunId));
    }
  }

  /**
   * Completes a call once its arguments are final. Providers that streamed the
   * arguments already produced START/ARGS, so only END is added; otherwise the
   * whole call is emitted as a single chunk.
   */
  private emitToolCall(tool: ToolBlock, args: unknown, out: BaseEvent[]): void {
    if (tool.ended || !tool.name) return;
    const streamed = tool.started;
    this.startToolCall(tool, out);
    if (!streamed) {
      tool.args = typeof args === "string" ? args : JSON.stringify(args ?? {});
      if (tool.args) out.push(this.tag({ type: E.TOOL_CALL_ARGS, toolCallId: tool.id, delta: tool.args }, tool.subagentRunId));
    }
    tool.ended = true;
    out.push(this.tag({ type: E.TOOL_CALL_END, toolCallId: tool.id }, tool.subagentRunId));
  }

  mapEvent(event: SessionEvent): BaseEvent[] {
    if (this.seen.has(event.id)) return [];
    this.seen.add(event.id);
    const out: BaseEvent[] = [];
    const agentId = (event as Attributed).agentId;
    switch (event.type) {
      case "assistant.message_start":
        this.block(event.data.messageId, false, out, agentId);
        break;
      case "assistant.message_delta":
        this.append(this.block(event.data.messageId, false, out, agentId), event.data.deltaContent, out);
        break;
      case "assistant.reasoning_delta":
        this.append(this.block(event.data.reasoningId, true, out, agentId), event.data.deltaContent, out);
        break;
      case "assistant.reasoning": {
        const block = this.block(event.data.reasoningId, true, out, agentId);
        this.append(block, event.data.content, out, true);
        this.close(block, out);
        break;
      }
      case "assistant.tool_call_delta": {
        const tool = this.tool(event.data.toolCallId, agentId);
        tool.name ??= event.data.toolName;
        this.streamToolArgs(tool, event.data.inputDelta, out);
        break;
      }
      case "assistant.message": {
        if (event.data.content || this.blocks.has(`text:${event.data.messageId}`)) {
          const block = this.block(event.data.messageId, false, out, agentId);
          this.append(block, event.data.content, out, true);
          this.close(block, out);
        }
        for (const request of event.data.toolRequests ?? []) {
          const tool = this.tool(request.toolCallId, agentId);
          tool.name = request.name;
          this.emitToolCall(tool, request.arguments, out);
        }
        break;
      }
      case "tool.execution_start":
      case "external_tool.requested": {
        const tool = this.tool(event.data.toolCallId, agentId);
        tool.name = event.data.toolName;
        this.emitToolCall(tool, event.data.arguments, out);
        break;
      }
      case "tool.execution_complete": {
        const tool = this.tool(event.data.toolCallId, agentId);
        if (tool.completed) break;
        tool.completed = true;
        const result = event.data.result?.content ?? event.data.error?.message ?? "";
        out.push(
          this.tag(
            {
              type: E.TOOL_CALL_RESULT,
              toolCallId: tool.id,
              messageId: `result:${tool.id}`,
              role: "tool",
              content: boundedText(result),
            },
            tool.subagentRunId,
          ),
        );
        break;
      }
      // The runtime stamps the child's agentId on the envelope; the spawning
      // toolCallId is the fallback so the lifecycle stays correlatable.
      case "subagent.started": {
        const started: SubagentStartedEvent = {
          type: E.SUBAGENT_STARTED,
          subagentRunId: agentId ?? event.data.toolCallId,
          name: event.data.agentDisplayName ?? event.data.agentName,
          description: event.data.agentDescription,
          parentSubagentRunId: event.data.parentId && this.subagents.has(event.data.parentId)
            ? event.data.parentId : undefined,
          parentToolCallId: event.data.toolCallId,
        };
        this.subagents.set(started.subagentRunId, started);
        out.push(started);
        break;
      }
      case "subagent.completed":
        this.subagents.delete(agentId ?? event.data.toolCallId);
        out.push({
          type: E.SUBAGENT_FINISHED,
          subagentRunId: agentId ?? event.data.toolCallId,
          outcome: { type: "success" },
        });
        break;
      case "subagent.failed":
        this.subagents.delete(agentId ?? event.data.toolCallId);
        out.push({
          type: E.SUBAGENT_ERROR,
          subagentRunId: agentId ?? event.data.toolCallId,
          message: event.data.error,
        });
        break;
      case "assistant.turn_end":
        for (const block of this.blocks.values()) {
          if (block.subagentRunId === agentId) this.close(block, out);
        }
        break;
    }
    return out;
  }

  /** AG-UI requires children to be suspended before their parent hands off. */
  suspend(): BaseEvent[] {
    this.suspended = true;
    return [...this.subagents.keys()].reverse().map((subagentRunId) => ({
      type: E.SUBAGENT_FINISHED, subagentRunId, outcome: { type: "suspended" },
    }));
  }

  resume(): BaseEvent[] {
    if (!this.suspended) return [];
    this.suspended = false;
    return [...this.subagents.values()];
  }

  /** Close blocks left open by a handoff, cancellation, or error. Never invents a tool result. */
  finish(): BaseEvent[] {
    const out: BaseEvent[] = [];
    for (const block of this.blocks.values()) this.close(block, out);
    for (const tool of this.tools.values()) {
      if (tool.started && !tool.ended) {
        tool.ended = true;
        out.push(this.tag({ type: E.TOOL_CALL_END, toolCallId: tool.id }, tool.subagentRunId));
      }
    }
    return out;
  }
}
