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
export function v3StateToV2(values: State): State {
  if (!Array.isArray(values.messages)) return values;
  return { ...values, messages: values.messages.map(legacyOpenAIMessage) };
}

function legacyOpenAIMessage(message: unknown): unknown {
  if (!record(message) || message.type !== "ai") return message;
  const metadata = message.response_metadata;
  const content = message.content;
  if (
    !record(metadata) ||
    metadata.output_version !== "v1" ||
    metadata.model_provider !== "openai" ||
    !Array.isArray(content) ||
    !content.every(
      (block) =>
        record(block) &&
        block.type === "text" &&
        typeof block.text === "string" &&
        Object.keys(block).every((key) => key === "type" || key === "text"),
    ) ||
    (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) ||
    (message.content_blocks !== undefined &&
      JSON.stringify(message.content_blocks) !== JSON.stringify(content))
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
  const { content_blocks, ...legacy } = message;
  return {
    ...legacy,
    content: content.map((block) => block.text).join(""),
    response_metadata: {
      ...responseMetadata,
      usage: responseMetadata.usage ?? providerUsage,
    },
    tool_call_chunks: [],
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
