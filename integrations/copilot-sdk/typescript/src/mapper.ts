import { EventType as E, type BaseEvent } from "@ag-ui/core";
import type { SessionEvent } from "@github/copilot-sdk";

// Runtime interruption notifications are not in the 1.0.14 TypeScript event union.
export type CopilotSessionEvent = SessionEvent | (
  Pick<SessionEvent, "id" | "timestamp" | "parentId" | "agentId"> & {
    type: "agent.interrupted";
    data: unknown;
    ephemeral?: boolean;
  }
);

export interface MapperOptions {
  threadId: string;
  runId: string;
  maxOutputBytes?: number;
  maxEvents?: number;
}

interface TextBlock {
  id: string;
  text: string;
  closed: boolean;
  reasoning: boolean;
  agentId?: string;
}
interface ToolBlock {
  id: string;
  name?: string;
  args: string;
  started: boolean;
  ended: boolean;
  completed: boolean;
  output: string;
  truncated: boolean;
  parentToolCallId?: string;
  agentId?: string;
  nativeShell?: boolean;
  command?: string;
  progress?: string;
  exitCode?: number;
  arguments?: unknown;
}

export function boundedText(text: string, bytes: number): string {
  const encoded = Buffer.from(text);
  if (encoded.length <= bytes) return text;
  // TextDecoder drops a final incomplete UTF-8 sequence, never splitting a code point.
  return new TextDecoder().decode(encoded.subarray(0, bytes), { stream: true });
}

/** Stateful, allowlisted projection of one native SDK turn (including browser handoffs). */
export class CopilotEventMapper {
  private readonly seen = new Set<string>();
  private readonly blocks = new Map<string, TextBlock>();
  private readonly tools = new Map<string, ToolBlock>();
  private readonly agents = new Map<string, string>();
  private readonly children = new Map<string, Record<string, unknown>>();
  private readonly childRunIds = new Map<string, string>();
  private started = false;
  private terminal = false;
  private readonly maxOutput: number;
  private readonly maxEvents: number;

  constructor(private readonly options: MapperOptions) {
    this.maxOutput = options.maxOutputBytes ?? 64 * 1024;
    this.maxEvents = options.maxEvents ?? 20_000;
    if (!Number.isSafeInteger(this.maxOutput) || this.maxOutput < 1 ||
        !Number.isSafeInteger(this.maxEvents) || this.maxEvents < 1) {
      throw new Error("Mapper limits must be positive integers");
    }
  }

  start(): BaseEvent[] {
    if (this.started || this.terminal) return [];
    this.started = true;
    return [{ type: E.RUN_STARTED, threadId: this.options.threadId, runId: this.options.runId }];
  }

  /** Restore server-owned handoff metadata without replaying a tool call into the next AG-UI run. */
  restorePendingTool(toolCallId: string, toolName: string, args: unknown, agentId?: string, parentToolCallId?: string): void {
    const tool = this.tool(toolCallId, agentId);
    tool.name = toolName;
    tool.arguments = args;
    tool.parentToolCallId = parentToolCallId ?? tool.parentToolCallId;
    tool.started = true;
    tool.ended = true;
  }

  private id(id: string, agentId?: string): string {
    return agentId ? `${agentId}:${id}` : id;
  }

  private block(id: string, reasoning: boolean, agentId: string | undefined, out: BaseEvent[]): TextBlock {
    const key = `${reasoning ? "reasoning" : "text"}:${this.id(id, agentId)}`;
    let block = this.blocks.get(key);
    if (!block) {
      block = { id: this.id(id, agentId), text: "", closed: false, reasoning, agentId };
      this.blocks.set(key, block);
      const attribution = agentId ? { subagentRunId: agentId } : {};
      if (reasoning) out.push({ type: E.REASONING_START, messageId: block.id, ...attribution });
      out.push({
        type: reasoning ? E.REASONING_MESSAGE_START : E.TEXT_MESSAGE_START,
        messageId: block.id, role: reasoning ? "reasoning" : "assistant", ...attribution,
      });
    }
    return block;
  }

  private append(block: TextBlock, text: string, out: BaseEvent[]): void {
    if (!text || block.closed) return;
    if (Buffer.byteLength(block.text) + Buffer.byteLength(text) > this.maxOutput) {
      throw new Error("Assistant output limit exceeded");
    }
    block.text += text;
    out.push({
      type: block.reasoning ? E.REASONING_MESSAGE_CONTENT : E.TEXT_MESSAGE_CONTENT,
      messageId: block.id, delta: text,
      ...(block.agentId ? { subagentRunId: block.agentId } : {}),
    });
  }

  private close(block: TextBlock, out: BaseEvent[]): void {
    if (block.closed) return;
    block.closed = true;
    const attribution = block.agentId ? { subagentRunId: block.agentId } : {};
    out.push({
      type: block.reasoning ? E.REASONING_MESSAGE_END : E.TEXT_MESSAGE_END,
      messageId: block.id, ...attribution,
    });
    if (block.reasoning) out.push({ type: E.REASONING_END, messageId: block.id, ...attribution });
  }

  private tool(id: string, agentId?: string): ToolBlock {
    // SDK toolCallId is globally unique and is also the browser's pending-RPC correlation key.
    let tool = this.tools.get(id);
    if (!tool) {
      tool = {
        id, args: "", started: false, ended: false, completed: false,
        output: "", truncated: false, agentId,
        parentToolCallId: agentId ? this.agents.get(agentId) : undefined,
      };
      this.tools.set(id, tool);
    } else if (agentId && !tool.agentId) {
      tool.agentId = agentId;
      tool.parentToolCallId ??= this.agents.get(agentId);
    }
    return tool;
  }

  private startTool(tool: ToolBlock, out: BaseEvent[], parentMessageId?: string): void {
    if (tool.started || !tool.name) return;
    tool.started = true;
    out.push({
      type: E.TOOL_CALL_START, toolCallId: tool.id, toolCallName: tool.name,
      ...(parentMessageId ? { parentMessageId } : {}),
      ...(tool.agentId ? { subagentRunId: tool.agentId } : {}),
    });
    if (tool.args) out.push({
      type: E.TOOL_CALL_ARGS, toolCallId: tool.id, delta: tool.args,
      ...(tool.agentId ? { subagentRunId: tool.agentId } : {}),
    });
  }

  private endTool(tool: ToolBlock, out: BaseEvent[]): void {
    if (!tool.started || tool.ended) return;
    tool.ended = true;
    out.push({
      type: E.TOOL_CALL_END, toolCallId: tool.id,
      ...(tool.agentId ? { subagentRunId: tool.agentId } : {}),
    });
  }

  private args(tool: ToolBlock, args: unknown, out: BaseEvent[]): void {
    const complete = typeof args === "string" ? args : JSON.stringify(args ?? {});
    if (Buffer.byteLength(complete) > this.maxOutput) throw new Error("Tool arguments limit exceeded");
    if (!tool.ended) {
      if (!tool.started) {
        tool.args = complete;
        tool.arguments = args;
        return;
      }
      const suffix = complete.startsWith(tool.args) ? complete.slice(tool.args.length) : "";
      if (tool.args && !complete.startsWith(tool.args)) throw new Error("Conflicting tool argument stream");
      if (suffix && tool.started) out.push({
        type: E.TOOL_CALL_ARGS, toolCallId: tool.id, delta: suffix,
        ...(tool.agentId ? { subagentRunId: tool.agentId } : {}),
      });
      tool.args = complete;
    }
    tool.arguments = args;
  }

  private activity(tool: ToolBlock, status: string): BaseEvent {
    return {
      type: E.ACTIVITY_SNAPSHOT, messageId: `activity:${tool.id}`,
      activityType: "copilot-sdk:tool", replace: true,
      ...(tool.agentId ? { subagentRunId: tool.agentId } : {}),
      content: {
        toolCallId: tool.id, toolName: tool.name ?? "unknown", status,
        ...(tool.arguments !== undefined ? { arguments: tool.arguments } : {}),
        ...(tool.command !== undefined ? { command: tool.command } : {}),
        output: tool.output, truncated: tool.truncated,
        ...(tool.progress !== undefined ? { progress: tool.progress } : {}),
        ...(tool.exitCode !== undefined ? { exitCode: tool.exitCode } : {}),
        ...(tool.parentToolCallId ? { parentToolCallId: tool.parentToolCallId } : {}),
      },
    };
  }

  mapEvent(event: CopilotSessionEvent): BaseEvent[] {
    if (this.terminal || this.seen.has(event.id)) return [];
    if (event.agentId && !this.agents.has(event.agentId) && event.type !== "subagent.started" &&
        (event.type.startsWith("assistant.") || event.type.startsWith("tool.execution_") ||
          ["external_tool.requested", "subagent.completed", "subagent.failed", "abort", "agent.interrupted"].includes(event.type))) {
      throw new Error("Unannounced subagent identity");
    }
    if (this.seen.size >= this.maxEvents) throw new Error("SDK event limit exceeded");
    this.seen.add(event.id);
    const out: BaseEvent[] = [];
    switch (event.type) {
      case "assistant.message_start":
        this.block(event.data.messageId, false, event.agentId, out);
        break;
      case "assistant.message_delta":
        this.append(this.block(event.data.messageId, false, event.agentId, out), event.data.deltaContent, out);
        break;
      case "assistant.reasoning_delta":
        this.append(this.block(event.data.reasoningId, true, event.agentId, out), event.data.deltaContent, out);
        break;
      case "assistant.reasoning": {
        const block = this.block(event.data.reasoningId, true, event.agentId, out);
        if (!block.text) this.append(block, event.data.content, out);
        else if (event.data.content.startsWith(block.text)) this.append(block, event.data.content.slice(block.text.length), out);
        this.close(block, out);
        break;
      }
      case "assistant.message": {
        if (event.data.content || this.blocks.has(`text:${this.id(event.data.messageId, event.agentId)}`)) {
          const block = this.block(event.data.messageId, false, event.agentId, out);
          if (!block.text) this.append(block, event.data.content, out);
          else if (event.data.content.startsWith(block.text)) this.append(block, event.data.content.slice(block.text.length), out);
          this.close(block, out);
        }
        for (const request of event.data.toolRequests ?? []) {
          const tool = this.tool(request.toolCallId, event.agentId);
          tool.name = request.name;
          this.args(tool, request.arguments, out);
          this.startTool(tool, out, this.id(event.data.messageId, event.agentId));
          this.endTool(tool, out);
        }
        break;
      }
      case "assistant.tool_call_delta": {
        const tool = this.tool(event.data.toolCallId, event.agentId);
        if (tool.ended) break;
        if (Buffer.byteLength(tool.args) + Buffer.byteLength(event.data.inputDelta) > this.maxOutput) {
          throw new Error("Tool arguments limit exceeded");
        }
        // Names can be partial while streaming: wait for the authoritative declaration.
        tool.args += event.data.inputDelta;
        break;
      }
      case "tool.execution_start": {
        const tool = this.tool(event.data.toolCallId, event.agentId);
        if (tool.completed) break;
        tool.name = event.data.toolName;
        tool.parentToolCallId = event.data.parentToolCallId ?? tool.parentToolCallId;
        tool.nativeShell ||= event.data.shellToolInfo != null || tool.name === "bash" || tool.name === "powershell";
        tool.command = event.data.shellToolInfo?.displayCommand ?? tool.command;
        const args = event.data.arguments;
        if (!tool.command && tool.nativeShell &&
            args && typeof args === "object" && !Array.isArray(args) && typeof args.command === "string") {
          tool.command = args.command;
        }
        this.args(tool, event.data.arguments, out);
        this.startTool(tool, out);
        this.endTool(tool, out);
        out.push(this.activity(tool, "running"));
        break;
      }
      case "external_tool.requested": {
        const tool = this.tool(event.data.toolCallId, event.agentId);
        tool.name = event.data.toolName;
        this.args(tool, event.data.arguments, out);
        this.startTool(tool, out);
        this.endTool(tool, out);
        break;
      }
      case "tool.execution_partial_result": {
        const tool = this.tool(event.data.toolCallId, event.agentId);
        if (tool.completed) break;
        // Runtime 1.0.85 shell tools send cumulative snapshots, despite the generic delta schema.
        const shell = tool.nativeShell || tool.name === "bash" || tool.name === "powershell";
        const text = shell ? event.data.partialOutput : tool.output + event.data.partialOutput;
        tool.output = boundedText(text, this.maxOutput);
        tool.truncated ||= Buffer.byteLength(text) > this.maxOutput;
        out.push(this.activity(tool, "running"));
        break;
      }
      case "tool.execution_progress": {
        const tool = this.tool(event.data.toolCallId, event.agentId);
        if (tool.completed) break;
        tool.progress = boundedText(event.data.progressMessage, this.maxOutput);
        out.push(this.activity(tool, "running"));
        break;
      }
      case "tool.execution_complete": {
        const tool = this.tool(event.data.toolCallId, event.agentId);
        if (tool.completed) break;
        this.endTool(tool, out);
        tool.completed = true;
        const result = event.data.result?.content ?? event.data.error?.message ?? "";
        // Final result is authoritative; do not append a second copy of streamed output.
        if (result || !tool.output) tool.output = boundedText(result, this.maxOutput);
        tool.truncated ||= Buffer.byteLength(result) > this.maxOutput;
        tool.exitCode = event.data.shellExecution?.exitCode;
        out.push({
          type: E.TOOL_CALL_RESULT, toolCallId: tool.id, messageId: `result:${tool.id}`, role: "tool",
          content: boundedText(result, this.maxOutput),
          ...(tool.agentId ? { subagentRunId: tool.agentId } : {}),
        }, this.activity(tool, event.data.success && (tool.exitCode === undefined || tool.exitCode === 0) ? "completed" : "error"));
        break;
      }
      case "subagent.started": {
        if (this.children.has(event.data.toolCallId)) break;
        const parent = event.data.parentId ? this.agents.get(event.data.parentId) : undefined;
        const parentSubagentRunId = parent ? this.childRunIds.get(parent) : undefined;
        if (event.agentId) this.agents.set(event.agentId, event.data.toolCallId);
        this.childRunIds.set(event.data.toolCallId, event.agentId ?? `subagent:${event.data.toolCallId}`);
        const content = {
          toolCallId: event.data.toolCallId, agentName: event.data.agentName, status: "running",
          description: event.data.agentDescription, ...(parent ? { parentToolCallId: parent } : {}),
        };
        this.children.set(event.data.toolCallId, content);
        out.push({
          type: E.SUBAGENT_STARTED, subagentRunId: event.agentId ?? `subagent:${event.data.toolCallId}`,
          name: event.data.agentName, description: event.data.agentDescription,
          parentToolCallId: event.data.toolCallId,
          ...(parentSubagentRunId ? { parentSubagentRunId } : {}),
        });
        out.push({ type: E.ACTIVITY_SNAPSHOT, messageId: `subagent:${event.data.toolCallId}`,
          activityType: "copilot-sdk:subagent", content, replace: true,
          subagentRunId: event.agentId ?? `subagent:${event.data.toolCallId}` });
        break;
      }
      case "subagent.completed":
      case "subagent.failed": {
        const previous = this.children.get(event.data.toolCallId);
        if (!previous) throw new Error("Unannounced subagent identity");
        if (previous && previous.status !== "running") break;
        const subagentRunId = event.agentId ?? this.childRunIds.get(event.data.toolCallId) ?? `subagent:${event.data.toolCallId}`;
        for (const block of this.blocks.values()) if (block.agentId === subagentRunId) this.close(block, out);
        const content = {
          ...this.children.get(event.data.toolCallId),
          toolCallId: event.data.toolCallId,
          agentName: event.data.agentName ?? previous?.agentName ?? "unknown",
          status: event.type === "subagent.failed" ? "error" : event.data.cancelled ? "cancelled" : "completed",
        };
        this.children.set(event.data.toolCallId, content);
        out.push(event.type === "subagent.failed"
          ? { type: E.SUBAGENT_ERROR, subagentRunId, message: boundedText(event.data.error, this.maxOutput) }
          : event.data.cancelled
            ? { type: E.SUBAGENT_ERROR, subagentRunId, message: "Subagent cancelled", code: "CANCELLED" }
            : { type: E.SUBAGENT_FINISHED, subagentRunId });
        out.push({ type: E.ACTIVITY_SNAPSHOT, messageId: `subagent:${event.data.toolCallId}`,
          activityType: "copilot-sdk:subagent", content, replace: true, subagentRunId });
        break;
      }
      case "assistant.turn_end":
        for (const block of this.blocks.values()) if (block.agentId === event.agentId) this.close(block, out);
        break;
      case "session.error":
        return this.finish(event.data.message);
      case "abort":
      case "agent.interrupted":
        return this.finish("Run cancelled", true);
      case "session.idle":
        return this.finish();
    }
    return out;
  }

  /** Close orphaned blocks exactly once. Handoffs close tools without inventing results. */
  finish(error?: string, cancelled = false): BaseEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (error !== undefined) error = boundedText(error, this.maxOutput);
    const out: BaseEvent[] = [];
    for (const block of this.blocks.values()) this.close(block, out);
    for (const tool of this.tools.values()) {
      this.endTool(tool, out);
      if (error !== undefined && !tool.completed) out.push(this.activity(tool, cancelled ? "cancelled" : "error"));
    }
    for (const [id, content] of this.children) {
      if (content.status !== "running") continue;
      const subagentRunId = this.childRunIds.get(id) ?? `subagent:${id}`;
      out.push(error === undefined
        ? { type: E.SUBAGENT_FINISHED, subagentRunId, outcome: { type: "suspended" } }
        : { type: E.SUBAGENT_ERROR, subagentRunId, message: error, ...(cancelled ? { code: "CANCELLED" } : {}) });
      if (error !== undefined) out.push({ type: E.ACTIVITY_SNAPSHOT, messageId: `subagent:${id}`,
        activityType: "copilot-sdk:subagent", replace: true, subagentRunId,
        content: { ...content, status: cancelled ? "cancelled" : "error" } });
    }
    if (this.started) out.push(error === undefined
      ? { type: E.RUN_FINISHED, threadId: this.options.threadId, runId: this.options.runId }
      : { type: E.RUN_ERROR, message: error, code: cancelled ? "CANCELLED" : "COPILOT_SDK_ERROR" });
    return out;
  }
}
