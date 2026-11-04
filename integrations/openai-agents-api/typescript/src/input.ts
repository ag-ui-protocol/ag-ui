import type {
  Context,
  Message,
  State,
  ToolMessage,
  UserMessage,
} from "@ag-ui/core";
import type { InputContentPart } from "./types";

type ContentPart = Exclude<UserMessage["content"], string>[number];

const dataUrl = (mimeType: string, base64: string) =>
  `data:${mimeType};base64,${base64}`;

/** Converts one AG-UI content part. Returns undefined for parts the Agents API cannot take. */
const convertPart = (part: ContentPart): InputContentPart | undefined => {
  switch (part.type) {
    case "text":
      return part.text ? { type: "input_text", text: part.text } : undefined;
    case "image": {
      const source = part.source;
      if (source.type === "url")
        return { type: "input_image", image_url: source.value };
      if (source.type === "data")
        return {
          type: "input_image",
          image_url: dataUrl(source.mimeType, source.value),
        };
      return undefined;
    }
    default:
      return undefined;
  }
};

/**
 * AG-UI message content as Agents API input parts. Only text and images reach
 * the agent; other modalities are replaced by a short note so the agent knows
 * something was attached.
 */
export const toInputParts = (
  content: UserMessage["content"] | ToolMessage["content"] | undefined,
): InputContentPart[] => {
  if (content === undefined || content === null) return [];
  if (typeof content === "string")
    return content ? [{ type: "input_text", text: content }] : [];
  const parts: InputContentPart[] = [];
  for (const part of content as ContentPart[]) {
    const converted = convertPart(part);
    if (converted) parts.push(converted);
    else if (part.type !== "text")
      parts.push({
        type: "input_text",
        text: `[A ${part.type} attachment was omitted: the agent cannot read it.]`,
      });
  }
  return parts;
};

/** The output to submit for a frontend tool result. */
export const toToolOutput = (
  message: ToolMessage,
): string | InputContentPart[] => {
  if (typeof message.content === "string") return message.content;
  const parts = toInputParts(message.content);
  return parts.length ? parts : "";
};

const plainText = (content: Message["content"]): string => {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { type: string; text?: string }) =>
      part.type === "text" ? (part.text ?? "") : `[${part.type}]`,
    )
    .join(" ");
};

/**
 * The application context and shared state, as an input part prepended to the
 * user's message. The Agents API has no per-turn instructions, so this is how
 * per-run context reaches the agent.
 */
export const contextPart = (
  context: Context[],
  state: State | undefined,
): InputContentPart | undefined => {
  const sections: string[] = [];
  const entries = context.filter(
    (entry) => entry.value !== undefined && entry.value !== "",
  );
  if (entries.length) {
    sections.push(
      [
        "<application_context>",
        "Context provided by the application for this message. Use it when relevant; do not mention this block.",
        ...entries.map((entry) => `- ${entry.description}: ${entry.value}`),
        "</application_context>",
      ].join("\n"),
    );
  }
  if (
    state !== undefined &&
    state !== null &&
    !(typeof state === "object" && Object.keys(state).length === 0)
  ) {
    sections.push(
      [
        "<application_state>",
        "The current shared application state (JSON). It may have been edited by the user since your last turn.",
        JSON.stringify(state),
        "</application_state>",
      ].join("\n"),
    );
  }
  return sections.length
    ? { type: "input_text", text: sections.join("\n\n") }
    : undefined;
};

/** Earlier conversation, rendered as text for a session that never saw it. */
export const transcriptPart = (
  history: Message[],
): InputContentPart | undefined => {
  const lines: string[] = [];
  for (const message of history) {
    switch (message.role) {
      case "user":
        lines.push(`User: ${plainText(message.content)}`);
        break;
      case "assistant": {
        const text = plainText(message.content);
        if (text) lines.push(`Assistant: ${text}`);
        for (const call of message.toolCalls ?? []) {
          lines.push(
            `Assistant called tool ${call.function.name}(${call.function.arguments}) [id ${call.id}]`,
          );
        }
        break;
      }
      case "tool":
        lines.push(
          `Tool result [id ${message.toolCallId}]: ${plainText(message.content)}`,
        );
        break;
      default:
        break;
    }
  }
  if (!lines.length) return undefined;
  return {
    type: "input_text",
    text: [
      "<conversation_history>",
      "The conversation so far, before this session started:",
      ...lines,
      "</conversation_history>",
    ].join("\n"),
  };
};

/**
 * Splits the client's history for a thread with no session yet: the trailing
 * user messages become the first input; everything before them is history.
 */
export const splitFirstContact = (
  messages: Message[],
): { history: Message[]; pending: UserMessage[] } => {
  let index = messages.length;
  while (index > 0 && messages[index - 1].role === "user") index--;
  return {
    history: messages
      .slice(0, index)
      .filter(
        (message) =>
          message.role !== "activity" && message.role !== "reasoning",
      ),
    pending: messages.slice(index) as UserMessage[],
  };
};

/** User messages not yet forwarded to the session. */
export const undeliveredUserMessages = (
  messages: Message[],
  delivered: string[],
): UserMessage[] => {
  const seen = new Set(delivered);
  return messages.filter(
    (message): message is UserMessage =>
      message.role === "user" && !seen.has(message.id),
  );
};

/** Tool messages by tool call id (the last one wins). */
export const toolResultsById = (
  messages: Message[],
): Map<string, ToolMessage> => {
  const results = new Map<string, ToolMessage>();
  for (const message of messages) {
    if (message.role === "tool") results.set(message.toolCallId, message);
  }
  return results;
};
