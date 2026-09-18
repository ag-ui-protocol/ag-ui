import { EventType as E, type BaseEvent } from "@ag-ui/core";
import type { SessionEvent } from "@github/copilot-sdk";

const MAX_OUTPUT_BYTES = 64 * 1024;

interface TextBlock {
  id: string;
  text: string;
  closed: boolean;
  reasoning: boolean;
}

interface ToolBlock {
  id: string;
  name?: string;
  args: string;
  started: boolean;
  ended: boolean;
  completed: boolean;
}

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

  private block(id: string, reasoning: boolean, out: BaseEvent[]): TextBlock {
    const key = `${reasoning ? "reasoning" : "text"}:${id}`;
    let block = this.blocks.get(key);
    if (!block) {
      block = { id, text: "", closed: false, reasoning };
      this.blocks.set(key, block);
      if (reasoning) {
        out.push({ type: E.REASONING_START, messageId: id });
        out.push({ type: E.REASONING_MESSAGE_START, messageId: id, role: "reasoning" });
      } else {
        out.push({ type: E.TEXT_MESSAGE_START, messageId: id, role: "assistant" });
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
    out.push({
      type: block.reasoning ? E.REASONING_MESSAGE_CONTENT : E.TEXT_MESSAGE_CONTENT,
      messageId: block.id,
      delta,
    });
  }

  private close(block: TextBlock, out: BaseEvent[]): void {
    if (block.closed) return;
    block.closed = true;
    out.push({
      type: block.reasoning ? E.REASONING_MESSAGE_END : E.TEXT_MESSAGE_END,
      messageId: block.id,
    });
    if (block.reasoning) out.push({ type: E.REASONING_END, messageId: block.id });
  }

  /** The native toolCallId is globally unique and is the browser's correlation key. */
  private tool(id: string): ToolBlock {
    let tool = this.tools.get(id);
    if (!tool) {
      tool = { id, args: "", started: false, ended: false, completed: false };
      this.tools.set(id, tool);
    }
    return tool;
  }

  private emitToolCall(tool: ToolBlock, args: unknown, out: BaseEvent[]): void {
    if (tool.started || !tool.name) return;
    tool.started = true;
    tool.args = typeof args === "string" ? args : JSON.stringify(args ?? {});
    out.push({ type: E.TOOL_CALL_START, toolCallId: tool.id, toolCallName: tool.name });
    if (tool.args) out.push({ type: E.TOOL_CALL_ARGS, toolCallId: tool.id, delta: tool.args });
    tool.ended = true;
    out.push({ type: E.TOOL_CALL_END, toolCallId: tool.id });
  }

  mapEvent(event: SessionEvent): BaseEvent[] {
    if (this.seen.has(event.id)) return [];
    this.seen.add(event.id);
    const out: BaseEvent[] = [];
    switch (event.type) {
      case "assistant.message_start":
        this.block(event.data.messageId, false, out);
        break;
      case "assistant.message_delta":
        this.append(this.block(event.data.messageId, false, out), event.data.deltaContent, out);
        break;
      case "assistant.reasoning_delta":
        this.append(this.block(event.data.reasoningId, true, out), event.data.deltaContent, out);
        break;
      case "assistant.reasoning": {
        const block = this.block(event.data.reasoningId, true, out);
        this.append(block, event.data.content, out, true);
        this.close(block, out);
        break;
      }
      case "assistant.message": {
        if (event.data.content || this.blocks.has(`text:${event.data.messageId}`)) {
          const block = this.block(event.data.messageId, false, out);
          this.append(block, event.data.content, out, true);
          this.close(block, out);
        }
        for (const request of event.data.toolRequests ?? []) {
          const tool = this.tool(request.toolCallId);
          tool.name = request.name;
          this.emitToolCall(tool, request.arguments, out);
        }
        break;
      }
      case "tool.execution_start": {
        const tool = this.tool(event.data.toolCallId);
        tool.name = event.data.toolName;
        this.emitToolCall(tool, event.data.arguments, out);
        break;
      }
      case "external_tool.requested": {
        const tool = this.tool(event.data.toolCallId);
        tool.name = event.data.toolName;
        this.emitToolCall(tool, event.data.arguments, out);
        break;
      }
      case "tool.execution_complete": {
        const tool = this.tool(event.data.toolCallId);
        if (tool.completed) break;
        tool.completed = true;
        const result = event.data.result?.content ?? event.data.error?.message ?? "";
        out.push({
          type: E.TOOL_CALL_RESULT,
          toolCallId: tool.id,
          messageId: `result:${tool.id}`,
          role: "tool",
          content: boundedText(result),
        });
        break;
      }
      case "assistant.turn_end":
        for (const block of this.blocks.values()) this.close(block, out);
        break;
    }
    return out;
  }

  /** Close blocks left open by a handoff, cancellation, or error. Never invents a tool result. */
  finish(): BaseEvent[] {
    const out: BaseEvent[] = [];
    for (const block of this.blocks.values()) this.close(block, out);
    for (const tool of this.tools.values()) {
      if (tool.started && !tool.ended) {
        tool.ended = true;
        out.push({ type: E.TOOL_CALL_END, toolCallId: tool.id });
      }
    }
    return out;
  }
}
