import type { Message, PartSource, TextPart } from "@ag-ui/client";
import { AbstractAgent, contentToText } from "@ag-ui/client";
import { MastraClient } from "@mastra/client-js";
import type { Mastra } from "@mastra/core";
import type { CoreMessage } from "@mastra/core/llm";
import { Agent as LocalMastraAgent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { MastraAgent, MastraTracingOptions } from "./mastra";
import {
  canOwnReasoning,
  decodeReasoningArtifact,
  reasoningArtifactToMastraParts,
} from "./encrypted-reasoning";
import { contentPartsToModelOutput } from "./tool-results";

/**
 * CoreMessage extended with an optional `id` field.
 * Mastra's `inputToMastraDBMessage` checks `"id" in message` at runtime
 * and preserves it when present, but the upstream AI SDK type doesn't
 * declare the field. This type makes the pass-through explicit.
 * Ref: https://github.com/mastra-ai/mastra/blob/13f46064564fc4aee14aa11878f9352d79f4efc4/packages/core/src/agent/message-list/conversion/input-converter.ts#L79
 */
type CoreMessageWithId = CoreMessage & { id?: string };

/**
 * Coerce an AG-UI message id into the charset the OpenAI Responses API accepts
 * for `input[].id` (`^[A-Za-z0-9_-]+$`). Client-minted ids (e.g. CopilotKit's
 * `msg-…`) can contain characters the Responses API rejects; once such an id is
 * replayed as prior-turn history (turn 2+), the request 400s wholesale
 * (`AI_APICallError: Invalid 'input[N].id'`), which breaks every multi-turn
 * chat on a Responses-API model. AI SDK v5's `openai(model)` defaults to that
 * API, so this hits any Mastra agent using the default provider.
 *
 * The mapping is deterministic and idempotent: an already-valid id is returned
 * unchanged (the common case — Mastra-minted assistant ids are UUIDs, a no-op),
 * and any given id always maps to the same sanitized value. That determinism is
 * load-bearing for Mastra's history dedup (see convertAGUIMessagesToMastra): a
 * message is sanitized identically every time it passes through this converter —
 * both when first stored and when re-sent — so upsert-by-id still matches.
 */
const RESPONSES_API_ID_CHARSET = /^[A-Za-z0-9_-]+$/;
function toModelSafeMessageId(id: string): string {
  return RESPONSES_API_ID_CHARSET.test(id)
    ? id
    : id.replace(/[^A-Za-z0-9_-]/g, "-");
}

/**
 * The URL form of a media part's source, or `null` when this adapter has no way
 * to express it.
 *
 * A `file` source names bytes that already sit at a model provider, under a
 * handle only that provider can resolve. It is NOT a URL, and returning it as
 * one put an opaque handle into `image`/`file.data` on the provider request —
 * a fetch of a nonsense address, or a silently wrong attachment. This adapter
 * has no provider-handle path in 1.0, so an unusable source is an ABSENT
 * source: `null` here, and the caller drops the one part with one warning,
 * which is what the specification asks of a producer that cannot use a content
 * part ("it skips the part and continues, and SHOULD warn"). A part that
 * arrives with no source at all is dropped the same way.
 */
function mediaSourceToUrl(source: PartSource | undefined): string | null {
  if (!hasSource(source)) {
    return null;
  }
  if (source.type === "data") {
    return `data:${source.mimeType};base64,${source.value}`;
  }
  if (source.type === "url") {
    return source.value;
  }
  return null;
}

/**
 * Announce the one part this adapter drops, so an operator sees a missing
 * attachment instead of a request that merely fails to mention it.
 */
function warnUnusableSource(partType: string, source: unknown): void {
  const reason = hasSource(source)
    ? "a provider file handle cannot be forwarded by this adapter"
    : "it has no source";
  console.warn(`[toMastraContent] Dropping ${partType} content: ${reason}`);
}

/** Message content is client input, so a media part may lack its source. */
function hasSource(source: unknown): source is PartSource {
  return typeof source === "object" && source !== null;
}

/**
 * The attachment's original name, read from where AG-UI carries it. Only a
 * non-empty string counts; nothing is derived or defaulted.
 */
function readFilename(holder: unknown): string | undefined {
  if (typeof holder !== "object" || holder === null) {
    return undefined;
  }
  const { filename } = holder as { filename?: unknown };
  return typeof filename === "string" && filename !== "" ? filename : undefined;
}

/**
 * An image as Mastra should receive it. Mastra drops `filename` from image
 * parts but persists it on file parts, and both produce the same model prompt,
 * so a named image with a known MIME type travels as a file part.
 */
function toMastraImagePart(
  image: string,
  mimeType: string | undefined,
  filename: string | undefined,
) {
  if (filename && mimeType) {
    return { type: "file", data: image, mimeType, filename };
  }
  return { type: "image", image, ...(mimeType ? { mimeType } : {}) };
}

const toMastraTextContent = (content: Message["content"]): string => {
  if (!content) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const textParts = content
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean);

  return textParts.join("\n");
};

const toMastraContent = (content: Message["content"]): string | any[] => {
  if (!content) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  // Convert content parts to Mastra format
  const parts: any[] = [];
  for (const part of content) {
    switch (part.type) {
      case "text":
        parts.push({ type: "text", text: part.text });
        break;
      case "image": {
        const image = mediaSourceToUrl(part.source);
        if (image === null) {
          warnUnusableSource(part.type, part.source);
          break;
        }
        parts.push(
          toMastraImagePart(
            image,
            part.source.mimeType,
            readFilename(part.metadata),
          ),
        );
        break;
      }
      case "audio":
      case "video":
      case "document": {
        const data = mediaSourceToUrl(part.source);
        if (data === null) {
          warnUnusableSource(part.type, part.source);
          break;
        }
        const filename = readFilename(part.metadata);
        parts.push({
          type: "file",
          data,
          mimeType: part.source.mimeType ?? "application/octet-stream",
          ...(filename ? { filename } : {}),
        });
        break;
      }
      default:
        console.warn(
          `[toMastraContent] Unknown content type "${(part as { type: string }).type}"; skipping`,
        );
        break;
    }
  }
  return parts;
};

function parseReplayToolCallArguments(
  raw: string | undefined,
): { args: unknown; recovered: boolean } | undefined {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") {
    return { args: {}, recovered: false };
  }

  try {
    return { args: JSON.parse(trimmed), recovered: false };
  } catch {
    const recovered = recoverFirstJsonValue(trimmed);
    if (recovered !== undefined) {
      return { args: recovered, recovered: true };
    }
    return undefined;
  }
}

function recoverFirstJsonValue(text: string): unknown | undefined {
  const end = endOfFirstJsonContainer(text);
  if (end <= 0 || end >= text.length) {
    return undefined;
  }
  try {
    return JSON.parse(text.slice(0, end));
  } catch {
    return undefined;
  }
}

function endOfFirstJsonContainer(text: string): number {
  const open = text[0];
  if (open !== "{" && open !== "[") {
    return -1;
  }

  let objectDepth = 0;
  let arrayDepth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      objectDepth += 1;
    } else if (ch === "}") {
      objectDepth -= 1;
    } else if (ch === "[") {
      arrayDepth += 1;
    } else if (ch === "]") {
      arrayDepth -= 1;
    }
    if (objectDepth < 0 || arrayDepth < 0) {
      return -1;
    }
    if (objectDepth === 0 && arrayDepth === 0) {
      return i + 1;
    }
  }

  return -1;
}

/**
 * Puts a span that a tool result follows ahead of that step's first call: the
 * first unanswered call of the assistant message that made `toolCallId`.
 * Returns false when no converted assistant message made the call.
 */
function placeReasoningBeforeToolCall(
  result: CoreMessageWithId[],
  toolCallId: string,
  reasoningParts: Record<string, unknown>[],
  answeredToolCallIds: Set<string>,
): boolean {
  const isCall = (part: any) => part?.type === "tool-call";
  for (let i = result.length - 1; i >= 0; i--) {
    const message = result[i];
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    const content = message.content as any[];
    const own = content.findIndex(
      (part) => isCall(part) && part.toolCallId === toolCallId,
    );
    if (own === -1) continue;
    const firstUnanswered = content.findIndex(
      (part) => isCall(part) && !answeredToolCallIds.has(part.toolCallId),
    );
    const anchor =
      firstUnanswered === -1 || firstUnanswered > own ? own : firstUnanswered;
    content.splice(anchor, 0, ...reasoningParts);
    return true;
  }
  return false;
}

export function convertAGUIMessagesToMastra(
  messages: Message[],
  // Messages to resolve a tool message's toolName against. Defaults to
  // `messages`, but callers that send only a diff (the new turn) must pass the
  // full incoming history here: a tool-result's matching assistant tool-call
  // may have been filtered out of `messages`, and resolving toolName to
  // "unknown" makes Mastra store a broken tool result (the model then re-calls).
  lookupMessages: Message[] = messages,
): CoreMessageWithId[] {
  // Preserve AG-UI message IDs on the CoreMessage objects (see CoreMessageWithId).
  // Mastra's AIV4Adapter.fromCoreMessage reads `id` when present, which enables
  // Mastra's MessageHistory processor to deduplicate re-sent history:
  //   - processInput filters historical messages whose IDs match the input IDs
  //   - storage.saveMessages upserts by ID, so re-sent history won't duplicate
  // The `id` key is omitted when undefined so it doesn't defeat Mastra's
  // `"id" in message` check. Preserved ids are routed through
  // `toModelSafeMessageId` so a client-minted id can't 400 the OpenAI Responses
  // API when it is replayed as `input[].id` on later turns (deterministic, so
  // dedup is unaffected).
  const result: CoreMessageWithId[] = [];
  // Track only calls skipped from this conversion. Calls in lookupMessages
  // alone may already be stored in Mastra and still need their new results.
  const skippedToolCallIds = new Set<string>();
  // Calls whose result has been converted, to find the step a span belongs to.
  const answeredToolCallIds = new Set<string>();
  // Reasoning spans this bridge streamed, waiting for the message that owns
  // them (see reasoningArtifactToMastraParts): the assistant message that
  // follows, or, when a tool result follows, the step's tool call. Mastra
  // re-announces a message id on every step, so a later step's tool call joins
  // an earlier assistant message while its reasoning lands after the previous
  // step's results.
  let pendingReasoning: Record<string, unknown>[] = [];
  let pendingReasoningIds: string[] = [];
  const dropReasoning = (ids: string[], reason: string) => {
    console.warn(
      `[convertAGUIMessagesToMastra] Dropping reasoning ${ids.join(", ")} ${reason}: its provider artefacts are not replayed`,
    );
  };

  for (const message of messages) {
    if (message.role === "reasoning") {
      const artifact = decodeReasoningArtifact(message.encryptedValue);
      if (artifact) {
        pendingReasoning.push(
          ...reasoningArtifactToMastraParts(message.content ?? "", artifact),
        );
        pendingReasoningIds.push(message.id);
      }
      continue;
    }
    if (!canOwnReasoning(message)) continue;
    const reasoningParts = pendingReasoning;
    const reasoningIds = pendingReasoningIds;
    pendingReasoning = [];
    pendingReasoningIds = [];
    if (reasoningParts.length > 0 && message.role !== "assistant") {
      if (message.role !== "tool") {
        dropReasoning(
          reasoningIds,
          `followed by ${message.role} message ${message.id}`,
        );
      } else if (
        !placeReasoningBeforeToolCall(
          result,
          message.toolCallId,
          reasoningParts,
          answeredToolCallIds,
        )
      ) {
        dropReasoning(
          reasoningIds,
          `followed by the result of unknown call ${message.toolCallId}`,
        );
      }
    }

    if (message.role === "assistant") {
      const assistantContent = toMastraTextContent(message.content);
      const parts: any[] = [...reasoningParts];
      if (assistantContent) {
        parts.push({ type: "text", text: assistantContent });
      }
      for (const toolCall of message.toolCalls ?? []) {
        const parsed = parseReplayToolCallArguments(
          toolCall.function.arguments,
        );
        if (parsed === undefined) {
          skippedToolCallIds.add(toolCall.id);
          console.warn(
            `[convertAGUIMessagesToMastra] Skipping tool-call ${toolCall.function.name} (${toolCall.id}): arguments are not valid JSON`,
          );
          continue;
        }
        if (parsed.recovered) {
          console.warn(
            `[convertAGUIMessagesToMastra] Recovered first JSON value from concatenated tool-call arguments for ${toolCall.function.name} (${toolCall.id})`,
          );
        }
        parts.push({
          type: "tool-call",
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          args: parsed.args,
        });
      }
      if (parts.length === reasoningParts.length && message.toolCalls?.length) {
        if (reasoningParts.length > 0) {
          dropReasoning(
            reasoningIds,
            `with assistant message ${message.id}, whose tool calls were all skipped`,
          );
        }
        continue;
      }
      result.push({
        ...(message.id !== undefined
          ? { id: toModelSafeMessageId(message.id) }
          : {}),
        role: "assistant",
        content: parts,
      } as CoreMessage);
    } else if (message.role === "user") {
      const userContent = toMastraContent(message.content);
      result.push({
        ...(message.id !== undefined
          ? { id: toModelSafeMessageId(message.id) }
          : {}),
        role: "user",
        content: userContent,
      } as CoreMessage);
    } else if (message.role === "developer") {
      // Mastra has no developer role. Preserve app-injected instructions as
      // system messages, separate from user input and persisted chat history.
      result.push({
        ...(message.id !== undefined
          ? { id: toModelSafeMessageId(message.id) }
          : {}),
        role: "system",
        content: message.content,
      } as CoreMessage);
    } else if (message.role === "tool") {
      answeredToolCallIds.add(message.toolCallId);
      let toolName = "unknown";
      for (const msg of lookupMessages) {
        if (msg.role === "assistant") {
          for (const toolCall of msg.toolCalls ?? []) {
            if (toolCall.id === message.toolCallId) {
              toolName = toolCall.function.name;
              break;
            }
          }
        }
      }
      // A result given as content parts reaches the model as Mastra's stored
      // model output (the form a tool's `toModelOutput` produces), with its
      // text kept as the raw result.
      const parts = Array.isArray(message.content)
        ? message.content
        : undefined;
      result.push({
        ...(message.id !== undefined
          ? { id: toModelSafeMessageId(message.id) }
          : {}),
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: toolName,
            result: parts ? contentToText(parts) : message.content,
            // Carry the AG-UI failure signal onto the AI SDK v4 tool-result flag, so a
            // client-reported tool failure is not delivered to the model as a success.
            isError: !!message.error,
            ...(parts
              ? {
                  providerOptions: {
                    mastra: { modelOutput: contentPartsToModelOutput(parts) },
                  },
                }
              : {}),
          },
        ],
      } as CoreMessage);
    }
  }
  if (pendingReasoning.length > 0) {
    dropReasoning(pendingReasoningIds, "at the end of the history");
  }

  // Mastra reconstructs a call with {} arguments for an orphaned result.
  // Remove results of skipped calls too, including results encountered before
  // their calls, so malformed history cannot invent a successful invocation.
  return result.filter(
    (message) =>
      message.role !== "tool" ||
      message.content.every(
        (part) =>
          part.type !== "tool-result" ||
          !skippedToolCallIds.has(part.toolCallId),
      ),
  );
}

export interface GetRemoteAgentsOptions {
  mastraClient: MastraClient;
  resourceId: string;
  /**
   * Surface Mastra Observational Memory (OM) background work as AG-UI activity
   * events (activityType `mastra-observational-memory`). `true` enables it for
   * every agent; pass an array of agent ids to enable it only for those.
   * Default OFF. The remote agent must have OM enabled on its Memory server-side
   * — this only controls whether the bridge surfaces the `data-om-*` chunks it
   * streams. See `MastraAgentConfig.observationalMemory`.
   */
  observationalMemory?: boolean | string[];
  /** Mastra tracing options forwarded to each run. See MastraAgentConfig.tracingOptions. */
  tracingOptions?: MastraTracingOptions;
}

export async function getRemoteAgents({
  mastraClient,
  resourceId,
  observationalMemory,
  tracingOptions,
}: GetRemoteAgentsOptions): Promise<Record<string, AbstractAgent>> {
  const agents = await mastraClient.listAgents();

  const wantsObservationalMemory = (agentId: string): boolean =>
    observationalMemory === true ||
    (Array.isArray(observationalMemory) &&
      observationalMemory.includes(agentId));

  return Object.entries(agents).reduce(
    (acc, [agentId]) => {
      const agent = mastraClient.getAgent(agentId);

      acc[agentId] = new MastraAgent({
        agentId,
        agent,
        resourceId,
        // Enables syncing input.state into the remote server's working memory
        // (client -> agent shared state), mirroring the local path.
        remoteClient: mastraClient,
        observationalMemory: wantsObservationalMemory(agentId)
          ? true
          : undefined,
        tracingOptions,
      });

      return acc;
    },
    {} as Record<string, AbstractAgent>,
  );
}

export interface GetLocalAgentsOptions {
  mastra: Mastra;
  resourceId: string;
  requestContext?: RequestContext;
  /**
   * Enable Mastra's `untilIdle` run mode (background-task lifecycle piped into
   * the run's fullStream). `true` enables it for every agent; pass an array of
   * agent ids to enable it only for those. See `MastraAgentConfig.untilIdle`.
   */
  untilIdle?: boolean | string[];
  /**
   * Surface Mastra Observational Memory (OM) background work as AG-UI activity
   * events (activityType `mastra-observational-memory`). `true` enables it for
   * every agent; pass an array of agent ids to enable it only for those.
   * Default OFF. See `MastraAgentConfig.observationalMemory`.
   */
  observationalMemory?: boolean | string[];
  /** Mastra tracing options forwarded to each run. See MastraAgentConfig.tracingOptions. */
  tracingOptions?: MastraTracingOptions;
}

export function getLocalAgents({
  mastra,
  resourceId,
  requestContext,
  untilIdle,
  observationalMemory,
  tracingOptions,
}: GetLocalAgentsOptions): Record<string, AbstractAgent> {
  const agents = mastra.listAgents() || {};

  const wantsUntilIdle = (agentId: string): boolean =>
    untilIdle === true ||
    (Array.isArray(untilIdle) && untilIdle.includes(agentId));

  const wantsObservationalMemory = (agentId: string): boolean =>
    observationalMemory === true ||
    (Array.isArray(observationalMemory) &&
      observationalMemory.includes(agentId));

  const agentAGUI = Object.entries(agents).reduce(
    (acc, [agentId, agent]) => {
      acc[agentId] = new MastraAgent({
        agentId,
        agent,
        resourceId,
        requestContext,
        untilIdle: wantsUntilIdle(agentId) ? true : undefined,
        observationalMemory: wantsObservationalMemory(agentId)
          ? true
          : undefined,
        tracingOptions,
      });
      return acc;
    },
    {} as Record<string, AbstractAgent>,
  );

  return agentAGUI;
}

export interface GetLocalAgentOptions {
  mastra: Mastra;
  agentId: string;
  resourceId: string;
  requestContext?: RequestContext;
  /** Mastra tracing options forwarded to the run. See MastraAgentConfig.tracingOptions. */
  tracingOptions?: MastraTracingOptions;
}

export function getLocalAgent({
  mastra,
  agentId,
  resourceId,
  requestContext,
  tracingOptions,
}: GetLocalAgentOptions) {
  const agent = mastra.getAgent(agentId);
  if (!agent) {
    throw new Error(`Agent ${agentId} not found`);
  }
  return new MastraAgent({
    agentId,
    agent,
    resourceId,
    requestContext,
    tracingOptions,
  }) as AbstractAgent;
}

export interface GetNetworkOptions {
  mastra: Mastra;
  networkId: string;
  resourceId: string;
  requestContext?: RequestContext;
  /** Mastra tracing options forwarded to the run. See MastraAgentConfig.tracingOptions. */
  tracingOptions?: MastraTracingOptions;
}

export function getNetwork({
  mastra,
  networkId,
  resourceId,
  requestContext,
  tracingOptions,
}: GetNetworkOptions) {
  const network = mastra.getAgent(networkId);
  if (!network) {
    throw new Error(`Network ${networkId} not found`);
  }
  return new MastraAgent({
    agentId: network.name!,
    agent: network as unknown as LocalMastraAgent,
    resourceId,
    requestContext,
    tracingOptions,
  }) as AbstractAgent;
}
