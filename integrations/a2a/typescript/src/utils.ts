import type {
  BaseEvent,
  InputContent,
  Message,
  TextMessageChunkEvent,
  RawEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  ToolCallResultEvent,
} from "@ag-ui/client";
import { EventType, randomUUID } from "@ag-ui/client";
import type {
  A2AMessage,
  A2APart,
  A2ATextPart,
  A2ADataPart,
  A2AFilePart,
  A2AStreamEvent,
  ConvertAGUIMessagesOptions,
  ConvertedA2AMessages,
  ConvertA2AEventOptions,
} from "./types";

const ROLE_MAP: Record<string, "user" | "agent" | undefined> = {
  user: "user",
  assistant: "agent",
  tool: "agent",
  system: "user",
  developer: "user",
};

const TOOL_RESULT_PART_TYPE = "tool-result";
const TOOL_CALL_PART_TYPE = "tool-call";

const isBinaryContent = (
  content: InputContent,
): content is Extract<InputContent, { type: "binary" }> => content.type === "binary";

const isTextContent = (content: InputContent): content is Extract<InputContent, { type: "text" }> =>
  content.type === "text";

const createTextPart = (text: string): A2ATextPart => ({
  kind: "text",
  text,
});

const createFilePart = (content: Extract<InputContent, { type: "binary" }>): A2AFilePart | null => {
  if (content.url) {
    return {
      kind: "file",
      file: {
        uri: content.url,
        mimeType: content.mimeType,
        name: content.filename,
      },
    };
  }

  if (content.data) {
    return {
      kind: "file",
      file: {
        bytes: content.data,
        mimeType: content.mimeType,
        name: content.filename,
      },
    };
  }

  return null;
};

const safeJsonParse = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch (error) {
    return value;
  }
};

const messageContentToParts = (message: Message): A2APart[] => {
  const parts: A2APart[] = [];
  const { content } = message as { content?: Message["content"] };

  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed.length > 0) {
      parts.push(createTextPart(trimmed));
    }
  } else if (Array.isArray(content)) {
    for (const chunk of content) {
      if (isTextContent(chunk)) {
        const value = chunk.text.trim();
        if (value.length > 0) {
          parts.push(createTextPart(value));
        }
      } else if (isBinaryContent(chunk)) {
        const filePart = createFilePart(chunk);
        if (filePart) {
          parts.push(filePart);
        }
      } else {
        parts.push({ kind: "data", data: chunk } as A2ADataPart);
      }
    }
  } else if (content && typeof content === "object") {
    parts.push({
      kind: "data",
      data: content as Record<string, unknown>,
    });
  }

  if (message.role === "assistant" && "toolCalls" in message && message.toolCalls?.length) {
    for (const toolCall of message.toolCalls) {
      parts.push({
        kind: "data",
        data: {
          type: TOOL_CALL_PART_TYPE,
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: safeJsonParse(toolCall.function.arguments),
          rawArguments: toolCall.function.arguments,
        },
      });
    }
  }

  if (message.role === "tool") {
    const payload = typeof message.content === "string" ? safeJsonParse(message.content) : message.content;
    parts.push({
      kind: "data",
      data: {
        type: TOOL_RESULT_PART_TYPE,
        toolCallId: message.toolCallId,
        payload,
      },
    });
  }

  return parts;
};

const messageContentToText = (message: Message): string => {
  const { content } = message as { content?: Message["content"] };
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part): part is Extract<InputContent, { type: "text" }> => isTextContent(part))
      .map((part) => part.text)
      .join("\n");
  }
  if (content && typeof content === "object") {
    return JSON.stringify(content);
  }
  return "";
};

export function convertAGUIMessagesToA2A(
  messages: Message[],
  options: ConvertAGUIMessagesOptions = {},
): ConvertedA2AMessages {
  const history: A2AMessage[] = [];
  const includeToolMessages = options.includeToolMessages ?? true;
  const contextId = options.contextId;

  for (const message of messages) {
    if (message.role === "activity") {
      continue;
    }

    if (message.role === "tool" && !includeToolMessages) {
      continue;
    }

    if (message.role === "system" || message.role === "developer") {
      continue;
    }

    const mappedRole = ROLE_MAP[message.role] ?? (message.role === "tool" ? "agent" : undefined);

    if (!mappedRole) {
      continue;
    }

    const parts = messageContentToParts(message);

    if (parts.length === 0 && mappedRole !== "agent") {
      continue;
    }

    const messageId = message.id ?? randomUUID();

    history.push({
      kind: "message",
      messageId,
      role: mappedRole,
      parts,
      contextId,
    });
  }

  const latestUserMessage = [...history].reverse().find((msg) => msg.role === "user");

  return {
    contextId,
    history,
    latestUserMessage,
  };
}

const isA2AMessage = (event: A2AStreamEvent): event is A2AMessage => event.kind === "message";

const isA2ATask = (event: A2AStreamEvent): event is import("@a2a-js/sdk").Task => event.kind === "task";

export function convertA2AEventToAGUIEvents(
  event: A2AStreamEvent,
  options: ConvertA2AEventOptions,
): BaseEvent[] {
  const events: BaseEvent[] = [];
  const role = options.role ?? "assistant";
  const source = options.source ?? "a2a";

  if (isA2AMessage(event)) {
    const originalId = event.messageId ?? randomUUID();
    const mappedId = options.messageIdMap.get(originalId) ?? randomUUID();
    options.messageIdMap.set(originalId, mappedId);

    const openToolCalls = new Set<string>();

    for (const part of event.parts ?? []) {
      if (part.kind === "text") {
        const textPart = part as A2ATextPart;
        if (textPart.text) {
          const chunkEvent: TextMessageChunkEvent = {
            type: EventType.TEXT_MESSAGE_CHUNK,
            messageId: mappedId,
            role,
            delta: textPart.text,
          };
          options.onTextDelta?.({ messageId: mappedId, delta: textPart.text });
          events.push(chunkEvent);
        }
        continue;
      }

      if (part.kind === "data") {
        const dataPart = part as A2ADataPart;
        const payload = dataPart.data;

        if (payload && typeof payload === "object" && (payload as any).type === TOOL_CALL_PART_TYPE) {
          const toolCallId = (payload as any).id ?? randomUUID();
          const toolCallName = (payload as any).name ?? "unknown_tool";
          const args = (payload as any).arguments;

          const startEvent: ToolCallStartEvent = {
            type: EventType.TOOL_CALL_START,
            toolCallId,
            toolCallName,
            parentMessageId: mappedId,
          };
          events.push(startEvent);

          if (args !== undefined) {
            const argsEvent: ToolCallArgsEvent = {
              type: EventType.TOOL_CALL_ARGS,
              toolCallId,
              delta: JSON.stringify(args),
            };
            events.push(argsEvent);
          }

          openToolCalls.add(toolCallId);
          continue;
        }

        if (
          payload &&
          typeof payload === "object" &&
          (payload as any).type === TOOL_RESULT_PART_TYPE &&
          (payload as any).toolCallId
        ) {
          const toolCallId = (payload as any).toolCallId;
          const toolResultEvent: ToolCallResultEvent = {
            type: EventType.TOOL_CALL_RESULT,
            toolCallId,
            content: JSON.stringify((payload as any).payload ?? payload),
            messageId: randomUUID(),
            role: "tool",
          };
          events.push(toolResultEvent);

          if (openToolCalls.has(toolCallId)) {
            const endEvent: ToolCallEndEvent = {
              type: EventType.TOOL_CALL_END,
              toolCallId,
            };
            events.push(endEvent);
            openToolCalls.delete(toolCallId);
          }
        }

        continue;
      }

      // Ignore other part kinds for now.
    }

    for (const toolCallId of openToolCalls) {
      const endEvent: ToolCallEndEvent = {
        type: EventType.TOOL_CALL_END,
        toolCallId,
      };
      events.push(endEvent);
    }

    return events;
  }

  if (isA2ATask(event)) {
    const rawEvent: RawEvent = {
      type: EventType.RAW,
      event,
      source,
    };
    events.push(rawEvent);
    return events;
  }

  const fallbackEvent: RawEvent = {
    type: EventType.RAW,
    event,
    source,
  };
  events.push(fallbackEvent);
  return events;
}

export const sendMessageToA2AAgentTool = {
  name: "send_message_to_a2a_agent",
  description:
    "Sends a task to the agent named `agentName`, including the full conversation context and goal",
  parameters: {
    type: "object",
    properties: {
      agentName: {
        type: "string",
        description: "The name of the A2A agent to send the message to.",
      },
      task: {
        type: "string",
        description:
          "The comprehensive conversation-context summary and goal to be achieved regarding the user inquiry.",
      },
    },
    required: ["task"],
  },
} as const;
