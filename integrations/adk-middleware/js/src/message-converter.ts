import type {
  ContentPart,
  Message,
  PartSource,
  ToolMessage,
  UserMessage,
} from "@ag-ui/core";
import type { Runner } from "@google/adk";

import type { ADKJSLogger } from "./config";
import { ADKJSProtocolError } from "./errors";
import { errorMessage, isRecord } from "./value-utils";

type RunnerRunParams = Parameters<Runner["runAsync"]>[0];
export type AdkContent = RunnerRunParams["newMessage"];
type AdkPart = NonNullable<AdkContent["parts"]>[number];

interface ConvertedMessage {
  author: string;
  content: AdkContent;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { result: value };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseToolArguments(
  value: string,
  toolCallId: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new ADKJSProtocolError(
      `Tool call ${toolCallId} has invalid JSON arguments: ${errorMessage(error)}`,
      "INVALID_TOOL_ARGUMENTS",
    );
  }
  if (!isRecord(parsed)) {
    throw new ADKJSProtocolError(
      `Tool call ${toolCallId} arguments must decode to a JSON object.`,
      "INVALID_TOOL_ARGUMENTS",
    );
  }
  return parsed;
}

function findToolName(
  messages: readonly Message[],
  toolCallId: string,
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") {
      continue;
    }
    const call = message.toolCalls?.find(
      (candidate) => candidate.id === toolCallId,
    );
    if (call) {
      return call.function.name;
    }
  }
  return undefined;
}

/**
 * `PartSource` -> ADK part: `data` becomes `inlineData`, `url` and `file`
 * become `fileData`. Returns `undefined` for a `file` handle whose `provider`
 * is set to anything but `google` — ADK cannot resolve another provider's
 * handle, and an unresolvable one is skipped rather than failing the run.
 */
function mediaSource(
  source: PartSource,
  context: string,
  logger?: ADKJSLogger,
): AdkPart | undefined {
  if (source.type === "data") {
    return { inlineData: { data: source.value, mimeType: source.mimeType } };
  }

  if (
    source.type === "file" &&
    source.provider &&
    source.provider !== "google"
  ) {
    logger?.warn(
      `Skipping a ${source.provider} file handle on ${context}: Google ADK cannot resolve another provider's handle.`,
    );
    return undefined;
  }

  return {
    fileData: {
      fileUri: source.value,
      ...(source.mimeType ? { mimeType: source.mimeType } : {}),
    },
  };
}

/** `ContentPart[]` -> `AdkPart[]`; unusable media parts are dropped. */
function contentParts(
  parts: readonly ContentPart[],
  context: string,
  logger?: ADKJSLogger,
): AdkPart[] {
  return parts.flatMap((part): AdkPart[] => {
    if (part.type === "text") {
      return [{ text: part.text }];
    }
    const converted = mediaSource(part.source, context, logger);
    return converted ? [converted] : [];
  });
}

function userParts(message: UserMessage, logger?: ADKJSLogger): AdkPart[] {
  if (typeof message.content === "string") {
    return [{ text: message.content }];
  }
  return contentParts(message.content, `message ${message.id}`, logger);
}

/**
 * `ToolMessage` -> `FunctionResponse` fields. 1.0 widened `content` to
 * `string | ContentPart[]`: text parts are joined and JSON-parsed into
 * `response`, media parts go to `parts`. `message.error` is merged into
 * `response` — `TOOL_CALL_RESULT` has no `error` field, `ToolMessage` does.
 */
function toolResponse(
  message: ToolMessage,
  logger?: ADKJSLogger,
): { response: Record<string, unknown>; parts?: AdkPart[] } {
  const context = `tool result ${message.toolCallId}`;
  let parsed: unknown;
  let media: AdkPart[] = [];

  if (typeof message.content === "string") {
    parsed = parseJson(message.content);
  } else {
    const converted = contentParts(message.content, context, logger);
    const text = converted
      .filter((part) => typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    media = converted.filter((part) => typeof part.text !== "string");
    parsed = text ? parseJson(text) : {};
  }

  const record = asRecord(parsed);
  return {
    response: message.error ? { ...record, error: message.error } : record,
    ...(media.length > 0 ? { parts: media } : {}),
  };
}

function modelMessageAuthor(
  message: Message,
  fallback: string,
  allowedAuthors?: ReadonlySet<string>,
): string {
  const name = "name" in message ? message.name : undefined;
  const author = name || fallback;
  if (name && allowedAuthors && !allowedAuthors.has(name)) {
    throw new ADKJSProtocolError(
      `AG-UI message ${message.id} names unknown Google ADK agent ${name}.`,
      "UNKNOWN_AGENT_AUTHOR",
    );
  }
  return author;
}

/** Convert one AG-UI history/input message into ADK's GenAI content model. */
export function convertMessage(
  message: Message,
  messages: readonly Message[],
  modelAuthor: string,
  allowedModelAuthors?: ReadonlySet<string>,
  logger?: ADKJSLogger,
): ConvertedMessage | undefined {
  switch (message.role) {
    case "user":
      return {
        author: "user",
        content: { role: "user", parts: userParts(message, logger) },
      };

    case "assistant": {
      const parts: AdkPart[] = [];
      if (message.content) {
        parts.push({ text: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        parts.push({
          functionCall: {
            id: call.id,
            name: call.function.name,
            args: parseToolArguments(call.function.arguments, call.id),
          },
          ...(call.encryptedValue
            ? { thoughtSignature: call.encryptedValue }
            : {}),
        });
      }
      return {
        author: modelMessageAuthor(message, modelAuthor, allowedModelAuthors),
        content: { role: "model", parts },
      };
    }

    case "tool": {
      const name = findToolName(messages, message.toolCallId);
      if (!name) {
        throw new ADKJSProtocolError(
          `Cannot resolve ADK tool name for tool call ${message.toolCallId}.`,
          "UNKNOWN_TOOL_CALL",
        );
      }
      return {
        author: "user",
        content: {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: message.toolCallId,
                name,
                ...toolResponse(message, logger),
              },
            },
          ],
        },
      };
    }

    case "system":
    case "developer":
      throw new ADKJSProtocolError(
        `Dynamic ${message.role} messages cannot be represented faithfully by Google ADK. Configure instructions on the ADK Agent instead.`,
        "UNSUPPORTED_MESSAGE_ROLE",
      );

    case "reasoning":
      return {
        author: modelMessageAuthor(message, modelAuthor, allowedModelAuthors),
        content: {
          role: "model",
          parts: [
            {
              text: message.content,
              thought: true,
              ...(message.encryptedValue
                ? { thoughtSignature: message.encryptedValue }
                : {}),
            },
          ],
        },
      };

    case "activity":
      // Activity messages describe UI/runtime activity and must not be injected
      // into the model conversation as fabricated assistant text.
      return undefined;
  }
}
