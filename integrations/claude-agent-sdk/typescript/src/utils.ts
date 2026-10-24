/**
 * Utility functions for Claude Agent SDK adapter.
 *
 * Helper functions for message processing, tool conversion, and prompt building.
 */

import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type {
  RunAgentInput,
  Tool,
  AssistantMessage,
  ToolCall,
  Message,
  InputContent,
  ToolMessage,
  ContentPart,
} from "@ag-ui/core";
import type {
  SDKAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import type { BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  ALLOWED_FORWARDED_PROPS,
  STATE_MANAGEMENT_TOOL_NAME,
  STATE_MANAGEMENT_TOOL_FULL_NAME,
} from "./config";

/**
 * Check if a state value is meaningful (non-null, non-undefined, non-empty object).
 *
 * In Python, `{}` is falsy so `if state:` naturally skips empty objects.
 * In JavaScript, `{}` is truthy, so we need an explicit check.
 * CopilotKit runtime sends `state: {}` even for agents that don't use useCoAgent.
 */
export function hasState(state: unknown): boolean {
  if (state == null) return false;
  if (typeof state !== "object") return true;
  if (Array.isArray(state)) return state.length > 0;
  // Empty objects ({}) count as "has state"
  return true;
}

/**
 * Extract tool names from AG-UI tool definitions.
 */
export function extractToolNames(tools: Tool[]): string[] {
  return tools.map((t) => t.name).filter(Boolean);
}

/** Only the adapter-owned MCP server maps to unprefixed frontend names. */
export function stripMcpPrefix(toolName: string): string {
  const prefix = "mcp__ag_ui__";
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
}

/**
 * Result from processing messages.
 */
export type ProcessMessagesResult = {
  userMessage: string | AsyncIterable<SDKUserMessage>;
  hasPendingToolResult: boolean;
};

const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function normalizedMediaType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType || undefined;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`[ClaudeAdapter] ${field} must be a non-empty string`);
  }
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`[ClaudeAdapter] ${field} must be a string`);
  }
  return value;
}

function requireRemoteUrl(value: unknown, field: string): string {
  const url = requireString(value, field);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`[ClaudeAdapter] ${field} must be a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`[ClaudeAdapter] ${field} must use http or https`);
  }
  return url;
}

function imageBlock(source: unknown, field: string): ContentBlockParam {
  if (!source || typeof source !== "object") {
    throw new Error(`[ClaudeAdapter] ${field} must be an object`);
  }
  const value = source as {
    type?: unknown;
    value?: unknown;
    mimeType?: unknown;
  };
  const mediaType = normalizedMediaType(value.mimeType);

  if (value.type === "data") {
    if (!mediaType || !SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) {
      throw new Error(
        `[ClaudeAdapter] ${field}.mimeType must be image/jpeg, image/png, image/gif, or image/webp`,
      );
    }
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType as
          | "image/jpeg"
          | "image/png"
          | "image/gif"
          | "image/webp",
        data: requireString(value.value, `${field}.value`),
      },
    };
  }

  if (value.type === "url") {
    if (mediaType && !SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) {
      throw new Error(
        `[ClaudeAdapter] ${field}.mimeType is not a supported image type`,
      );
    }
    return {
      type: "image",
      source: {
        type: "url",
        url: requireRemoteUrl(value.value, `${field}.value`),
      },
    };
  }

  throw new Error(`[ClaudeAdapter] ${field}.type must be data or url`);
}

function documentBlock(source: unknown, field: string): ContentBlockParam {
  if (!source || typeof source !== "object") {
    throw new Error(`[ClaudeAdapter] ${field} must be an object`);
  }
  const value = source as {
    type?: unknown;
    value?: unknown;
    mimeType?: unknown;
  };
  const mediaType = normalizedMediaType(value.mimeType);

  if (value.type === "data") {
    if (mediaType === "text/plain") {
      const encoded = requireString(value.value, `${field}.value`);
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          encoded,
        )
      )
        throw new Error(`${field}.value must be base64`);
      return {
        type: "document",
        source: {
          type: "text",
          media_type: "text/plain",
          data: new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.from(encoded, "base64"),
          ),
        },
      };
    }
    if (mediaType !== "application/pdf") {
      throw new Error(
        `[ClaudeAdapter] ${field}.mimeType must be application/pdf`,
      );
    }
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: requireString(value.value, `${field}.value`),
      },
    };
  }

  if (value.type === "url") {
    if (mediaType && mediaType !== "application/pdf") {
      throw new Error(
        `[ClaudeAdapter] ${field}.mimeType must be application/pdf when provided`,
      );
    }
    return {
      type: "document",
      source: {
        type: "url",
        url: requireRemoteUrl(value.value, `${field}.value`),
      },
    };
  }

  throw new Error(`[ClaudeAdapter] ${field}.type must be data or url`);
}

// Older callers can still send binary blocks to this adapter even though the
// canonical protocol now uses image/document content with an explicit source.
type LegacyBinaryContent = {
  type: "binary";
  mimeType: string;
  data?: string;
  url?: string;
  id?: string;
};

function legacyBinaryBlock(
  block: LegacyBinaryContent,
  index: number,
): ContentBlockParam {
  const mediaType = normalizedMediaType(block.mimeType);
  const source = block.data
    ? { type: "data", value: block.data, mimeType: mediaType }
    : block.url
      ? { type: "url", value: block.url, mimeType: mediaType }
      : undefined;

  if (!source) {
    throw new Error(
      `[ClaudeAdapter] content[${index}] uses an opaque file id, which the Claude Agent SDK adapter cannot resolve`,
    );
  }
  if (mediaType && SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) {
    return imageBlock(source, `content[${index}]`);
  }
  if (mediaType === "application/pdf") {
    return documentBlock(source, `content[${index}]`);
  }
  throw new Error(
    `[ClaudeAdapter] content[${index}].mimeType is not supported`,
  );
}

/**
 * Whether a media part's source is the `file` arm: a handle the model provider
 * issued for bytes it already holds. Read defensively, because the source
 * arrives off the wire and nothing validates it at this boundary.
 */
function isFileSource(source: unknown): boolean {
  return (
    !!source &&
    typeof source === "object" &&
    (source as { type?: unknown }).type === "file"
  );
}

function convertContentBlock(
  block: InputContent | LegacyBinaryContent,
  index: number,
): ContentBlockParam | undefined {
  if (!block || typeof block !== "object" || typeof block.type !== "string") {
    throw new Error(
      `[ClaudeAdapter] content[${index}] must be a typed content object`,
    );
  }

  switch (block.type) {
    case "text": {
      const text = requireText(block.text, `content[${index}].text`);
      if (text.trim().length === 0) return undefined;
      return {
        type: "text",
        text,
      };
    }
    case "image":
    case "document": {
      // A `file` source names bytes already held by a model provider, under a
      // handle only that provider can resolve — it is NOT a URL and MUST NOT be
      // fetched or parsed. This adapter has no provider-handle path in 1.0, and
      // the specification's rule for a part a producer cannot use is to skip it
      // and continue: "A producer that cannot use a content part MUST NOT fail
      // the run because of it; it skips the part and continues, and SHOULD
      // warn." Caught HERE rather than inside the block builders, so their
      // `must be data or url` throws keep meaning what they say — a source that
      // is genuinely malformed, not one this adapter simply cannot carry.
      if (isFileSource(block.source)) {
        console.warn(
          `[ClaudeAdapter] Dropping content[${index}] of type ${block.type}: a provider file handle cannot be forwarded by this adapter`,
        );
        return undefined;
      }
      if (block.type === "image")
        return imageBlock(block.source, `content[${index}].source`);
      const document = documentBlock(block.source, `content[${index}].source`);
      const filename = block.metadata?.filename;
      return typeof filename === "string"
        ? ({ ...document, title: filename } as ContentBlockParam)
        : document;
    }
    case "binary":
      return legacyBinaryBlock(block, index);
    case "audio":
    case "video":
      // Claude takes neither audio nor video input. Per the spec a producer
      // that cannot use a content part MUST NOT fail the run because of it:
      // it skips the part and SHOULD warn.
      console.warn(
        `[ClaudeAdapter] Dropping content[${index}] of type ${block.type}: Claude does not accept ${block.type} input`,
      );
      return undefined;
    default:
      throw new Error(
        `[ClaudeAdapter] content[${index}] has an unsupported type`,
      );
  }
}

async function* structuredUserMessage(
  content: ContentBlockParam[],
  sessionId: string,
): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

function emptyToolResultPrompt(
  messages: RunAgentInput["messages"],
  toolCallId: string | undefined,
): string {
  const id = toolCallId ?? "unknown";
  let toolName: string | undefined;
  for (const msg of messages) {
    const toolCalls = (msg as { toolCalls?: ToolCall[] }).toolCalls;
    const match = toolCalls?.find((call) => call.id === toolCallId);
    if (match) toolName = match.function.name;
  }
  return toolName
    ? `The client completed the "${toolName}" tool call (id ${id}) and returned no result.`
    : `The client completed tool call ${id} and returned no result.`;
}

/**
 * Process and validate all messages from RunAgentInput.
 *
 * Similar to AWS Strands pattern: validates full message history even though
 * Claude SDK manages conversation via session_id.
 */
/** User input after the deferred assistant call is new; earlier prompts are history.
 * A request containing only new messages has no assistant boundary.
 */
export function recoveryUserMessages(
  input: RunAgentInput,
  pendingId: string,
): Message[] {
  const messages = input.messages ?? [];
  let boundary = messages.findIndex(
    (message) =>
      message.role === "assistant" &&
      message.toolCalls?.some((call) => call.id === pendingId),
  );
  if (boundary < 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        boundary = i;
        break;
      }
    }
  }
  return messages
    .slice(boundary + 1)
    .filter((message) => message.role === "user");
}

export function processMessages(input: RunAgentInput): ProcessMessagesResult {
  const messages = input.messages ?? [];

  // Check if last message is a tool result (for re-submission handling)
  let hasPendingToolResult = false;
  if (messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === "tool") {
      hasPendingToolResult = true;
      console.debug(
        `[ClaudeAdapter] Pending tool result detected: toolCallId=${(lastMsg as { toolCallId?: string }).toolCallId ?? "unknown"}, threadId=${input.threadId}`,
      );
    }
  }

  // Log message counts for debugging
  console.debug(
    `[ClaudeAdapter] Processing ${messages.length} messages for threadId=${input.threadId}`,
  );

  // Extract content from the LAST message (any role - user, tool, or assistant)
  // Claude SDK manages conversation history via session_id, we just need the latest input
  let userMessage: string | AsyncIterable<SDKUserMessage> = "";
  let hasUserContent = false;
  if (messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    const content = lastMsg.content;

    if (typeof content === "string") {
      userMessage = content;
      hasUserContent = content.length > 0;
    } else if (Array.isArray(content)) {
      const blocks: ContentBlockParam[] = [];
      content.forEach((block, index) => {
        const converted = convertContentBlock(block, index);
        if (converted) blocks.push(converted);
      });
      if (blocks.length > 0) {
        userMessage = structuredUserMessage(
          blocks,
          input.threadId ?? "default",
        );
        hasUserContent = true;
      }
    }

    // A display-only frontend tool (for example CopilotKit's useComponent)
    // returns an empty result, and the automatic follow-up then resumes the
    // session with it. The model API rejects an empty user turn, so describe
    // the completed call instead. The session already holds the stub
    // tool_result from the ag_ui MCP server, so this must be plain text.
    if (
      lastMsg.role === "tool" &&
      (!hasUserContent ||
        (typeof userMessage === "string" && userMessage.trim() === ""))
    ) {
      userMessage = emptyToolResultPrompt(
        messages,
        (lastMsg as { toolCallId?: string }).toolCallId,
      );
      hasUserContent = true;
    }
  }

  if (!hasUserContent) {
    console.warn(
      `[ClaudeAdapter] No user message found in ${messages.length} messages`,
    );
  }

  return { userMessage, hasPendingToolResult };
}

/**
 * Build state and context addendum for injection into the system prompt.
 *
 * Returns the formatted text block describing current state and application
 * context, or an empty string if neither is present.
 *
 * This keeps state/context in the system prompt (where it belongs) rather
 * than polluting the user message.
 */
export function buildStateContextAddendum(input: RunAgentInput): string {
  const parts: string[] = [];

  // Add context if provided
  if (input.context && input.context.length > 0) {
    parts.push("## Context from the application");
    for (const ctx of input.context) {
      parts.push(`- ${ctx.description}: ${ctx.value}`);
    }
    parts.push("");
  }

  // Add current state if provided (skip empty objects)
  if (hasState(input.state)) {
    parts.push("## Current Shared State");
    parts.push("This state is shared with the frontend UI and can be updated.");
    try {
      const stateJson = JSON.stringify(input.state, null, 2);
      parts.push(`\`\`\`json\n${stateJson}\n\`\`\``);
    } catch {
      parts.push(`State: ${String(input.state)}`);
    }
    parts.push("");
    parts.push(
      "To update this state, use the `ag_ui_update_state` tool with your changes.",
    );
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * Convert a basic JSON Schema type string to a Zod type.
 * Falls back to z.any() for complex or unknown types.
 */
function jsonSchemaTypeToZod(prop: Record<string, unknown>): z.ZodTypeAny {
  const type = prop.type as string | undefined;
  const description = prop.description as string | undefined;

  let zodType: z.ZodTypeAny;

  switch (type) {
    case "string":
      zodType = prop.enum
        ? z.enum(prop.enum as [string, ...string[]])
        : z.string();
      break;
    case "number":
    case "integer":
      zodType = z.number();
      break;
    case "boolean":
      zodType = z.boolean();
      break;
    case "array":
      zodType = z.array(z.any());
      break;
    case "object":
      zodType = z.record(z.string(), z.any());
      break;
    default:
      zodType = z.any();
  }

  if (description) {
    zodType = zodType.describe(description);
  }

  return zodType;
}

/**
 * Convert a JSON Schema properties object to a Zod raw shape.
 * This is a pragmatic conversion for stub tools -- handles basic types
 * with z.any() fallback for complex nested schemas.
 */
function jsonSchemaToZodShape(
  schema: Record<string, unknown>,
): Record<string, z.ZodTypeAny> {
  const properties = (schema.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const required = (schema.required ?? []) as string[];
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let zodType = jsonSchemaTypeToZod(prop);
    if (!required.includes(key)) {
      zodType = zodType.optional();
    }
    shape[key] = zodType;
  }

  // If no properties were defined, use a catch-all
  if (Object.keys(shape).length === 0) {
    shape["args"] = z.any().optional().describe("Tool arguments");
  }

  return shape;
}

/**
 * Convert an AG-UI tool definition to a Claude SDK MCP tool.
 *
 * Creates a proxy that returns the matched client result to the original SDK call.
 */
export type FrontendToolResult =
  | ToolMessage["content"]
  | Pick<ToolMessage, "content" | "error">;

export function convertAguiToolToClaudeSdk(
  toolDef: Tool,
  resolveFrontendResult?: (
    name: string,
    input: Record<string, unknown>,
  ) => FrontendToolResult | Promise<FrontendToolResult>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const toolName = toolDef.name ?? "unknown";
  const toolDescription = toolDef.description ?? "";
  const toolParameters = (toolDef.parameters ?? {}) as Record<string, unknown>;

  // Convert JSON Schema to Zod shape for the TS SDK's tool() function
  const zodShape = jsonSchemaToZodShape(toolParameters);

  // Complete only with the matched result supplied by the recovery lifecycle.
  return tool(toolName, toolDescription, zodShape, async (args) => {
    if (!resolveFrontendResult) {
      throw new Error(
        "Frontend tool result requires a matched deferred tool call",
      );
    }
    const result = await resolveFrontendResult(toolName, args);
    const envelope: Pick<ToolMessage, "content" | "error"> =
      typeof result === "string" || Array.isArray(result)
        ? { content: result }
        : result;
    const content = frontendResultBlocks(envelope.content);
    const error = envelope.error;
    if (error) {
      if (
        content.length === 1 &&
        content[0].type === "text" &&
        content[0].text === ""
      )
        content.pop();
      if (
        !content.some((block) => block.type === "text" && block.text === error)
      )
        content.push({ type: "text", text: error });
    }
    return { content, ...(error != null ? { isError: true } : {}) };
  });
}

/**
 * Create ag_ui_update_state tool for bidirectional state sync.
 *
 * This tool allows Claude to update the shared application state,
 * which is then emitted to the client via STATE_SNAPSHOT events.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createStateManagementTool(): any {
  return tool(
    "ag_ui_update_state",
    "Update the shared application state. Use this to persist changes that should be visible in the UI. Pass a partial object: keys are shallow-merged into current state; nested values replace existing values. The emitted snapshot contains the full merged state.",
    { state_updates: z.record(z.string(), z.unknown()) },
    async () => ({
      content: [{ type: "text" as const, text: "State updated successfully" }],
    }),
  );
}

/**
 * Apply forwardedProps as per-run Claude SDK option overrides.
 *
 * Only whitelisted keys are applied for security. forwardedProps enables
 * runtime control (model selection, limits, session control) without
 * changing agent identity or security boundaries.
 */
export function applyForwardedProps(
  forwardedProps: Record<string, unknown> | undefined,
  mergedOptions: Record<string, unknown>,
  allowedKeys: Set<string> = ALLOWED_FORWARDED_PROPS,
): Record<string, unknown> {
  if (
    !forwardedProps ||
    typeof forwardedProps !== "object" ||
    Array.isArray(forwardedProps)
  ) {
    return mergedOptions;
  }

  let appliedCount = 0;
  for (const [key, value] of Object.entries(forwardedProps)) {
    if (allowedKeys.has(key) && value != null) {
      mergedOptions[key] = value;
      appliedCount++;
      console.debug(
        `[ClaudeAdapter] Applied forwarded_prop: ${key} = ${String(value)}`,
      );
    } else if (!allowedKeys.has(key)) {
      console.warn(
        `[ClaudeAdapter] Ignoring non-whitelisted forwarded_prop: ${key}. See ALLOWED_FORWARDED_PROPS for supported keys.`,
      );
    }
  }

  if (appliedCount > 0) {
    console.debug(
      `[ClaudeAdapter] Applied ${appliedCount} forwarded_props as option overrides`,
    );
  }

  return mergedOptions;
}

/**
 * Check whether a tool name is the internal state management tool.
 */
export function isStateManagementTool(name: string): boolean {
  return (
    name === STATE_MANAGEMENT_TOOL_NAME ||
    name === STATE_MANAGEMENT_TOOL_FULL_NAME
  );
}

/**
 * Convert a complete Claude SDK AssistantMessage into an AG-UI AssistantMessage.
 *
 * Extracts text from TextBlocks and builds ToolCall objects from ToolUseBlocks.
 * Filters out internal state management tool calls and reasoning blocks since
 * they are not part of the user-visible conversation history.
 *
 * @returns AG-UI AssistantMessage, or null if the message has no user-visible content.
 */
export function buildAguiAssistantMessage(
  sdkMessage: SDKAssistantMessage,
  messageId: string,
): AssistantMessage | null {
  const contentBlocks = sdkMessage.message?.content ?? [];

  let textContent = "";
  const toolCalls: ToolCall[] = [];

  for (const block of contentBlocks) {
    if (block.type === "text") {
      textContent += (block as { text: string }).text;
    } else if (block.type === "tool_use") {
      const toolBlock = block as BetaToolUseBlock;
      const rawName = toolBlock.name ?? "unknown";

      // Skip internal state management tool — not part of conversation history
      if (isStateManagementTool(rawName)) {
        continue;
      }

      toolCalls.push({
        id: toolBlock.id,
        type: "function" as const,
        function: {
          name: stripMcpPrefix(rawName),
          arguments: JSON.stringify(toolBlock.input ?? {}),
        },
      });
    }
    // Reasoning/ThinkingBlocks are intentionally skipped — not conversation history
  }

  // Nothing user-visible (e.g. reasoning-only message)
  if (!textContent && toolCalls.length === 0) {
    return null;
  }

  const msg: AssistantMessage = {
    id: messageId,
    role: "assistant" as const,
  };

  if (textContent) {
    msg.content = textContent;
  }

  if (toolCalls.length > 0) {
    msg.toolCalls = toolCalls;
  }

  return msg;
}

/** Preserve rich blocks as JSON; unwrap only a single plain text block. */
export function serializeToolResult(content: unknown, isError = false): string {
  let value = content ?? "";
  if (Array.isArray(value) && value.length === 1) {
    const block = value[0];
    if (
      block?.type === "text" &&
      typeof block.text === "string" &&
      Object.keys(block).every((key) => key === "type" || key === "text")
    ) {
      value = block.text;
    }
  }
  if (isError) {
    let parsed = value;
    if (typeof value === "string") {
      try {
        parsed = JSON.parse(value);
      } catch {
        /* Plain text remains text. */
      }
    }
    value =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ...parsed, error: true }
        : { error: true, content: value };
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function buildAguiToolMessage(
  toolUseId: string,
  content: unknown,
  isError = false,
): ToolMessage {
  return {
    id: `${toolUseId}-result`,
    role: "tool",
    content: nativeToolContent(content, isError),
    toolCallId: toolUseId,
    ...(isError ? { error: "Tool execution failed" } : {}),
  };
}

/** Tool updates shallow-merge object keys; run input.state is a full snapshot. */
export function mergeStateUpdate(
  currentState: unknown,
  input: Record<string, unknown>,
): Record<string, unknown> {
  let updates = Object.prototype.hasOwnProperty.call(input, "state_updates")
    ? input.state_updates
    : input;
  if (typeof updates === "string") updates = JSON.parse(updates);
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    throw new Error("state_updates must be an object");
  }
  const prior =
    currentState &&
    typeof currentState === "object" &&
    !Array.isArray(currentState)
      ? currentState
      : {};
  return { ...prior, ...updates };
}

/** Preserve original blocks alongside the standard AG-UI projection. */
export function nativeToolContent(
  content: unknown,
  isError = false,
): ToolMessage["content"] {
  if (
    !Array.isArray(content) ||
    (content.length === 1 &&
      content[0]?.type === "text" &&
      Object.keys(content[0]).every((k) => k === "type" || k === "text"))
  ) {
    return serializeToolResult(content, isError);
  }
  return content.map((block): ContentPart => {
    const metadata = { claude: { block, isError } };
    if (block?.type === "text" && typeof block.text === "string")
      return { type: "text", text: block.text, metadata };
    const source = block?.source;
    if (["image", "audio", "video", "document"].includes(block?.type)) {
      if (
        source?.type === "base64" &&
        typeof source.data === "string" &&
        typeof source.media_type === "string"
      ) {
        return {
          type: block.type,
          source: {
            type: "data",
            value: source.data,
            mimeType: source.media_type,
          },
          metadata,
        };
      }
      if (source?.type === "url" && typeof source.url === "string") {
        return {
          type: block.type,
          source: {
            type: "url",
            value: source.url,
            ...(source.media_type ? { mimeType: source.media_type } : {}),
          },
          metadata,
        };
      }
      if (
        typeof block.data === "string" &&
        typeof block.mimeType === "string"
      ) {
        return {
          type: block.type,
          source: { type: "data", value: block.data, mimeType: block.mimeType },
          metadata,
        };
      }
    }
    // The raw payload survives even when AG-UI has no equivalent part type.
    return {
      type: "text",
      text: JSON.stringify(block),
      metadata: {
        claude: { block, isError, unsupportedType: block?.type ?? "unknown" },
      },
    };
  });
}

/** Convert a matched frontend result to MCP content without a placeholder. */
export function frontendResultBlocks(result: ToolMessage["content"]) {
  if (typeof result === "string")
    return [{ type: "text" as const, text: result }];
  return result.map((part) => {
    if (part.type === "text") return { type: "text" as const, text: part.text };
    const source = part.source;
    if (
      source.type === "data" &&
      (part.type === "image" || part.type === "audio")
    ) {
      return { type: part.type, data: source.value, mimeType: source.mimeType };
    }
    if (source.type === "url") {
      return {
        type: "resource_link" as const,
        uri: source.value,
        name: part.metadata?.filename ?? source.value,
        ...(source.mimeType ? { mimeType: source.mimeType } : {}),
      };
    }
    if (source.type === "data") {
      return {
        type: "resource" as const,
        resource: {
          uri: `data:${source.mimeType};base64,${source.value}`,
          mimeType: source.mimeType,
          blob: source.value,
        },
      };
    }
    throw new Error(
      `Cannot return unresolved provider file ${source.value} as an SDK tool result`,
    );
  });
}

export function unsupportedInputParts(input: RunAgentInput) {
  const message = input.messages?.[input.messages.length - 1];
  if (!message || !Array.isArray(message.content)) return [];
  return message.content.flatMap((part, index) => {
    const reason =
      part.type === "audio" || part.type === "video"
        ? `Claude does not accept ${part.type} input`
        : "source" in part && part.source.type === "file"
          ? "Provider file handles cannot be resolved by this adapter"
          : undefined;
    return reason
      ? [
          {
            messageId: message.id,
            contentIndex: index,
            contentType: part.type,
            reason,
          },
        ]
      : [];
  });
}
