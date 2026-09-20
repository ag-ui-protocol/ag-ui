import {
  contentHasMedia,
  contentToText,
  type ContentPart,
  type Message,
  type PartSource,
} from "@ag-ui/core";
import type { ModelMessage, TextPart, ImagePart, FilePart, ToolResultPart } from "ai";

const LOG_PREFIX = "[convertMessagesToVercelAISDKMessages]";

function warn(message: string): void {
  console.warn(`${LOG_PREFIX} ${message}`);
}

// Everything but a text part: the parts that carry a source.
type MediaPart = Exclude<ContentPart, { type: "text" }>;

// The top-level IANA segment for each media part, used when the producer did
// not say what the bytes are. A file part must declare a media type, and a
// top-level segment is the useful thing to declare: it fails the SDK's
// `isFullMediaType` check, so the SDK adopts the Content-Type it sees when it
// downloads the file. "application/octet-stream" reads as a full type instead,
// which blocks that sniffing and which Anthropic rejects outright.
const TOP_LEVEL_MEDIA_TYPE: Record<MediaPart["type"], string> = {
  image: "image",
  audio: "audio",
  video: "video",
  document: "application",
};

// A media part's bytes as something an AI SDK prompt part can carry: a data
// URL or a plain URL.
function mediaSourceToUrl(source: PartSource): string | undefined {
  switch (source.type) {
    case "data":
      // No bytes, or bytes with no media type, would build a data URL that no
      // provider can read ("data:undefined;base64,"). mimeType is required by
      // the schema; the check only guards a producer that ignored it.
      if (!source.value || !source.mimeType) return undefined;
      return `data:${source.mimeType};base64,${source.value}`;
    case "url":
      // An empty URL is as unusable as no URL at all.
      return source.value || undefined;
    case "file":
      // A `file` source is a handle the provider issued. AI SDK v7 can carry
      // one — as a ProviderReference (`{ [provider]: id }`) on an image or
      // file part — but it resolves the reference against the provider of the
      // model being called and throws NoSuchProviderReferenceError when the
      // two disagree. This converter is handed messages, never the model they
      // are being converted for, so it cannot tell whether the handle matches;
      // the part is dropped here (and in tool results, see
      // mediaSourceToFileData). Forwarding on a provider match is a follow-up
      // that threads the configured provider id through.
      return undefined;
    default: {
      const _exhaustive: never = source;
      return undefined;
    }
  }
}

// The URL for a media part, or undefined with a warning when its source
// carries nothing the AI SDK can send.
function resolveMediaSource(part: MediaPart): string | undefined {
  const url = mediaSourceToUrl(part.source);
  if (url === undefined) warnDroppedPart(part.type, part.source.type);
  return url;
}

function warnDroppedPart(partType: ContentPart["type"], sourceType: PartSource["type"]): void {
  warn(`Dropping ${partType} part: nothing in its ${sourceType} source can be sent to the AI SDK`);
}

// Part metadata is unconstrained by the protocol, so a filename is only used
// when the producer actually sent one as a string.
function filenameOf(part: MediaPart): string | undefined {
  const filename = part.metadata?.filename;
  return typeof filename === "string" ? filename : undefined;
}

function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}

type UserPart = TextPart | ImagePart | FilePart;

// The user message content union from AG-UI (string | ContentPart[]), derived
// from the Message union rather than re-declared here.
type UserContent = Extract<Message, { role: "user" }>["content"];

// The converted content, or undefined when nothing survives the conversion:
// providers reject an empty turn — Anthropic rejects both `""` and `[]` — so
// the caller omits the message rather than sending empty content.
function toUserContent(content: UserContent): string | UserPart[] | undefined {
  if (!content) return undefined;
  if (typeof content === "string") return content;

  // A non-empty array converts to a parts array, even when every part is
  // text and even for a single part: joining text parts would alter the user's
  // input by introducing separators and losing part boundaries. Text is
  // user-provided and passes through verbatim, with no trimming and no
  // dropping of whitespace-only parts.
  const parts: UserPart[] = [];
  for (const part of content) {
    switch (part.type) {
      case "text":
        parts.push({ type: "text", text: part.text });
        break;
      case "image": {
        const url = resolveMediaSource(part);
        if (url === undefined) break;
        // OpenAI and Anthropic reject a remote image they cannot type, so a
        // known media type travels with the URL. It is optional on an image
        // part, so an unknown one is simply left out.
        const mediaType = part.source.mimeType;
        parts.push({ type: "image", image: url, ...(mediaType ? { mediaType } : {}) });
        break;
      }
      case "audio":
      case "video":
      case "document": {
        const url = resolveMediaSource(part);
        if (url === undefined) break;
        const filename = filenameOf(part);
        parts.push({
          type: "file",
          data: url,
          mediaType: part.source.mimeType || TOP_LEVEL_MEDIA_TYPE[part.type],
          ...(filename === undefined ? {} : { filename }),
        });
        break;
      }
      default: {
        const _exhaustive: never = part;
        break;
      }
    }
  }
  return parts.length ? parts : undefined;
}

function lookupToolName(messages: Message[], toolCallId: string): string {
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const tc of msg.toolCalls ?? []) {
        if (tc.id === toolCallId) {
          return tc.function.name;
        }
      }
    }
  }
  return "unknown";
}

type ToolMessage = Extract<Message, { role: "tool" }>;
type ToolResultOutput = ToolResultPart["output"];
// The `content` output variant's items, and the tagged file data one of them
// carries — derived from the SDK's own types rather than re-declared here.
type ToolContentValue = Extract<ToolResultOutput, { type: "content" }>["value"];
type ToolFileData = Extract<ToolContentValue[number], { type: "file" }>["data"];

const NO_RESULT_REASON = "No result was provided for this tool call.";

// A media part's bytes in the tagged shape a tool result's file item takes.
// Mirrors mediaSourceToUrl, including dropping provider file handles.
function mediaSourceToFileData(source: PartSource): ToolFileData | undefined {
  switch (source.type) {
    case "data":
      return source.value ? { type: "data", data: source.value } : undefined;
    case "url": {
      if (!source.value) return undefined;
      // The tagged url shape takes a parsed URL, so a value that is not one —
      // a bare path, say — has nothing to hand the SDK.
      try {
        return { type: "url", url: new URL(source.value) };
      } catch {
        return undefined;
      }
    }
    case "file":
      // Same rule as prompt parts (see mediaSourceToUrl): the SDK could carry
      // the handle as a provider reference, but a model from a different
      // provider throws NoSuchProviderReferenceError on it and kills the run.
      // Without the configured provider the converter cannot tell a usable
      // handle from a fatal one, so it is dropped — forwarding on a provider
      // match is the follow-up.
      return undefined;
    default: {
      const _exhaustive: never = source;
      return undefined;
    }
  }
}

// Tool result parts as the SDK's `content` output, so media survives the
// conversion instead of flattening to text and disappearing.
function toToolContentValue(content: ContentPart[]): ToolContentValue {
  const value: ToolContentValue = [];
  for (const part of content) {
    if (part.type === "text") {
      value.push({ type: "text", text: part.text });
      continue;
    }
    const data = mediaSourceToFileData(part.source);
    if (data === undefined) {
      warnDroppedPart(part.type, part.source.type);
      continue;
    }
    const filename = filenameOf(part);
    value.push({
      type: "file",
      data,
      mediaType: part.source.mimeType || TOP_LEVEL_MEDIA_TYPE[part.type],
      ...(filename === undefined ? {} : { filename }),
    });
  }
  return value;
}

function toToolOutput(message: ToolMessage): ToolResultOutput {
  const { content, error, toolCallId } = message;
  const hasMedia = contentHasMedia(content);
  const text = contentToText(content);

  if (error !== undefined) {
    // Preserve failure signaling: providers map error-text to their native
    // is_error flag, so the model can distinguish a failed or denied call from
    // a tool that returned this text.
    if (hasMedia) {
      warn(
        `Tool result for ${toolCallId} failed and carries non-text part(s): no error output can carry them, so they are dropped`,
      );
    }
    // A failure whose content is empty — or entirely media — would otherwise
    // reach the model as an empty error; the message's own reason says more.
    return { type: "error-text", value: text || error };
  }

  if (typeof content !== "string" && hasMedia) {
    warn(
      `Tool result for ${toolCallId} carries non-text part(s): forwarding them through the SDK's content output, which a provider built against an older spec may drop`,
    );
    return { type: "content", value: toToolContentValue(content) };
  }

  return { type: "text", value: text };
}

// The assistant content parts union from the AI SDK (TextPart | FilePart |
// ReasoningPart | ToolCallPart | ...), without re-declaring the shapes here.
type AssistantParts = Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string>;

export function convertMessagesToVercelAISDKMessages(messages: Message[]): ModelMessage[] {
  const result: ModelMessage[] = [];
  // Which tool calls the history answers, collected up front: an assistant
  // message may make a call that a later message resolves.
  const answeredToolCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") answeredToolCallIds.add(message.toolCallId);
  }
  // AG-UI persists reasoning as standalone messages preceding their assistant
  // message. Buffer them and fold them into that assistant message as AI SDK
  // reasoning parts — for Anthropic extended thinking, the signed thinking
  // block (encryptedValue) must be replayed with the assistant turn or
  // tool-use continuations are rejected.
  let pendingReasoning: AssistantParts = [];

  for (const message of messages) {
    switch (message.role) {
      case "developer":
      case "system":
        pendingReasoning = [];
        result.push({ role: "system", content: message.content });
        break;
      case "user": {
        pendingReasoning = [];
        const content = toUserContent(message.content);
        if (content === undefined) {
          warn(`Omitting user message ${message.id}: it carries nothing the AI SDK can send`);
          break;
        }
        result.push({ role: "user", content });
        break;
      }
      case "assistant": {
        const parts: AssistantParts = [...pendingReasoning];
        pendingReasoning = [];
        if (message.content) {
          parts.push({ type: "text", text: message.content });
        }
        const unanswered: ToolResultPart[] = [];
        for (const tc of message.toolCalls ?? []) {
          parts.push({
            type: "tool-call",
            toolCallId: tc.id,
            toolName: tc.function.name,
            input: safeJsonParse(tc.function.arguments),
          });
          if (answeredToolCallIds.has(tc.id)) continue;
          warn(
            `No result for tool call ${tc.id}; sending an execution-denied result so the request stays well-formed`,
          );
          unanswered.push({
            type: "tool-result",
            toolCallId: tc.id,
            toolName: tc.function.name,
            output: { type: "execution-denied", reason: NO_RESULT_REASON },
          });
        }
        if (!parts.length) {
          warn(
            `Omitting assistant message ${message.id}: it carries no content, tool calls or reasoning`,
          );
          break;
        }
        result.push({ role: "assistant", content: parts });
        // The SDK refuses a prompt whose tool calls are not all answered
        // (MissingToolResultsError), so an orphaned call is closed out right
        // after the turn that made it — otherwise one abandoned call bricks
        // every later run in the conversation.
        if (unanswered.length) {
          result.push({ role: "tool", content: unanswered });
        }
        break;
      }
      case "tool":
        pendingReasoning = [];
        result.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: message.toolCallId,
              toolName: lookupToolName(messages, message.toolCallId),
              output: toToolOutput(message),
            },
          ],
        });
        break;
      case "activity":
        pendingReasoning = [];
        break;
      case "reasoning":
        pendingReasoning.push({
          type: "reasoning",
          text: message.content ?? "",
          ...(message.encryptedValue
            ? { providerOptions: { anthropic: { signature: message.encryptedValue } } }
            : {}),
        });
        break;
    }
  }

  return result;
}
