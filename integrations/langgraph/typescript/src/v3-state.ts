import type { State } from "./types";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * V3's ChatModelStream builds a new AIMessage instead of returning the V2
 * OpenAI chunk aggregate. Preserve the public snapshot representation for
 * text-only responses. The original checkpoint is never mutated, and native
 * stream metadata remains available on RAW events. Other providers and rich
 * content keep their native representation rather than losing information.
 */
export function v3StateToV2(
  values: State,
  streamedToolCallIds: ReadonlySet<string> = new Set(),
): State {
  if (!Array.isArray(values.messages)) return values;
  return {
    ...values,
    messages: values.messages.map((message) =>
      legacyOpenAIMessage(message, streamedToolCallIds),
    ),
  };
}

function legacyOpenAIMessage(
  raw: unknown,
  streamedToolCallIds: ReadonlySet<string>,
): unknown {
  if (!record(raw) || raw.type !== "ai") return raw;
  let message: Record<string, unknown> = raw;
  const metadata = message.response_metadata;
  const originalContent = message.content;
  const canonicalIds = new Set(
    Array.isArray(message.tool_calls)
      ? message.tool_calls
          .filter(record)
          .map((call) => call.id)
          .filter((id) => typeof id === "string" && id.length > 0)
      : [],
  );
  const content = Array.isArray(originalContent)
    ? originalContent.filter(
        (block) =>
          !record(block) ||
          block.type !== "tool_call" ||
          (!canonicalIds.has(block.id) &&
            !(
              typeof block.id === "string" && streamedToolCallIds.has(block.id)
            )),
      )
    : originalContent;
  if (
    Array.isArray(content) &&
    Array.isArray(originalContent) &&
    content.length !== originalContent.length
  ) {
    message = { ...message, content: content.length ? content : "" };
  }
  if (
    !record(metadata) ||
    (metadata.output_version !== "v1" && !record(message.usage_metadata)) ||
    metadata.model_provider !== "openai" ||
    !Array.isArray(content) ||
    !content.every(
      (block) =>
        record(block) &&
        block.type === "text" &&
        typeof block.text === "string" &&
        Object.keys(block).every(
          (key) => key === "type" || key === "text" || key === "index",
        ),
    ) ||
    (message.content_blocks !== undefined &&
      JSON.stringify(message.content_blocks) !==
        JSON.stringify(originalContent))
  )
    return message;

  // These fields describe the native V3 assembly, not the legacy provider
  // response. V2's chunk aggregate carries provider usage in their place.
  const { output_version, model_name, finish_reason, ...responseMetadata } =
    metadata;
  const usage = record(message.usage_metadata)
    ? message.usage_metadata
    : undefined;
  const providerUsage: Record<string, unknown> = {};
  if (usage) {
    providerUsage.prompt_tokens = usage.input_tokens;
    providerUsage.completion_tokens = usage.output_tokens;
    providerUsage.total_tokens = usage.total_tokens;
    const input = record(usage.input_token_details)
      ? usage.input_token_details
      : {};
    const output = record(usage.output_token_details)
      ? usage.output_token_details
      : {};
    const promptDetails: Record<string, unknown> = {};
    const completionDetails: Record<string, unknown> = {};
    if (input.cache_read !== undefined)
      promptDetails.cached_tokens = input.cache_read;
    if (input.audio !== undefined) promptDetails.audio_tokens = input.audio;
    if (output.reasoning !== undefined)
      completionDetails.reasoning_tokens = output.reasoning;
    if (output.audio !== undefined)
      completionDetails.audio_tokens = output.audio;
    if (Object.keys(promptDetails).length)
      providerUsage.prompt_tokens_details = promptDetails;
    if (Object.keys(completionDetails).length)
      providerUsage.completion_tokens_details = completionDetails;
  }
  const calls = Array.isArray(message.tool_calls)
    ? message.tool_calls.filter(record)
    : [];
  const callChunks = calls.map((call, index) => ({
    name: call.name,
    args: JSON.stringify(call.args),
    id: call.id,
    index,
    type: "tool_call_chunk",
  }));
  const additionalKwargs = record(message.additional_kwargs)
    ? message.additional_kwargs
    : {};
  const { content_blocks, ...legacy } = message;
  return {
    ...legacy,
    content: content.map((block) => block.text).join(""),
    response_metadata: {
      ...responseMetadata,
      usage: responseMetadata.usage ?? providerUsage,
    },
    additional_kwargs: calls.length
      ? {
          ...additionalKwargs,
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        }
      : additionalKwargs,
    tool_call_chunks: callChunks,
    ...(usage
      ? {
          usage_metadata: {
            input_token_details: {},
            output_token_details: {},
            ...usage,
          },
        }
      : {}),
  };
}
