import { createHash } from "node:crypto";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { CodexAdapterError } from "./errors";
import type { CodexSessionRecord } from "./sessions";

export function fingerprint(message: Message): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        message.id,
        message.role,
        "content" in message ? message.content : null,
      ]),
    )
    .digest("hex");
}

function textContent(message: Message): string {
  if (
    message.role === "tool" ||
    message.role === "activity" ||
    message.role === "reasoning"
  ) {
    throw new CodexAdapterError(
      "UNSUPPORTED_MESSAGE",
      "Only text chat messages are supported.",
    );
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    throw new CodexAdapterError(
      "UNSUPPORTED_TOOLS",
      "Frontend tool calls are not supported.",
    );
  }
  if (typeof message.content !== "string") {
    throw new CodexAdapterError(
      "UNSUPPORTED_CONTENT",
      "Only plain text content is supported.",
    );
  }
  return message.content;
}

function hasForwardedProps(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "object" && !Array.isArray(value))
    return Object.keys(value).length > 0;
  return true;
}

export function projectInput(
  input: RunAgentInput,
  record: CodexSessionRecord | undefined,
  limits: { maxInputBytes: number; maxMessages: number },
): { prompt: string; fingerprints: string[] } {
  if (input.tools.length > 0)
    throw new CodexAdapterError(
      "UNSUPPORTED_TOOLS",
      "Frontend tools are not supported by the Codex text-chat adapter.",
    );
  if (hasForwardedProps(input.forwardedProps))
    throw new CodexAdapterError(
      "UNSUPPORTED_OVERRIDES",
      "Per-request overrides are not supported. Configure Codex on the host.",
    );
  if (input.resume?.length)
    throw new CodexAdapterError(
      "UNSUPPORTED_RESUME",
      "Frontend approval responses are not supported.",
    );
  if (
    Buffer.byteLength(
      JSON.stringify({
        messages: input.messages,
        context: input.context,
        state: input.state,
      }),
      "utf8",
    ) > limits.maxInputBytes
  ) {
    throw new CodexAdapterError(
      "INPUT_LIMIT",
      "Input exceeds the configured byte limit.",
    );
  }
  if (record && record.status !== "ready")
    throw new CodexAdapterError(
      "SESSION_FAILED",
      "This native session was interrupted. Start a new AG-UI thread.",
    );
  const messages = input.messages.filter(
    (message) => message.role !== "reasoning",
  );
  const fingerprints = messages.map(fingerprint);
  if (new Set(messages.map((message) => message.id)).size !== messages.length) {
    throw new CodexAdapterError(
      "DUPLICATE_MESSAGE",
      "Message IDs must be unique within a thread.",
    );
  }
  for (const message of messages) textContent(message);
  if (fingerprints.length >= limits.maxMessages)
    throw new CodexAdapterError(
      "MESSAGE_LIMIT",
      "Session history is full. Start a new AG-UI thread.",
    );
  const acceptedCount = record?.fingerprints.length ?? 0;
  if (
    record &&
    (messages.length < acceptedCount ||
      record.fingerprints.some((hash, index) => hash !== fingerprints[index]))
  ) {
    throw new CodexAdapterError(
      "HISTORY_DIVERGED",
      "Conversation history changed. Start a new AG-UI thread.",
    );
  }
  if (!record && messages.some((message) => message.role === "assistant")) {
    throw new CodexAdapterError(
      "SESSION_EXPIRED",
      "No trusted session exists for this history. Start a new AG-UI thread.",
    );
  }
  const appended = messages.slice(acceptedCount);
  if (!appended.some((message) => message.role === "user"))
    throw new CodexAdapterError(
      "MISSING_USER_INPUT",
      "Append at least one new user text message.",
    );
  if (record && appended.some((message) => message.role !== "user"))
    throw new CodexAdapterError(
      "UNSUPPORTED_HISTORY",
      "Continued turns may append only user text messages.",
    );
  const transcript = appended
    .map(
      (message) =>
        `<${message.role}>\n${textContent(message)}\n</${message.role}>`,
    )
    .join("\n");
  const addendum = JSON.stringify({
    context: input.context,
    state: input.state ?? {},
  });
  return {
    prompt: `AG-UI ${record ? "new user input" : "text transcript context"}:\n${transcript}\n\nAG-UI read-only request context and state:\n${addendum}`,
    fingerprints,
  };
}
