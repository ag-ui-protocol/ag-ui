import { EventType, type BaseEvent, type Message } from "@ag-ui/core";
import type { Part } from "@opencode-ai/sdk/v2";

export interface MapperState {
  texts: Record<string, { messageID: string; text: string; open: boolean }>;
  tools: Record<string, { args: string; ended: boolean; result: boolean }>;
  messages: Message[];
}
/** Consumes authoritative part snapshots; duplicate snapshots never repeat deltas. */
export class EventMapper {
  readonly state: MapperState;
  constructor(
    private emit: (event: BaseEvent) => void,
    messages: Message[],
    state?: MapperState,
  ) {
    this.state = state ?? {
      texts: {},
      tools: {},
      messages: structuredClone(messages),
    };
  }
  part(part: Part) {
    if (part.type === "text") {
      const id = `${part.messageID}:${part.id}`;
      let text = this.state.texts[part.id];
      if (!text) {
        this.close();
        text = this.state.texts[part.id] = {
          messageID: id,
          text: "",
          open: true,
        };
        this.state.messages.push({ id, role: "assistant", content: "" });
        this.emit({
          type: EventType.TEXT_MESSAGE_START,
          messageId: id,
          role: "assistant",
        });
      }
      if (part.text === text.text) {
        if (part.time?.end) this.close();
        return;
      }
      const message = this.state.messages.find((m) => m.id === id)!;
      message.content = part.text;
      if (text.open && part.text.startsWith(text.text)) {
        this.emit({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: id,
          delta: part.text.slice(text.text.length),
        });
      } else {
        // AG-UI deltas are append-only. A snapshot is the protocol's replacement operation.
        this.emit({
          type: EventType.MESSAGES_SNAPSHOT,
          messages: structuredClone(this.state.messages),
        });
      }
      text.text = part.text;
      if (part.time?.end) this.close();
    }
    if (part.type === "tool") {
      if (part.state.status === "pending") return; // Pending input is not authoritative yet.
      let tool = this.state.tools[part.callID];
      const args = JSON.stringify(part.state.input);
      if (!tool) {
        this.close();
        tool = this.state.tools[part.callID] = {
          args,
          ended: true,
          result: false,
        };
        this.state.messages.push({
          id: `tool:${part.callID}`,
          role: "assistant",
          toolCalls: [
            {
              id: part.callID,
              type: "function",
              function: { name: part.tool, arguments: args },
            },
          ],
        });
        this.emit({
          type: EventType.TOOL_CALL_START,
          toolCallId: part.callID,
          toolCallName: part.tool,
          parentMessageId: `tool:${part.callID}`,
        });
        this.emit({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: part.callID,
          delta: args,
        });
        this.emit({ type: EventType.TOOL_CALL_END, toolCallId: part.callID });
      } else if (args !== tool.args) {
        tool.args = args;
        const message = this.state.messages.find(
          (m) => m.id === `tool:${part.callID}`,
        );
        if (message?.role === "assistant" && message.toolCalls)
          message.toolCalls[0].function.arguments = args;
        this.emit({
          type: EventType.MESSAGES_SNAPSHOT,
          messages: structuredClone(this.state.messages),
        });
      }
      if (
        !tool.result &&
        (part.state.status === "completed" || part.state.status === "error")
      ) {
        tool.result = true;
        const content =
          part.state.status === "completed"
            ? part.state.output
            : "OpenCode tool failed";
        const messageId = `result:${part.callID}`;
        this.state.messages.push({
          id: messageId,
          role: "tool",
          toolCallId: part.callID,
          content,
        });
        this.emit({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: part.callID,
          messageId,
          content,
          role: "tool",
        });
      }
    }
  }
  close(failed = false) {
    for (const text of Object.values(this.state.texts)) {
      if (text.open) {
        this.emit({
          type: EventType.TEXT_MESSAGE_END,
          messageId: text.messageID,
        });
        text.open = false;
      }
    }
    if (failed)
      for (const [id, tool] of Object.entries(this.state.tools)) {
        if (!tool.result) {
          tool.result = true;
          this.emit({
            type: EventType.TOOL_CALL_RESULT,
            toolCallId: id,
            messageId: `result:${id}`,
            content: "Run ended before tool completion",
            role: "tool",
          });
        }
      }
  }
}
