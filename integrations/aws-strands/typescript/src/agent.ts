/**
 * AWS Strands Agent adapter for AG-UI.
 *
 * Translates Strands streaming events into the AG-UI event protocol.
 */

import { randomUUID } from "crypto";

import {
  Agent as StrandsAgentCore,
  InterruptResponseContent,
  Message as StrandsMessage,
  SessionManager,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  type AgentConfig,
  type AgentResult as StrandsAgentResult,
  type AgentStreamEvent,
  type ContentBlock,
  type Interrupt as StrandsInterrupt,
  type JSONValue,
  type Plugin,
} from "@strands-agents/sdk";
import {
  EventType,
  type AssistantMessage as AguiAssistantMessage,
  type BaseEvent,
  type Interrupt as AguiInterrupt,
  type Message as AguiMessage,
  type ResumeEntry,
  type RunAgentInput,
  type ToolCall as AguiToolCall,
  type ToolMessage as AguiToolMessage,
  type UserMessage as AguiUserMessage,
} from "@ag-ui/core";

import {
  buildContextExtras,
  maybeAwait,
  normalizePredictState,
  predictStateMappingToPayload,
  type StrandsAgentConfig,
  type ToolCallContext,
  type ToolResultContext,
} from "./config";
import { syncProxyTools } from "./client-proxy-tool";
import { convertAguiContentToStrands, flattenContentToText } from "./utils";
import type { SeenToolCall } from "./types";
import { DEFAULT_LOGGER, resolveLogger, type Logger } from "./logger";

const LOG_PREFIX = "[@ag-ui/aws-strands]";

// Strands' `randomUUID` return type is branded; normalise to plain string.
const uuid = (): string => randomUUID();

/**
 * Structural interface for a Strands multi-agent orchestrator (Graph/Swarm).
 * TypeScript-only: the Python SDK currently has no orchestrator equivalent.
 */
interface StrandsOrchestrator {
  readonly id?: string;
  stream(input: string): AsyncGenerator<unknown, unknown, unknown>;
}

/**
 * Fields cloned from the caller-supplied template Agent into every per-thread
 * Agent. Mirrors Python's `_extract_agent_kwargs`. Deliberately NOT forwarded:
 *   - sessionManager: supplied per-thread via sessionManagerProvider.
 *   - plugins: supplied explicitly via StrandsAgentOptions.plugins.
 *   - conversationManager: bound to template state; sharing across threads
 *     would share conversation-window state. Rely on Strands' default.
 *   - messages: per-thread agents start empty; AG-UI delivers at runtime.
 *   - hooks: Strands' HookRegistry ephemeral state, not forwarded.
 */
interface TemplateAgentCloneFields {
  model: AgentConfig["model"];
  tools: StrandsAgentCore["tools"];
  systemPrompt?: AgentConfig["systemPrompt"];
  name?: string;
  description?: string;
  id?: string;
  appState?: Record<string, JSONValue>;
  modelState?: Record<string, JSONValue>;
  traceAttributes?: AgentConfig["traceAttributes"];
  structuredOutputSchema?: AgentConfig["structuredOutputSchema"];
  toolExecutor?: AgentConfig["toolExecutor"];
}

/**
 * Extract every forwardable field from the template Agent into per-thread
 * clones. Mirrors Python's ``_extract_agent_kwargs``.
 */
function _extractTemplateFields(
  agent: StrandsAgentCore,
): TemplateAgentCloneFields {
  const model = agent.model;
  // Forward the existing Model instance to per-thread clones so that any
  // provider-specific config the caller set on the template (e.g. Bedrock
  // `additionalRequestFields.thinking`, `temperature`, guardrails) is
  // preserved. Strands also accepts `model: string` and rebuilds a
  // BedrockModel from it, but that path discards every other field — which
  // silently breaks reasoning, guardrails, and per-model tuning.
  const fields: TemplateAgentCloneFields = {
    model,
    tools: agent.tools.slice(),
  };
  if (agent.systemPrompt !== undefined)
    fields.systemPrompt = agent.systemPrompt;
  // Strands defaults `name` to "Strands Agent" and `id` to "agent" when the
  // caller doesn't set them — forward them unconditionally so the per-thread
  // agent matches the template regardless of whether the default or an
  // override was used.
  if (agent.name !== undefined) fields.name = agent.name;
  if (agent.id !== undefined) fields.id = agent.id;
  if (agent.description !== undefined) fields.description = agent.description;
  // appState / modelState are StateStore instances; serialize to plain dicts.
  const appStateDump = (
    agent.appState as { getAll?: () => Record<string, JSONValue> }
  )?.getAll?.();
  if (appStateDump && Object.keys(appStateDump).length > 0)
    fields.appState = appStateDump;
  const modelStateDump = (
    agent.modelState as { getAll?: () => Record<string, JSONValue> }
  )?.getAll?.();
  if (modelStateDump && Object.keys(modelStateDump).length > 0)
    fields.modelState = modelStateDump;
  // These aren't exposed via the Agent's public accessors in all SDK versions;
  // read them optimistically and forward only when set.
  const extra = agent as unknown as {
    traceAttributes?: AgentConfig["traceAttributes"];
    structuredOutputSchema?: AgentConfig["structuredOutputSchema"];
    toolExecutor?: AgentConfig["toolExecutor"];
  };
  if (extra.traceAttributes !== undefined)
    fields.traceAttributes = extra.traceAttributes;
  if (extra.structuredOutputSchema !== undefined)
    fields.structuredOutputSchema = extra.structuredOutputSchema;
  if (extra.toolExecutor !== undefined)
    fields.toolExecutor = extra.toolExecutor;
  return fields;
}

/** Best-effort string view of an AG-UI message content field. */
function _coerceText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) return flattenContentToText(content);
  return String(content);
}

/**
 * Build a Strands `toolResult` content block from an AG-UI tool message body.
 *
 * AG-UI's wire shape requires `ToolMessage.content` to be a string. Frontends
 * (e.g. CopilotKit's `useHumanInTheLoop`) typically JSON-encode structured
 * results before transport, so the string the adapter receives looks like
 * `'{"accepted":true,"steps":[...]}'`. Forwarding that as a `text` block leaves
 * the LLM with two competing payloads: the original `toolUse.input` (full
 * args) and an opaque-looking JSON string in the result. The model often
 * defaults to the args.
 *
 * Strands' `ToolResultContentData` accepts a `JsonBlock` shape (see
 * `@strands-agents/sdk` `messages.ts`). When the message content parses as a
 * JSON object/array, emit it as `{ json: parsed }` so the LLM sees a real
 * structured result. Fall back to `{ text: ... }` for everything else.
 */
function _buildToolResultContent(
  content: unknown,
): { text: string } | { json: unknown } {
  const text = _coerceText(content);
  const trimmed = text.trim();
  if (trimmed.length === 0) return { text };
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return { text };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object") {
      return { json: parsed };
    }
  } catch {
    // Not valid JSON — fall through to text.
  }
  return { text };
}

/** Return ``value`` if it is a non-empty string, else a fresh UUID. */
function _coerceId(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : uuid();
}

/** Extract a human-readable message from an unknown error. */
function _errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Resolve the AG-UI-side tool call id from an incoming Strands tool use.
 *
 * - If we've already seen this Strands tool (by internal id), reuse the
 *   existing AG-UI id so every envelope event carries the same id.
 * - Frontend tools get a fresh UUID to avoid cross-request collisions.
 * - Backend tools reuse Strands' own id so result lookup works.
 */
function _resolveToolUseId(
  seen: Map<string, SeenToolCall>,
  strandsToolId: string,
  isFrontendTool: boolean,
): string {
  for (const [tid, data] of seen) {
    if (data.strandsToolId === strandsToolId) return tid;
  }
  if (isFrontendTool) return uuid();
  return strandsToolId || uuid();
}

/**
 * Convert ``RunAgentInput.messages`` to AG-UI message objects.
 *
 * Used to seed the running ``MessagesSnapshotEvent`` payload so each snapshot
 * carries the full thread history.
 */
export function buildSnapshotMessages(
  input_messages: AguiMessage[],
): AguiMessage[] {
  const out: AguiMessage[] = [];
  for (const msg of input_messages ?? []) {
    const role = msg.role;
    if (role !== "user" && role !== "assistant" && role !== "tool") continue;
    const msgId = _coerceId((msg as { id?: string }).id);
    if (role === "user") {
      out.push({
        id: msgId,
        role: "user",
        content: _coerceText(msg.content),
      } as AguiUserMessage);
    } else if (role === "assistant") {
      const rawToolCalls = (msg as { toolCalls?: AguiToolCall[] }).toolCalls;
      let toolCalls: AguiToolCall[] | undefined;
      if (rawToolCalls && rawToolCalls.length > 0) {
        toolCalls = rawToolCalls.map((tc) => {
          const fn = tc.function as
            | { name?: string; arguments?: string }
            | undefined;
          return {
            id: _coerceId(tc.id),
            type: "function" as const,
            function: {
              name: fn?.name ?? "unknown",
              arguments: fn?.arguments ?? "{}",
            },
          };
        });
      }
      const assistant: AguiAssistantMessage = {
        id: msgId,
        role: "assistant",
        content: _coerceText(msg.content),
      };
      if (toolCalls) assistant.toolCalls = toolCalls;
      out.push(assistant);
    } else {
      const toolCallId = (msg as { toolCallId?: string }).toolCallId ?? "";
      out.push({
        id: msgId,
        role: "tool",
        content: _coerceText(msg.content),
        toolCallId,
      } as AguiToolMessage);
    }
  }
  return out;
}

/**
 * Convert ``RunAgentInput.messages`` to Strands native ``Messages``.
 *
 * Strands has only ``user`` and ``assistant`` roles; tool calls and tool
 * results live as ``toolUse`` / ``toolResult`` ContentBlocks. Reconciling
 * the cached agent's ``self.messages`` with this list before invoking
 * ``stream(undefined)`` ensures the LLM sees the real conversation state —
 * including frontend tool results — rather than a fresh prompt that
 * re-fires the same tool every turn.
 *
 * Multimodal content is routed through ``convertAguiContentToStrands`` so
 * image/document/video blocks reach the LLM intact across replay.
 */
async function _buildStrandsHistory(
  input_messages: AguiMessage[],
  log: Logger,
): Promise<Array<{ role: "user" | "assistant"; content: unknown[] }>> {
  const out: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];
  for (const msg of input_messages ?? []) {
    const role = msg.role;
    if (role === "user") {
      const content: unknown[] = [];
      const raw = msg.content;
      if (Array.isArray(raw)) {
        const hasMedia = raw.some((item: { type?: string }) =>
          ["image", "audio", "video", "document"].includes(item.type ?? ""),
        );
        if (hasMedia) {
          try {
            const blocks = await convertAguiContentToStrands(raw as never, log);
            for (const b of blocks) {
              if (b instanceof TextBlock) {
                content.push({ text: b.text });
              } else {
                const serialised =
                  typeof (b as { toJSON?: () => unknown }).toJSON === "function"
                    ? (b as { toJSON: () => unknown }).toJSON()
                    : b;
                content.push(serialised);
              }
            }
          } catch (e) {
            log.warn(
              `${LOG_PREFIX} history replay multimodal conversion failed; falling back to text`,
              e,
            );
          }
          if (content.length === 0) {
            content.push({ text: flattenContentToText(raw as never) || "" });
          }
        } else {
          content.push({ text: flattenContentToText(raw as never) });
        }
      } else {
        content.push({ text: _coerceText(raw) });
      }
      out.push({ role: "user", content });
    } else if (role === "assistant") {
      const blocks: unknown[] = [];
      const text = _coerceText(msg.content);
      if (text) blocks.push({ text });
      const rawToolCalls =
        (msg as { toolCalls?: AguiToolCall[] }).toolCalls ?? [];
      for (const tc of rawToolCalls) {
        const fn = tc.function as
          | { name?: string; arguments?: string }
          | undefined;
        const name = fn?.name || "unknown";
        const rawArgs = fn?.arguments || "{}";
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawArgs);
        } catch (e) {
          log.warn(
            `${LOG_PREFIX} history tool args JSON parse failed for ${name}; falling back to {}`,
            e,
          );
          parsed = {};
        }
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        )
          parsed = {};
        blocks.push({
          toolUse: { toolUseId: tc.id, name, input: parsed },
        });
      }
      if (blocks.length === 0) blocks.push({ text: "" });
      out.push({ role: "assistant", content: blocks });
    } else if (role === "tool") {
      const toolCallId = (msg as { toolCallId?: string }).toolCallId || "";
      out.push({
        role: "user",
        content: [
          {
            toolResult: {
              toolUseId: toolCallId,
              content: [_buildToolResultContent(msg.content)],
              status: "success" as const,
            },
          },
        ],
      });
    }
  }
  return out;
}

/** Options accepted by `StrandsAgent`. */
export interface StrandsAgentOptions {
  /**
   * Either an `Agent` (the template — adapter clones it per thread and syncs
   * proxy tools) OR a multi-agent orchestrator (`Graph`, `Swarm`).
   * Orchestrators are stateless per invocation so the same instance serves
   * every thread.
   */
  agent: StrandsAgentCore | StrandsOrchestrator;
  name: string;
  description?: string;
  config?: StrandsAgentConfig;
  /**
   * Plugins forwarded to every per-thread Strands agent created by this
   * adapter (observability, loop caps, policy checks, ...). Mirrors the
   * Python adapter's `hooks=` kwarg. Ignored when `agent` is a multi-agent
   * orchestrator.
   */
  plugins?: Plugin[];
}

/** AWS Strands Agent wrapper for AG-UI integration. */
export class StrandsAgent {
  readonly name: string;
  readonly description: string;
  readonly config: StrandsAgentConfig;

  // Template agent configuration for creating fresh per-thread instances.
  private readonly _templateFields: TemplateAgentCloneFields;

  /**
   * Hook providers forwarded to each per-thread StrandsAgentCore.
   *
   * Taken directly from the caller rather than read off the template because
   * Strands' `Agent.hooks` is a `HookRegistry` containing only registered
   * callbacks — the original list of provider objects is not retained, and
   * the registry also contains callbacks bound to internal Strands objects
   * that must not be cross-wired into per-thread agents.
   */
  private readonly _plugins: Plugin[];

  private readonly _agentsByThread = new Map<string, StrandsAgentCore>();
  private readonly _proxyToolNamesByThread = new Map<string, Set<string>>();
  /**
   * Guards first-time thread initialization. The sessionManagerProvider call
   * introduces an async yield point between the "is this thread new?" check
   * and the map assignment, so concurrent requests for the same new threadId
   * could otherwise both create an agent and one would clobber the other.
   */
  private readonly _threadInitLock = new AsyncMutex();
  /**
   * Threads with an in-flight run. Strands `Agent.stream()` throws if a
   * second invocation is started on a busy agent; we detect the collision
   * up front and emit a protocol-shaped RUN_ERROR/THREAD_BUSY instead.
   * TypeScript-only: the Python adapter has no equivalent guard.
   */
  private readonly _activeRunsByThread = new Set<string>();
  /** Outstanding Strands interrupt IDs per thread, used to validate
   * incoming `RunAgentInput.resume[]` (interrupts.mdx rule 4). */
  private readonly _pendingInterruptsByThread = new Map<string, Set<string>>();
  /**
   * When non-null, the adapter bypasses per-thread cloning and invokes
   * the orchestrator directly. See `StrandsAgentOptions.agent`.
   */
  private readonly _orchestrator: StrandsOrchestrator | null;
  /**
   * Injectable logger. Defaults to console `warn`/`error` with `debug`
   * suppressed, matching Python's stdlib `logging.getLogger(__name__)`.
   */
  private readonly _log: Logger;

  constructor(options: StrandsAgentOptions) {
    const { agent, name, description = "", config = {}, plugins } = options;

    // Detect a multi-agent orchestrator. Graph / Swarm expose `nodes` + `edges`
    // (Graph) or `nodes` + invoke semantics (Swarm) and have no `.model`
    // accessor — branching on the presence of `.model` is the cleanest
    // structural check.
    const isOrchestrator =
      typeof (agent as { model?: unknown }).model === "undefined" ||
      (agent as { model?: unknown }).model === null;

    this.name = name;
    this.description = description;
    this.config = config;
    this._log = resolveLogger(config.logger);

    if (isOrchestrator) {
      this._orchestrator = agent as StrandsOrchestrator;
      this._templateFields = { model: undefined as never, tools: [] };
      this._plugins = [];
      return;
    }

    this._orchestrator = null;
    const agentCore = agent as StrandsAgentCore;
    this._templateFields = _extractTemplateFields(agentCore);
    this._plugins = plugins ? [...plugins] : [];

    // Detect the common pitfall: sessionManager set on the template Agent
    // with no per-thread provider. Forwarding it would make every AG-UI
    // thread share one session_id.
    if (agentCore.sessionManager && !this.config.sessionManagerProvider) {
      this._log.warn(
        `${LOG_PREFIX} sessionManager was set on the template Agent but will ` +
          "be ignored: forwarding it would cause every AG-UI thread to share the " +
          "same session_id. Construct per-thread session managers via " +
          "StrandsAgentConfig.sessionManagerProvider instead.",
      );
    }

    // Detect unconnected MCP clients passed directly into `tools: [...]`.
    // Strands resolves a connected `McpClient`'s tools into `agent.tools` at
    // construction time; an unconnected one stays as the bare client and the
    // resolved tool list never appears here. The fix is on the caller's
    // side: `await client.connect()` and spread `await client.listTools()`
    // into the `tools` array.
    for (const tool of this._templateFields.tools ?? []) {
      if (
        tool != null &&
        typeof (tool as { connect?: unknown }).connect === "function" &&
        typeof (tool as { name?: unknown }).name !== "string"
      ) {
        this._log.warn(
          `${LOG_PREFIX} an entry in the template Agent's \`tools\` looks like ` +
            "an unconnected McpClient — its tools will not be available to the " +
            "model. Call `await client.connect()` and spread the resolved tool " +
            "list into `tools: [...]` before constructing the Agent.",
        );
      }
    }
  }

  /** Run the Strands agent and yield AG-UI events. */
  async *run(inputData: RunAgentInput): AsyncGenerator<BaseEvent, void, void> {
    const threadId = inputData.threadId || "default";
    const hasResume =
      Array.isArray(inputData.resume) && inputData.resume.length > 0;

    // interrupts.mdx rule 4: any resume[] entry referencing an unknown
    // interruptId MUST produce RUN_ERROR. Known IDs flow through to
    // `InterruptResponseContent[]`. Gated above `_runRaw` so subclasses
    // that override only `_runRaw` still inherit the check.
    if (hasResume) {
      const pending = this._pendingInterruptsByThread.get(threadId);
      const unknown = inputData
        .resume!.map((entry) => entry.interruptId)
        .filter((id) => !pending?.has(id));
      if (unknown.length > 0) {
        yield _runStarted(inputData);
        yield _runError(
          `This agent did not issue any interrupts to resume: ${unknown
            .slice(0, 4)
            .join(", ")}. ` +
            "Resume entries must reference an outstanding interruptId.",
          "UNKNOWN_INTERRUPT",
        );
        return;
      }
    } else {
      // Non-resume run on this thread: any previously recorded interrupt
      // IDs are stale (the client moved on instead of resuming). Drop them
      // so a later replay/race cannot pass the resume[] gate above with a
      // dead interruptId.
      this._pendingInterruptsByThread.delete(threadId);
    }
    const source = this._runRaw(inputData);
    if (this.config.emitChunkEvents) {
      yield* collapseToChunkEvents(source);
      return;
    }
    yield* source;
  }

  protected async *_runRaw(
    inputData: RunAgentInput,
  ): AsyncGenerator<BaseEvent, void, void> {
    const threadId = inputData.threadId || "default";

    // Reject concurrent runs on the same thread up front. Strands cannot
    // multiplex a single Agent across invocations and emits a confusing
    // internal error ("Agent is already processing an invocation") if we try.
    if (this._activeRunsByThread.has(threadId)) {
      yield _runStarted(inputData);
      yield _runError(
        `Another run is already in progress on thread "${threadId}". Wait for RUN_FINISHED before starting a new run on the same thread.`,
        "THREAD_BUSY",
      );
      return;
    }
    this._activeRunsByThread.add(threadId);
    try {
      if (this._orchestrator !== null) {
        yield* this._runOrchestrator(inputData);
      } else {
        yield* this._runSingleAgent(inputData, threadId);
      }
    } finally {
      this._activeRunsByThread.delete(threadId);
    }
  }

  private async *_runSingleAgent(
    inputData: RunAgentInput,
    threadId: string,
  ): AsyncGenerator<BaseEvent, void, void> {
    yield _runStarted(inputData);

    // Get or create agent instance for this thread. When a
    // sessionManagerProvider is configured, the SessionManager handles
    // conversation persistence; otherwise state is held in-memory per thread.
    let strandsAgent = this._agentsByThread.get(threadId);
    if (!strandsAgent) {
      // Build the message-history seed BEFORE acquiring the global thread
      // init lock. The seed helper may make async fetches for URL-based
      // multimodal attachments; doing that inside the lock would serialise
      // cold-cache initialisations for every OTHER thread behind one slow
      // replay request. Skipped entirely when a SessionManager will own
      // persistence.
      let seedMessages: AgentConfig["messages"] | undefined;
      if (!this.config.sessionManagerProvider) {
        try {
          seedMessages = await buildStrandsSeed(
            inputData.messages ?? [],
            this._log,
          );
        } catch (e) {
          this._log.error(
            `${LOG_PREFIX} buildStrandsSeed failed for thread ${threadId}: ${_errorMessage(e)}`,
            e,
          );
          yield _runError(
            "Failed to build conversation seed: " + _errorMessage(e),
            "SEED_BUILD_ERROR",
          );
          return;
        }
      }

      const release = await this._threadInitLock.acquire();
      try {
        // Double-check inside the lock: another coroutine may have completed
        // initialization while we were waiting.
        strandsAgent = this._agentsByThread.get(threadId);
        if (!strandsAgent) {
          let sessionManager: SessionManager | null | undefined;
          if (this.config.sessionManagerProvider) {
            try {
              sessionManager = (await maybeAwait(
                this.config.sessionManagerProvider(inputData),
              )) as SessionManager | null | undefined;
            } catch (e) {
              const msg = _errorMessage(e);
              this._log.error(
                `${LOG_PREFIX} sessionManagerProvider failed: ${msg}`,
                e,
              );
              yield _runError(
                `Failed to initialize session manager: ${msg}`,
                "SESSION_MANAGER_ERROR",
              );
              return;
            }
            if (
              sessionManager != null &&
              !(sessionManager instanceof SessionManager)
            ) {
              const actual =
                (sessionManager as object)?.constructor?.name ??
                typeof sessionManager;
              this._log.error(
                `${LOG_PREFIX} sessionManagerProvider returned ${actual}; expected a SessionManager instance.`,
              );
              yield _runError(
                `sessionManagerProvider returned ${actual}; expected a SessionManager instance`,
                "SESSION_MANAGER_INVALID_TYPE",
              );
              return;
            }
            if (!sessionManager) {
              this._log.warn(
                `${LOG_PREFIX} sessionManagerProvider returned null/undefined for threadId=${threadId}; ` +
                  "agent will run without session persistence",
              );
            }
          }
          // If a SessionManager materialised, skip the pre-computed seed —
          // the session owns persistence and seeding on top would duplicate
          // turns.
          const effectiveSeed = sessionManager ? undefined : seedMessages;
          strandsAgent = new StrandsAgentCore(
            this._buildThreadAgentConfig(
              sessionManager ?? undefined,
              effectiveSeed,
            ),
          );
          this._agentsByThread.set(threadId, strandsAgent);
        }
      } finally {
        release();
      }
    }

    // Sync proxy tools from client-defined tools.
    if (inputData.tools && inputData.tools.length > 0) {
      const proxyNames = syncProxyTools(
        strandsAgent.toolRegistry,
        inputData.tools,
        this._proxyToolNamesByThread.get(threadId) ?? new Set(),
        this._log,
      );
      this._proxyToolNamesByThread.set(threadId, proxyNames);
    } else {
      const previous = this._proxyToolNamesByThread.get(threadId);
      if (previous && previous.size > 0) {
        syncProxyTools(strandsAgent.toolRegistry, [], previous, this._log);
        this._proxyToolNamesByThread.set(threadId, new Set());
      }
    }

    try {
      // Seed the running ``MessagesSnapshotEvent`` payload from the full
      // conversation history so each emitted snapshot carries prior turns
      // plus whatever this turn adds.
      const emitMessagesSnapshot = this.config.emitMessagesSnapshot !== false;
      const snapshotMessages: AguiMessage[] = emitMessagesSnapshot
        ? buildSnapshotMessages(inputData.messages ?? [])
        : [];

      // Emit state snapshot if provided. Filter out `messages` from state to
      // avoid "Unknown message role" errors — the frontend manages messages
      // separately and doesn't recognize the "tool" role.
      if (inputData.state && typeof inputData.state === "object") {
        const snapshot: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(
          inputData.state as Record<string, unknown>,
        )) {
          if (k !== "messages") snapshot[k] = v;
        }
        yield { type: EventType.STATE_SNAPSHOT, snapshot };
      }

      // Splice point 1 of 4: emit the initial messages snapshot so the
      // frontend can render the seeded thread before any new content streams.
      if (emitMessagesSnapshot && snapshotMessages.length > 0) {
        yield {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: snapshotMessages.slice(),
        };
      }

      const frontendToolNames = new Set<string>();
      for (const t of inputData.tools ?? []) {
        if (t.name) frontendToolNames.add(t.name);
      }

      // Collect tool_call_ids that already have results in the message
      // history so we suppress duplicate TOOL_CALL_START events for them.
      const pendingToolResultIds = new Set<string>();
      if (inputData.messages) {
        for (let i = inputData.messages.length - 1; i >= 0; i--) {
          const msg = inputData.messages[i];
          if (!msg) break;
          if (msg.role === "tool") {
            const tid = (msg as { toolCallId?: string }).toolCallId;
            if (tid) pendingToolResultIds.add(tid);
          } else {
            break;
          }
        }
        if (pendingToolResultIds.size > 0) {
          this._log.debug(
            `${LOG_PREFIX} Has pending tool results detected: toolCallIds=${JSON.stringify([...pendingToolResultIds])}, threadId=${inputData.threadId}`,
          );
        }
      }

      // Lookup of tool_call_id -> tool_name from assistant messages.
      const toolCallIdToName = new Map<string, string>();
      for (const msg of inputData.messages ?? []) {
        if (msg.role !== "assistant") continue;
        const calls = (msg as { toolCalls?: AguiToolCall[] }).toolCalls;
        if (!calls) continue;
        for (const tc of calls) {
          const fn = tc.function as { name?: string } | undefined;
          if (tc.id && fn?.name) toolCallIdToName.set(tc.id, fn.name);
        }
      }

      // Derive the outgoing user message. For continuation runs (pending
      // tool results in history), synthesise a "frontend tool executed"
      // message so the model understands the context.
      let userMessage: string | ContentBlock[] = "Hello";
      if (pendingToolResultIds.size > 0 && inputData.messages) {
        for (let i = inputData.messages.length - 1; i >= 0; i--) {
          const msg = inputData.messages[i];
          if (!msg) break;
          if (msg.role === "tool") {
            const toolCallId = (msg as { toolCallId?: string }).toolCallId;
            if (toolCallId) {
              const name = toolCallIdToName.get(toolCallId);
              if (name && frontendToolNames.has(name)) {
                userMessage = `${name} executed successfully with no return value.`;
              }
            }
            break;
          }
        }
      } else if (inputData.messages) {
        for (let i = inputData.messages.length - 1; i >= 0; i--) {
          const msg = inputData.messages[i];
          if (!msg) break;
          if (
            (msg.role === "user" || msg.role === "tool") &&
            msg.content != null
          ) {
            if (Array.isArray(msg.content)) {
              const hasMedia = msg.content.some((item: { type?: string }) =>
                ["image", "audio", "video", "document"].includes(
                  item.type ?? "",
                ),
              );
              if (hasMedia) {
                const blocks = await convertAguiContentToStrands(
                  msg.content,
                  this._log,
                );
                if (blocks.length > 0) {
                  userMessage = blocks;
                } else {
                  const textFallback = flattenContentToText(msg.content);
                  if (textFallback) {
                    userMessage = textFallback;
                    this._log.warn(
                      `${LOG_PREFIX} all media content blocks failed conversion; falling back to text`,
                    );
                  } else {
                    yield _runError(
                      "All media content blocks failed conversion and no text fallback is available",
                      "MEDIA_RESOLUTION_FAILED",
                    );
                    return;
                  }
                }
              } else {
                userMessage = flattenContentToText(msg.content);
              }
            } else {
              userMessage = msg.content as string;
            }
            break;
          }
        }
      }

      // Allow configuration to enrich the outgoing user message. Multimodal
      // prompts pass through unchanged so binary payloads reach the model
      // intact.
      if (this.config.stateContextBuilder) {
        try {
          const textForBuilder = Array.isArray(userMessage)
            ? flattenContentToText(userMessage)
            : userMessage;
          const builderResult = this.config.stateContextBuilder(
            inputData,
            textForBuilder,
            buildContextExtras(inputData),
          );
          if (!Array.isArray(userMessage)) {
            userMessage = builderResult;
          }
        } catch (e) {
          this._log.error(`${LOG_PREFIX} stateContextBuilder failed:`, e);
          yield {
            type: EventType.CUSTOM,
            name: "hook_error",
            value: {
              hook: "stateContextBuilder",
              tool: "__prompt__",
              error: _errorMessage(e),
            },
          };
        }
      }

      // Per-run state.
      let messageId = uuid();
      let messageStarted = false;
      let accumulatedText = "";
      const toolCallsSeen = new Map<string, SeenToolCall>();
      const currentState: Record<string, unknown> = {
        ...((inputData.state ?? {}) as object),
      };
      let stopTextStreaming = false;
      let haltEventStream = false;
      let pendingHalt = false;

      let reasoningStarted = false;
      let reasoningMessageId: string | undefined;

      // Tool currently being streamed via toolUseInputDelta events. Populated
      // by modelContentBlockStartEvent or toolUseInputDelta, flushed on
      // modelContentBlockStopEvent.
      let currentToolUse: {
        name: string;
        toolUseId: string;
        inputChunks: string[];
      } | null = null;

      // Reconcile Strands' internal conversation history with
      // ``RunAgentInput.messages`` when no ``sessionManager`` is wired.
      // Without this, frontend tool results never reach the LLM — Strands
      // sees an open ``toolUse`` from the prior turn and the LLM re-fires
      // the same tool every run.
      const replayHistory =
        this.config.replayHistoryIntoStrands !== false &&
        !(strandsAgent as { sessionManager?: unknown }).sessionManager;
      let invokeArgs:
        | string
        | ContentBlock[]
        | InterruptResponseContent[]
        | undefined = userMessage;

      // Resume path: convert AG-UI `resume[]` into Strands
      // `InterruptResponseContent[]`. The `run()` gate has already
      // filtered unknown IDs by this point.
      const resumeEntries = resolveResumeEntries(inputData);
      if (resumeEntries.length > 0) {
        invokeArgs = resumeEntries.map(
          (entry) =>
            new InterruptResponseContent({
              interruptId: entry.interruptId,
              response: toResumeResponse(entry) as JSONValue,
            }),
        );
        this._pendingInterruptsByThread.delete(threadId);
      }
      if (replayHistory && resumeEntries.length === 0) {
        const nativeHistory = await _buildStrandsHistory(
          inputData.messages ?? [],
          this._log,
        );
        if (nativeHistory.length > 0) {
          // Apply stateContextBuilder to the last user-text message in the
          // reconciled history rather than to the synthetic `userMessage`
          // string — this is what the LLM actually sees.
          if (this.config.stateContextBuilder) {
            for (let i = nativeHistory.length - 1; i >= 0; i--) {
              const m = nativeHistory[i];
              if (!m || m.role !== "user") continue;
              const first = (m.content as Array<{ text?: string }>)[0];
              if (first && typeof first.text === "string") {
                try {
                  const augmented = this.config.stateContextBuilder(
                    inputData,
                    first.text,
                    buildContextExtras(inputData),
                  );
                  if (typeof augmented === "string") first.text = augmented;
                } catch (e) {
                  this._log.error(
                    `${LOG_PREFIX} stateContextBuilder failed:`,
                    e,
                  );
                  yield {
                    type: EventType.CUSTOM,
                    name: "hook_error",
                    value: {
                      hook: "stateContextBuilder",
                      tool: "__prompt__",
                      error: _errorMessage(e),
                    },
                  };
                }
                break;
              }
            }
          }
          // Convert plain-object history into real Message instances —
          // Bedrock's request formatter dispatches on `block.type`, which
          // only the class instances carry.
          (strandsAgent as { messages: unknown[] }).messages =
            nativeHistory.map((m) =>
              StrandsMessage.fromMessageData({
                role: m.role,
                content: m.content as never,
              }),
            );
          // `stream(undefined)` tells Strands to use `this.messages` as-is.
          invokeArgs = undefined;
        }
      }

      this._log.debug(
        `${LOG_PREFIX} Starting agent run: threadId=${inputData.threadId}, runId=${inputData.runId}, ` +
          `pendingToolResultIds=${JSON.stringify([...pendingToolResultIds])}, ` +
          `messageCount=${inputData.messages?.length ?? 0}`,
      );

      // AbortController wired into Strands's `cancelSignal` so that abandoning
      // the outer generator (HTTP client disconnect) stops the underlying
      // Bedrock streaming call rather than silently burning tokens.
      const runAbort = new AbortController();
      const agentStream = strandsAgent.stream(invokeArgs as never, {
        cancelSignal: runAbort.signal,
      });
      // `agent.stream()` returns the final `AgentResult` on `{ done: true }`.
      // Captured here so the interrupt-variant RUN_FINISHED below can pull
      // `stopReason` and `interrupts[]` off it.
      let finalAgentResult: StrandsAgentResult | undefined;

      try {
        while (true) {
          let next: IteratorResult<AgentStreamEvent, unknown>;
          try {
            next = await agentStream.next();
          } catch (streamErr) {
            // Strands throws "Stream ended without completing a message" when
            // a frontend tool call halts the agent before the model emits a
            // final assistant message. If we've already decided to halt,
            // swallow the error — it's expected flow.
            if (pendingHalt || haltEventStream) {
              if (
                streamErr instanceof TypeError ||
                streamErr instanceof ReferenceError
              ) {
                throw streamErr;
              }
              haltEventStream = true;
              break;
            }
            throw streamErr;
          }
          if (next.done) {
            finalAgentResult = next.value as StrandsAgentResult | undefined;
            break;
          }
          if (haltEventStream) continue;

          // Strands v1 wraps raw model events inside `ModelStreamUpdateEvent`
          // (type: 'modelStreamUpdateEvent', event: ModelStreamEvent) before
          // yielding them from `agent.stream()`. Unwrap once so the dispatch
          // below operates on the inner event shape.
          const event = unwrapStrandsEvent(next.value);
          const kind = getEventKind(event);

          // --- Delta events (text, reasoning, tool-use input streaming) ---
          // Maps to Python's top-level "data" / "reasoningText" /
          // "current_tool_use" branches.
          if (kind === "modelContentBlockDeltaEvent") {
            const delta = (
              event as unknown as {
                delta:
                  | { type: "textDelta"; text: string }
                  | {
                      type: "reasoningContentDelta";
                      text?: string;
                      redactedContent?: Uint8Array;
                    }
                  | { type: "toolUseInputDelta"; input: string };
              }
            ).delta;

            // Text data chunks.
            if (delta.type === "textDelta" && delta.text) {
              if (stopTextStreaming) continue;
              if (!messageStarted) {
                yield {
                  type: EventType.TEXT_MESSAGE_START,
                  messageId,
                  role: "assistant",
                };
                messageStarted = true;
              }
              accumulatedText += delta.text;
              yield {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId,
                delta: delta.text,
              };
              continue;
            }

            // Reasoning/thinking text streaming.
            if (delta.type === "reasoningContentDelta") {
              if (delta.text) {
                if (!reasoningStarted) {
                  reasoningMessageId = uuid();
                  yield {
                    type: EventType.REASONING_START,
                    messageId: reasoningMessageId,
                  };
                  yield {
                    type: EventType.REASONING_MESSAGE_START,
                    messageId: reasoningMessageId,
                    role: "reasoning",
                  };
                  reasoningStarted = true;
                }
                yield {
                  type: EventType.REASONING_MESSAGE_CONTENT,
                  messageId: reasoningMessageId!,
                  delta: delta.text,
                };
              } else if (delta.redactedContent) {
                if (!reasoningStarted) {
                  reasoningMessageId = uuid();
                  yield {
                    type: EventType.REASONING_START,
                    messageId: reasoningMessageId,
                  };
                  yield {
                    type: EventType.REASONING_MESSAGE_START,
                    messageId: reasoningMessageId,
                    role: "reasoning",
                  };
                  reasoningStarted = true;
                }
                yield {
                  type: EventType.REASONING_ENCRYPTED_VALUE,
                  subtype: "message",
                  entityId: reasoningMessageId!,
                  encryptedValue: Buffer.from(delta.redactedContent).toString(
                    "base64",
                  ),
                };
              }
              continue;
            }

            // Tool call input streaming — emits PredictState → TOOL_CALL_START
            // → incremental TOOL_CALL_ARGS deltas. Tools declaring an
            // argsStreamer take the legacy burst-at-contentBlockStop path.
            if (delta.type === "toolUseInputDelta" && currentToolUse) {
              currentToolUse.inputChunks.push(delta.input);
              const { name: toolName, toolUseId: strandsToolId } =
                currentToolUse;
              const isFrontendTool = frontendToolNames.has(toolName);
              const toolUseId = _resolveToolUseId(
                toolCallsSeen,
                strandsToolId,
                isFrontendTool,
              );

              let entry = toolCallsSeen.get(toolUseId);
              if (!entry) {
                const isPendingNow = pendingToolResultIds.has(toolUseId);
                const behaviorNow = this.config.toolBehaviors?.[toolName];
                this._log.debug(
                  `${LOG_PREFIX} Tool call event received: toolName=${toolName}, ` +
                    `toolUseId=${toolUseId}, strandsId=${strandsToolId}, ` +
                    `isFrontend=${isFrontendTool}, threadId=${inputData.threadId}`,
                );
                // Use streaming (emit ToolCallStart + PredictState now,
                // ToolCallArgs on each growth, ToolCallEnd at
                // contentBlockStop) unless the tool is a continuation or
                // supplies a custom argsStreamer.
                const useStreaming =
                  !isPendingNow && !behaviorNow?.argsStreamer;
                entry = {
                  name: toolName,
                  args: "",
                  input: {},
                  raw: "",
                  emitted: false,
                  startEmitted: false,
                  endEmitted: false,
                  lastEmittedRawLen: 0,
                  isPending: isPendingNow,
                  isFrontend: isFrontendTool,
                  useStreaming,
                  strandsToolId,
                };
                toolCallsSeen.set(toolUseId, entry);

                if (useStreaming) {
                  // Close any open assistant text turn so the snapshot order
                  // matches the wire-event order and message_id can rotate.
                  if (messageStarted) {
                    yield { type: EventType.TEXT_MESSAGE_END, messageId };
                    if (emitMessagesSnapshot && accumulatedText) {
                      snapshotMessages.push({
                        id: messageId,
                        role: "assistant",
                        content: accumulatedText,
                      } as AguiAssistantMessage);
                      accumulatedText = "";
                      yield {
                        type: EventType.MESSAGES_SNAPSHOT,
                        messages: snapshotMessages.slice(),
                      };
                    }
                    messageStarted = false;
                    messageId = uuid();
                  }

                  // PredictState must reach the FE BEFORE any args delta so
                  // the FE knows which tool argument feeds which state key
                  // while parsing incremental JSON.
                  if (behaviorNow) {
                    const predict = normalizePredictState(
                      behaviorNow.predictState,
                    ).map(predictStateMappingToPayload);
                    if (predict.length > 0) {
                      yield {
                        type: EventType.CUSTOM,
                        name: "PredictState",
                        value: predict,
                      };
                    }
                  }

                  yield {
                    type: EventType.TOOL_CALL_START,
                    toolCallId: toolUseId,
                    toolCallName: toolName,
                    parentMessageId: messageId,
                  };
                  entry.startEmitted = true;
                }
              }

              // Rebuild the accumulated raw string and emit the growth as a
              // single TOOL_CALL_ARGS delta. The FE concatenates these into
              // the full args payload and parses incrementally.
              const rawStr = currentToolUse.inputChunks.join("");
              entry.raw = rawStr;
              try {
                entry.input = JSON.parse(rawStr);
              } catch {
                entry.input = rawStr;
              }
              entry.args =
                typeof entry.input === "string"
                  ? entry.input
                  : JSON.stringify(entry.input);

              if (entry.startEmitted && entry.useStreaming) {
                const lastLen = entry.lastEmittedRawLen ?? 0;
                if (rawStr.length > lastLen) {
                  yield {
                    type: EventType.TOOL_CALL_ARGS,
                    toolCallId: toolUseId,
                    delta: rawStr.slice(lastLen),
                  };
                  entry.lastEmittedRawLen = rawStr.length;
                }
              }
            }
            continue;
          }

          // Reasoning signature (verification token) — not exposed to UI.
          if (kind === "reasoningSignatureEvent") continue;

          // Content block start records tool metadata so toolUseInputDelta
          // can correlate its chunks to a tool. Strands v1 emits
          // `{ start: { type: "toolUseStart", name, toolUseId } }` — the
          // field is `.start`, not `.contentBlock`.
          if (kind === "modelContentBlockStartEvent") {
            const startWrap = event as unknown as {
              start?: { type?: string; name?: string; toolUseId?: string };
            };
            const s = startWrap.start;
            if (s?.type === "toolUseStart" && s.name) {
              currentToolUse = {
                name: s.name,
                toolUseId: s.toolUseId ?? uuid(),
                inputChunks: [],
              };
            }
            continue;
          }

          // Content block stop — signals tool input is complete.
          if (kind === "modelContentBlockStopEvent") {
            if (reasoningStarted) {
              yield {
                type: EventType.REASONING_MESSAGE_END,
                messageId: reasoningMessageId!,
              };
              yield {
                type: EventType.REASONING_END,
                messageId: reasoningMessageId!,
              };
              reasoningStarted = false;
              reasoningMessageId = undefined;
            }

            if (currentToolUse) {
              const {
                name: toolName,
                toolUseId: strandsToolId,
                inputChunks,
              } = currentToolUse;
              currentToolUse = null;
              const rawInput = inputChunks.join("");
              let parsedInput: unknown = {};
              if (rawInput) {
                try {
                  parsedInput = JSON.parse(rawInput);
                } catch (e) {
                  this._log.warn(
                    `${LOG_PREFIX} tool args JSON parse failed for ${toolName}; using raw string`,
                    e,
                  );
                  parsedInput = rawInput;
                }
              }
              const isFrontendTool = frontendToolNames.has(toolName);
              const toolUseId = _resolveToolUseId(
                toolCallsSeen,
                strandsToolId,
                isFrontendTool,
              );
              const argsStr =
                typeof parsedInput === "string"
                  ? parsedInput
                  : JSON.stringify(parsedInput);

              if (!toolCallsSeen.has(toolUseId)) {
                toolCallsSeen.set(toolUseId, {
                  name: toolName,
                  args: argsStr,
                  input: parsedInput,
                  emitted: false,
                  strandsToolId,
                  raw: rawInput,
                });
              } else {
                const entry = toolCallsSeen.get(toolUseId)!;
                entry.args = argsStr;
                entry.input = parsedInput;
                entry.raw = rawInput;
              }

              const entry = toolCallsSeen.get(toolUseId)!;
              const behavior = this.config.toolBehaviors?.[toolName];
              this._log.debug(
                `${LOG_PREFIX} contentBlockStop close: toolName=${toolName}, ` +
                  `toolUseId=${toolUseId}, isFrontendTool=${isFrontendTool}, ` +
                  `isPending=${entry.isPending ?? false}, useStreaming=${entry.useStreaming ?? false}, ` +
                  `threadId=${inputData.threadId}`,
              );

              if (entry.startEmitted && entry.useStreaming) {
                // Streaming path — PredictState + TOOL_CALL_START + per-delta
                // TOOL_CALL_ARGS already went on the wire. Flush any final
                // delta, then close the call.
                const lastLen = entry.lastEmittedRawLen ?? 0;
                if (rawInput.length > lastLen) {
                  yield {
                    type: EventType.TOOL_CALL_ARGS,
                    toolCallId: toolUseId,
                    delta: rawInput.slice(lastLen),
                  };
                  entry.lastEmittedRawLen = rawInput.length;
                }

                // stateFromArgs BEFORE TOOL_CALL_END: CopilotKit v2 releases
                // the predict_state buffer at TOOL_CALL_END. Delivering the
                // snapshot first means the FE has authoritative state in
                // hand at the moment prediction is released.
                if (behavior?.stateFromArgs) {
                  const callCtx: ToolCallContext = {
                    inputData,
                    toolName,
                    toolUseId,
                    toolInput: parsedInput,
                    argsStr,
                    ...buildContextExtras(inputData),
                  };
                  try {
                    const snapshot = await maybeAwait(
                      behavior.stateFromArgs(callCtx),
                    );
                    if (snapshot) {
                      Object.assign(currentState, snapshot);
                      yield { type: EventType.STATE_SNAPSHOT, snapshot };
                    }
                  } catch (e) {
                    this._log.error(
                      `${LOG_PREFIX} stateFromArgs failed for ${toolName}:`,
                      e,
                    );
                    yield {
                      type: EventType.CUSTOM,
                      name: "hook_error",
                      value: {
                        hook: "stateFromArgs",
                        tool: toolName,
                        error: _errorMessage(e),
                      },
                    };
                  }
                }

                yield { type: EventType.TOOL_CALL_END, toolCallId: toolUseId };
                entry.endEmitted = true;
                entry.emitted = true;

                // Splice point 2 of 4: append the assistant tool-call entry
                // to the running snapshot, then rotate message_id so the
                // next assistant turn carries a distinct id.
                if (emitMessagesSnapshot && !behavior?.skipMessagesSnapshot) {
                  snapshotMessages.push({
                    id: messageId,
                    role: "assistant",
                    content: "",
                    toolCalls: [
                      {
                        id: toolUseId,
                        type: "function",
                        function: {
                          name: toolName || "unknown",
                          arguments: argsStr || "{}",
                        },
                      },
                    ],
                  } as AguiAssistantMessage);
                  yield {
                    type: EventType.MESSAGES_SNAPSHOT,
                    messages: snapshotMessages.slice(),
                  };
                  messageId = uuid();
                }

                if (isFrontendTool && !behavior?.continueAfterFrontendCall) {
                  this._log.debug(
                    `${LOG_PREFIX} Deferring halt after frontend tool call: ` +
                      `toolName=${toolName}, toolCallId=${toolUseId}, threadId=${inputData.threadId}`,
                  );
                  pendingHalt = true;
                }
              } else {
                // Legacy burst path — behavior.argsStreamer is configured,
                // or a continuation turn where the tool is already resolved.
                yield* this._emitToolCall({
                  inputData,
                  toolUseId,
                  isFrontendTool,
                  pendingToolResultIds,
                  getMessageId: () => messageId,
                  setMessageId: (id: string) => {
                    messageId = id;
                  },
                  getMessageStarted: () => messageStarted,
                  setMessageStarted: (v: boolean) => {
                    messageStarted = v;
                  },
                  getAccumulatedText: () => accumulatedText,
                  setAccumulatedText: (v: string) => {
                    accumulatedText = v;
                  },
                  snapshotMessages,
                  emitMessagesSnapshot,
                  toolCallsSeen,
                  currentState,
                  onPendingHalt: () => {
                    pendingHalt = true;
                  },
                });
              }
            }
            continue;
          }

          // ContentBlock yielded post-stream as a completed `ToolUseBlock`.
          // The streaming path above already emitted the envelope via
          // `modelContentBlockStopEvent`; the `emitted` guard inside
          // `_emitToolCall` makes this a no-op when that already happened.
          // This branch also fires when a provider skips delta events
          // entirely (tests, some non-streaming configurations).
          if (kind === "toolUseBlock") {
            const block = event as unknown as ToolUseBlock;
            const isFrontendTool = frontendToolNames.has(block.name);
            const toolUseId = _resolveToolUseId(
              toolCallsSeen,
              block.toolUseId,
              isFrontendTool,
            );
            const argsStr =
              typeof block.input === "string"
                ? block.input
                : JSON.stringify(block.input);
            if (!toolCallsSeen.has(toolUseId)) {
              toolCallsSeen.set(toolUseId, {
                name: block.name,
                args: argsStr,
                input: block.input,
                emitted: false,
                strandsToolId: block.toolUseId,
              });
            } else {
              const e = toolCallsSeen.get(toolUseId)!;
              e.args = argsStr;
              e.input = block.input;
            }
            yield* this._emitToolCall({
              inputData,
              toolUseId,
              isFrontendTool,
              pendingToolResultIds,
              getMessageId: () => messageId,
              setMessageId: (id: string) => {
                messageId = id;
              },
              getMessageStarted: () => messageStarted,
              setMessageStarted: (v: boolean) => {
                messageStarted = v;
              },
              getAccumulatedText: () => accumulatedText,
              setAccumulatedText: (v: string) => {
                accumulatedText = v;
              },
              snapshotMessages,
              emitMessagesSnapshot,
              toolCallsSeen,
              currentState,
              onPendingHalt: () => {
                pendingHalt = true;
              },
            });
            continue;
          }

          // Tool results from Strands (backend tools). Maps to Python's
          // `"message" in event and event["message"]["role"] == "user"` branch.
          if (kind === "afterToolCallEvent") {
            if (pendingHalt) {
              // Frontend tool: the proxy "Forwarded to client" placeholder has
              // resolved and we don't want to feed it back to the model. Abort
              // the Strands stream so the LLM stops emitting another cycle and
              // we can finalise RUN_FINISHED.
              haltEventStream = true;
              try {
                runAbort.abort();
              } catch {
                // ignore
              }
              break;
            }
            const hookEvent = event as unknown as {
              toolUse: { toolUseId: string; name: string };
              result: ToolResultBlock;
            };
            const resultToolId = hookEvent.toolUse.toolUseId;
            const toolName = hookEvent.toolUse.name;

            // Skip placeholder results for proxied frontend tools.
            if (frontendToolNames.has(toolName)) continue;

            // Parse the content into a usable value. `result.content` is
            // required by the SDK type but can be missing on errors or
            // malformed tools. A void tool call (returns undefined/null) is
            // legitimate — emit an empty TOOL_CALL_RESULT so the UI still
            // renders a result card.
            let resultData: unknown = null;
            const contentBlocks = hookEvent.result?.content;
            if (Array.isArray(contentBlocks)) {
              for (const cb of contentBlocks) {
                if (cb instanceof TextBlock) {
                  try {
                    resultData = JSON.parse(cb.text);
                  } catch {
                    try {
                      resultData = JSON.parse(cb.text.replace(/'/g, '"'));
                    } catch (e) {
                      this._log.warn(
                        `${LOG_PREFIX} tool result JSON parse failed for ${toolName}; using raw text`,
                        e,
                      );
                      resultData = cb.text;
                    }
                  }
                  break;
                }
                const maybeJson = (cb as unknown as { json?: unknown }).json;
                if (maybeJson !== undefined) {
                  resultData = maybeJson;
                  break;
                }
              }
            }

            if (!resultToolId) continue;

            const callInfo = toolCallsSeen.get(resultToolId);
            const toolArgs = callInfo?.args;
            const toolInput = callInfo?.input;
            const behavior = this.config.toolBehaviors?.[toolName];

            this._log.debug(
              `${LOG_PREFIX} Processing tool result: toolName=${toolName}, ` +
                `resultToolId=${resultToolId}, threadId=${inputData.threadId}`,
            );

            // Emit TOOL_CALL_RESULT without a role field so the frontend
            // completes the tool in UI without adding it to the conversation
            // history. A fresh message id ensures CopilotKit creates a
            // standalone ToolMessage and closes the spinner correctly.
            const toolResultMessageId = uuid();
            const toolResultContent =
              resultData == null ? "" : JSON.stringify(resultData);
            yield {
              type: EventType.TOOL_CALL_RESULT,
              toolCallId: resultToolId,
              messageId: toolResultMessageId,
              content: toolResultContent,
            };

            // Splice point 3 of 4: append the ToolMessage to the running
            // snapshot so the frontend can pair call + result.
            if (emitMessagesSnapshot && !behavior?.skipMessagesSnapshot) {
              snapshotMessages.push({
                id: toolResultMessageId,
                role: "tool",
                content: toolResultContent,
                toolCallId: resultToolId,
              } as AguiToolMessage);
              yield {
                type: EventType.MESSAGES_SNAPSHOT,
                messages: snapshotMessages.slice(),
              };
            }

            const resultContext: ToolResultContext = {
              inputData,
              toolName,
              toolUseId: resultToolId,
              toolInput,
              argsStr: toolArgs ?? "{}",
              resultData,
              messageId,
              ...buildContextExtras(inputData),
            };

            if (behavior?.stateFromResult) {
              try {
                const snapshot = await maybeAwait(
                  behavior.stateFromResult(resultContext),
                );
                if (snapshot) {
                  Object.assign(currentState, snapshot);
                  yield { type: EventType.STATE_SNAPSHOT, snapshot };
                }
              } catch (e) {
                this._log.error(
                  `${LOG_PREFIX} stateFromResult failed for ${toolName}:`,
                  e,
                );
                yield {
                  type: EventType.CUSTOM,
                  name: "hook_error",
                  value: {
                    hook: "stateFromResult",
                    tool: toolName,
                    error: _errorMessage(e),
                  },
                };
              }
            }

            if (behavior?.customResultHandler) {
              try {
                for await (const customEvent of behavior.customResultHandler(
                  resultContext,
                )) {
                  if (customEvent) yield customEvent;
                }
              } catch (e) {
                this._log.error(
                  `${LOG_PREFIX} customResultHandler failed for ${toolName}:`,
                  e,
                );
                yield {
                  type: EventType.CUSTOM,
                  name: "hook_error",
                  value: {
                    hook: "customResultHandler",
                    tool: toolName,
                    error: _errorMessage(e),
                  },
                };
              }
            }

            if (behavior?.stopStreamingAfterResult) {
              stopTextStreaming = true;
              if (messageStarted) {
                yield { type: EventType.TEXT_MESSAGE_END, messageId };
                messageStarted = false;
                // Splice point 4 of 4 (early-exit): commit accumulated
                // assistant text into the snapshot.
                if (emitMessagesSnapshot && accumulatedText) {
                  snapshotMessages.push({
                    id: messageId,
                    role: "assistant",
                    content: accumulatedText,
                  } as AguiAssistantMessage);
                  accumulatedText = "";
                  yield {
                    type: EventType.MESSAGES_SNAPSHOT,
                    messages: snapshotMessages.slice(),
                  };
                }
              }
              this._log.debug(
                `${LOG_PREFIX} Breaking event stream: stopStreamingAfterResult behavior triggered ` +
                  `(threadId=${inputData.threadId}, toolName=${toolName})`,
              );
              haltEventStream = true;
              break;
            }
            continue;
          }

          // Tools can yield state updates mid-execution as toolStreamEvent.
          if (kind === "toolStreamEvent") {
            const stream = event as unknown as { data?: unknown };
            const data = stream.data;
            if (data && typeof data === "object" && "state" in data) {
              yield {
                type: EventType.STATE_SNAPSHOT,
                snapshot: (data as { state: Record<string, unknown> }).state,
              };
            }
            continue;
          }

          // Multi-agent events (only fire when `agent` is a Graph/Swarm —
          // also possible when an agent wraps a subgraph).
          const maEvent = event as unknown as {
            type?: string;
            nodeId?: string;
            nodeType?: string;
            source?: string;
            targets?: string[];
          };
          if (maEvent?.type === "beforeNodeCallEvent") {
            // stepName must match the paired afterNodeCallEvent below so
            // frontends can pair START/FINISH (events.mdx §StepFinished).
            yield {
              type: EventType.STEP_STARTED,
              stepName: `${maEvent.nodeType ?? "agent"}:${maEvent.nodeId ?? "unknown"}`,
            };
            continue;
          }
          if (maEvent?.type === "afterNodeCallEvent") {
            yield {
              type: EventType.STEP_FINISHED,
              stepName: `${maEvent.nodeType ?? "agent"}:${maEvent.nodeId ?? "unknown"}`,
            };
            continue;
          }
          if (maEvent?.type === "multiAgentHandoffEvent") {
            // Py wire shape: { from_nodes, to_nodes, message }. TS SDK gives
            // `source` + `targets`; wrap source in an array to preserve the
            // Py shape so downstream consumers don't need per-backend branching.
            const handoffMsg = (maEvent as { message?: string }).message;
            yield {
              type: EventType.CUSTOM,
              name: "MultiAgentHandoff",
              value: {
                from_nodes: maEvent.source ? [maEvent.source] : [],
                to_nodes: maEvent.targets ?? [],
                message: handoffMsg,
              },
            };
            continue;
          }
          // Ignore events we don't translate (BeforeInvocationEvent,
          // ModelStreamEventHook wrappers, etc.).
        }
      } finally {
        // Consumer bailed (client disconnect, frontend-tool halt, error).
        // Fire the abort signal so Strands stops its Bedrock fetch at the
        // next checkpoint, then drain the generator so cleanup hooks run.
        try {
          runAbort.abort();
        } catch {
          // ignore
        }
        try {
          await agentStream.return(undefined as never);
        } catch {
          // ignore — cancellation typically surfaces as CancelledError
        }
      }

      if (reasoningStarted) {
        yield {
          type: EventType.REASONING_MESSAGE_END,
          messageId: reasoningMessageId!,
        };
        yield { type: EventType.REASONING_END, messageId: reasoningMessageId! };
      }

      if (messageStarted) {
        yield { type: EventType.TEXT_MESSAGE_END, messageId };
        // Splice point 4 of 4 (terminal): commit the final assistant text
        // turn into the snapshot.
        if (emitMessagesSnapshot && accumulatedText) {
          snapshotMessages.push({
            id: messageId,
            role: "assistant",
            content: accumulatedText,
          } as AguiAssistantMessage);
          accumulatedText = "";
          yield {
            type: EventType.MESSAGES_SNAPSHOT,
            messages: snapshotMessages.slice(),
          };
        }
      }

      // Final state snapshot with `currentState` verbatim. Unlike the initial
      // snapshot this is not filtered — the initial filter exists only to
      // protect frontends that don't recognise the "tool" role.
      yield { type: EventType.STATE_SNAPSHOT, snapshot: currentState };

      // Interrupt-variant RUN_FINISHED. The STATE_SNAPSHOT +
      // MESSAGES_SNAPSHOT above precede this per interrupts.mdx §"State at
      // the interrupt boundary". IDs are recorded on
      // `_pendingInterruptsByThread` for the `run()` resume gate.
      if (finalAgentResult?.stopReason === "interrupt") {
        const strandsInterrupts = finalAgentResult.interrupts ?? [];
        if (strandsInterrupts.length > 0) {
          const interruptIds = strandsInterrupts.map((i) => i.id);
          this._pendingInterruptsByThread.set(threadId, new Set(interruptIds));
          yield {
            type: EventType.RUN_FINISHED,
            threadId: inputData.threadId,
            runId: inputData.runId,
            outcome: {
              type: "interrupt",
              interrupts: strandsInterrupts.map(strandsInterruptToAgui),
            },
          };
          return;
        }
      }

      yield {
        type: EventType.RUN_FINISHED,
        threadId: inputData.threadId,
        runId: inputData.runId,
      };
    } catch (e) {
      const code =
        e instanceof TypeError || e instanceof ReferenceError
          ? "ADAPTER_BUG"
          : "STRANDS_ERROR";
      this._log.error(`${LOG_PREFIX} _runSingleAgent failed:`, e);
      yield _runError(_errorMessage(e), code);
    }
  }

  /**
   * Legacy burst path for tool calls — invoked when the Strands SDK delivers
   * a complete `ToolUseBlock` or when a `ToolBehavior.argsStreamer` takes
   * over args emission at contentBlockStop.
   *
   * The streaming path inside `_runSingleAgent` handles the common case
   * directly; this helper handles continuation turns and custom streamers.
   *
   * Getters/setters surface the caller's local variables because JS closures
   * capture by reference only for `const` / `let` in scope — an object of
   * mutable fields would work but would require threading `state` through
   * `_runSingleAgent`'s long body.
   */
  private async *_emitToolCall(ctx: {
    inputData: RunAgentInput;
    toolUseId: string;
    isFrontendTool: boolean;
    pendingToolResultIds: Set<string>;
    getMessageId: () => string;
    setMessageId: (id: string) => void;
    getMessageStarted: () => boolean;
    setMessageStarted: (v: boolean) => void;
    getAccumulatedText: () => string;
    setAccumulatedText: (v: string) => void;
    snapshotMessages: AguiMessage[];
    emitMessagesSnapshot: boolean;
    toolCallsSeen: Map<string, SeenToolCall>;
    currentState: Record<string, unknown>;
    onPendingHalt: () => void;
  }): AsyncGenerator<BaseEvent, void, void> {
    const entry = ctx.toolCallsSeen.get(ctx.toolUseId);
    if (!entry || entry.emitted) return;
    entry.emitted = true;
    const toolName = entry.name;
    const argsStr = entry.args;
    const toolInput = entry.input;
    const behavior = this.config.toolBehaviors?.[toolName];
    const isPending = ctx.pendingToolResultIds.has(ctx.toolUseId);

    const callContext: ToolCallContext = {
      inputData: ctx.inputData,
      toolName,
      toolUseId: ctx.toolUseId,
      toolInput,
      argsStr,
      ...buildContextExtras(ctx.inputData),
    };

    // Continuation turn — tool already resolved in conversation history.
    // Don't re-emit wire events, but fire state callbacks so derived state
    // stays consistent.
    if (isPending) {
      if (behavior?.stateFromArgs) {
        try {
          const snapshot = await maybeAwait(
            behavior.stateFromArgs(callContext),
          );
          if (snapshot) {
            Object.assign(ctx.currentState, snapshot);
            yield { type: EventType.STATE_SNAPSHOT, snapshot };
          }
        } catch (e) {
          this._log.error(
            `${LOG_PREFIX} stateFromArgs failed for ${toolName}:`,
            e,
          );
          yield {
            type: EventType.CUSTOM,
            name: "hook_error",
            value: {
              hook: "stateFromArgs",
              tool: toolName,
              error: _errorMessage(e),
            },
          };
        }
      }
      return;
    }

    // stateFromArgs BEFORE TOOL_CALL_START seeds the frontend's derived
    // state before the predict_state buffer opens.
    if (behavior?.stateFromArgs) {
      try {
        const snapshot = await maybeAwait(behavior.stateFromArgs(callContext));
        if (snapshot) {
          Object.assign(ctx.currentState, snapshot);
          yield { type: EventType.STATE_SNAPSHOT, snapshot };
        }
      } catch (e) {
        this._log.error(
          `${LOG_PREFIX} stateFromArgs failed for ${toolName}:`,
          e,
        );
        yield {
          type: EventType.CUSTOM,
          name: "hook_error",
          value: {
            hook: "stateFromArgs",
            tool: toolName,
            error: _errorMessage(e),
          },
        };
      }
    }

    if (behavior) {
      const predict = normalizePredictState(behavior.predictState).map(
        predictStateMappingToPayload,
      );
      if (predict.length > 0) {
        yield { type: EventType.CUSTOM, name: "PredictState", value: predict };
      }
    }

    // Close any open assistant text turn and commit its content to the
    // snapshot before rotating message_id.
    if (ctx.getMessageStarted()) {
      yield { type: EventType.TEXT_MESSAGE_END, messageId: ctx.getMessageId() };
      const acc = ctx.getAccumulatedText();
      if (ctx.emitMessagesSnapshot && acc) {
        ctx.snapshotMessages.push({
          id: ctx.getMessageId(),
          role: "assistant",
          content: acc,
        } as AguiAssistantMessage);
        ctx.setAccumulatedText("");
        yield {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: ctx.snapshotMessages.slice(),
        };
      }
      ctx.setMessageStarted(false);
      ctx.setMessageId(uuid());
    }

    yield {
      type: EventType.TOOL_CALL_START,
      toolCallId: ctx.toolUseId,
      toolCallName: toolName,
      parentMessageId: ctx.getMessageId(),
    };

    let streamerFailed = false;
    if (behavior?.argsStreamer) {
      try {
        for await (const chunk of behavior.argsStreamer(callContext)) {
          if (chunk == null) continue;
          yield {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: ctx.toolUseId,
            delta: String(chunk),
          };
        }
      } catch (e) {
        streamerFailed = true;
        this._log.error(
          `${LOG_PREFIX} argsStreamer failed for ${toolName}:`,
          e,
        );
        yield {
          type: EventType.CUSTOM,
          name: "hook_error",
          value: {
            hook: "argsStreamer",
            tool: toolName,
            error: _errorMessage(e),
          },
        };
      }
    } else {
      yield {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: ctx.toolUseId,
        delta: argsStr,
      };
    }

    if (streamerFailed) {
      yield { type: EventType.TOOL_CALL_END, toolCallId: ctx.toolUseId };
      return;
    }

    yield { type: EventType.TOOL_CALL_END, toolCallId: ctx.toolUseId };

    // Splice point 2 of 4: append the assistant tool-call entry to the
    // snapshot, then rotate message_id.
    if (ctx.emitMessagesSnapshot && !behavior?.skipMessagesSnapshot) {
      ctx.snapshotMessages.push({
        id: ctx.getMessageId(),
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: ctx.toolUseId,
            type: "function",
            function: {
              name: toolName || "unknown",
              arguments: argsStr || "{}",
            },
          },
        ],
      } as AguiAssistantMessage);
      yield {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: ctx.snapshotMessages.slice(),
      };
      ctx.setMessageId(uuid());
    }

    if (ctx.isFrontendTool && !behavior?.continueAfterFrontendCall) {
      this._log.debug(
        `${LOG_PREFIX} Deferring halt after frontend tool call: ` +
          `toolName=${toolName}, toolCallId=${ctx.toolUseId}, threadId=${ctx.inputData.threadId}`,
      );
      ctx.onPendingHalt();
    }
  }

  /**
   * Orchestrator-mode run loop. TypeScript-only: drives a `Graph` or `Swarm`
   * `.stream()` call and translates multi-agent events. Per-thread caching,
   * session managers, and proxy-tool sync don't apply.
   */
  private async *_runOrchestrator(
    inputData: RunAgentInput,
  ): AsyncGenerator<BaseEvent, void, void> {
    yield _runStarted(inputData);
    try {
      if (inputData.state && typeof inputData.state === "object") {
        const snapshot: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(
          inputData.state as Record<string, unknown>,
        )) {
          if (k !== "messages") snapshot[k] = v;
        }
        yield { type: EventType.STATE_SNAPSHOT, snapshot };
      }

      // Orchestrators take string | ContentBlock[] (MultiAgentInput); extract
      // text from the last user/tool turn.
      let prompt = "Hello";
      if (inputData.messages) {
        for (let i = inputData.messages.length - 1; i >= 0; i--) {
          const msg = inputData.messages[i];
          if (!msg) break;
          if (
            (msg.role === "user" || msg.role === "tool") &&
            msg.content != null
          ) {
            prompt =
              typeof msg.content === "string"
                ? msg.content
                : flattenContentToText(msg.content);
            break;
          }
        }
      }

      let messageId = uuid();
      let messageStarted = false;
      let reasoningStarted = false;
      let reasoningMessageId: string | undefined;

      const orchestratorStream = this._orchestrator!.stream(prompt);
      try {
        for await (const rawEvent of orchestratorStream) {
          const event = unwrapStrandsEvent(rawEvent);
          const kind = getEventKind(event);

          if (kind === "beforeNodeCallEvent") {
            const ev = event as { nodeId?: string; nodeType?: string };
            // stepName must match the paired afterNodeCallEvent below so
            // frontends can pair START/FINISH (events.mdx §StepFinished).
            yield {
              type: EventType.STEP_STARTED,
              stepName: `${ev.nodeType ?? "agent"}:${ev.nodeId ?? "unknown"}`,
            };
            continue;
          }
          if (kind === "afterNodeCallEvent") {
            const ev = event as { nodeId?: string; nodeType?: string };
            if (messageStarted) {
              yield { type: EventType.TEXT_MESSAGE_END, messageId };
              messageStarted = false;
              messageId = uuid();
            }
            if (reasoningStarted) {
              yield {
                type: EventType.REASONING_MESSAGE_END,
                messageId: reasoningMessageId!,
              };
              yield {
                type: EventType.REASONING_END,
                messageId: reasoningMessageId!,
              };
              reasoningStarted = false;
              reasoningMessageId = undefined;
            }
            yield {
              type: EventType.STEP_FINISHED,
              stepName: `${ev.nodeType ?? "agent"}:${ev.nodeId ?? "unknown"}`,
            };
            continue;
          }
          if (kind === "multiAgentHandoffEvent") {
            const ev = event as {
              source?: string;
              targets?: string[];
              message?: string;
            };
            yield {
              type: EventType.CUSTOM,
              name: "MultiAgentHandoff",
              value: {
                from_nodes: ev.source ? [ev.source] : [],
                to_nodes: ev.targets ?? [],
                message: ev.message,
              },
            };
            continue;
          }
          if (kind === "nodeStreamUpdateEvent") {
            // Inner event is the agent-level event emitted by the wrapped agent.
            const ev = event as {
              inner?: { source?: string; event?: unknown };
            };
            const inner = ev.inner?.event
              ? unwrapStrandsEvent(ev.inner.event)
              : undefined;
            if (getEventKind(inner) === "modelContentBlockDeltaEvent") {
              const delta = (
                inner as { delta?: { type?: string; text?: string } }
              ).delta;
              if (delta?.type === "textDelta" && delta.text) {
                if (!messageStarted) {
                  yield {
                    type: EventType.TEXT_MESSAGE_START,
                    messageId,
                    role: "assistant",
                  };
                  messageStarted = true;
                }
                yield {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId,
                  delta: delta.text,
                };
              } else if (delta?.type === "reasoningContentDelta" && delta.text) {
                if (!reasoningStarted) {
                  reasoningMessageId = uuid();
                  yield {
                    type: EventType.REASONING_START,
                    messageId: reasoningMessageId,
                  };
                  yield {
                    type: EventType.REASONING_MESSAGE_START,
                    messageId: reasoningMessageId,
                    role: "reasoning",
                  };
                  reasoningStarted = true;
                }
                yield {
                  type: EventType.REASONING_MESSAGE_CONTENT,
                  messageId: reasoningMessageId!,
                  delta: delta.text,
                };
              }
            }
            continue;
          }
        }
      } finally {
        try {
          await orchestratorStream.return(undefined as never);
        } catch {
          // ignore
        }
      }

      if (messageStarted) {
        yield { type: EventType.TEXT_MESSAGE_END, messageId };
      }
      if (reasoningStarted) {
        yield {
          type: EventType.REASONING_MESSAGE_END,
          messageId: reasoningMessageId!,
        };
        yield { type: EventType.REASONING_END, messageId: reasoningMessageId! };
      }
      yield { type: EventType.STATE_SNAPSHOT, snapshot: {} };
      yield {
        type: EventType.RUN_FINISHED,
        threadId: inputData.threadId,
        runId: inputData.runId,
      };
    } catch (e) {
      const code =
        e instanceof TypeError || e instanceof ReferenceError
          ? "ADAPTER_BUG"
          : "STRANDS_ERROR";
      this._log.error(`${LOG_PREFIX} _runOrchestrator failed:`, e);
      yield _runError(_errorMessage(e), code);
    }
  }

  private _buildThreadAgentConfig(
    sessionManager?: SessionManager,
    seedMessages?: AgentConfig["messages"],
  ): AgentConfig {
    const t = this._templateFields;
    const cfg: AgentConfig = {
      model: t.model,
      tools: t.tools.slice(),
      printer: false,
    };
    if (t.systemPrompt !== undefined) cfg.systemPrompt = t.systemPrompt;
    if (t.name !== undefined) cfg.name = t.name;
    if (t.description !== undefined) cfg.description = t.description;
    if (t.id !== undefined) cfg.id = t.id;
    if (t.appState !== undefined) cfg.appState = t.appState;
    if (t.modelState !== undefined) cfg.modelState = t.modelState;
    if (t.traceAttributes !== undefined)
      cfg.traceAttributes = t.traceAttributes;
    if (t.structuredOutputSchema !== undefined)
      cfg.structuredOutputSchema = t.structuredOutputSchema;
    if (t.toolExecutor !== undefined) cfg.toolExecutor = t.toolExecutor;
    if (sessionManager) cfg.sessionManager = sessionManager;
    if (seedMessages && seedMessages.length > 0) cfg.messages = seedMessages;
    // Only forward plugins when the caller supplied them explicitly. Passing
    // `plugins: []` risks being interpreted by a future SDK as "disable
    // default plugins".
    if (this._plugins.length > 0) cfg.plugins = [...this._plugins];
    return cfg;
  }
}

// ---------- TypeScript-only helpers (no Python equivalent) ----------

/**
 * Async mutex modelled on Python's `asyncio.Lock`. Serializes first-time
 * thread initialization so concurrent requests for the same new threadId
 * don't both construct a per-thread agent.
 */
class AsyncMutex {
  private _tail: Promise<void> = Promise.resolve();
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this._tail;
    this._tail = next;
    await previous;
    return release;
  }
}

function _runStarted(input: RunAgentInput): BaseEvent {
  return {
    type: EventType.RUN_STARTED,
    threadId: input.threadId,
    runId: input.runId,
  };
}

function _runError(message: string, code: string): BaseEvent {
  return { type: EventType.RUN_ERROR, message, code };
}

/** Non-empty `resume[]` entries, or `[]` if missing. */
function resolveResumeEntries(input: RunAgentInput): ResumeEntry[] {
  const resume = (input as { resume?: ResumeEntry[] }).resume;
  return Array.isArray(resume) && resume.length > 0 ? resume : [];
}

/** AG-UI `ResumeEntry` → Strands `InterruptResponseContent.response`. */
function toResumeResponse(entry: ResumeEntry): unknown {
  if (entry.status === "cancelled") {
    return { status: "cancelled" };
  }
  return entry.payload as unknown;
}

/** Strands `Interrupt` → AG-UI `Interrupt`. */
function strandsInterruptToAgui(interrupt: StrandsInterrupt): AguiInterrupt {
  const reasonRaw = interrupt.reason;
  const reason =
    typeof reasonRaw === "string" && reasonRaw.length > 0
      ? reasonRaw
      : "confirmation";
  const out: AguiInterrupt = { id: interrupt.id, reason };
  if (typeof reasonRaw === "string" && reasonRaw.length > 0) {
    out.message = reasonRaw;
  } else if (reasonRaw != null) {
    try {
      out.message = JSON.stringify(reasonRaw);
    } catch {
      // non-serializable reason; leave message unset
    }
  }
  out.metadata = { strandsName: interrupt.name };
  return out;
}

function getEventKind(event: unknown): string | undefined {
  if (event && typeof event === "object" && "type" in event) {
    const t = (event as { type: unknown }).type;
    return typeof t === "string" ? t : undefined;
  }
  return undefined;
}

/**
 * Unwrap wrapper hook events the Strands v1 SDK uses to decorate raw model,
 * content-block, and tool-stream events:
 *   `ModelStreamUpdateEvent → .event`
 *   `ContentBlockEvent → .contentBlock`
 *   `ToolStreamUpdateEvent → .event` (inner `ToolStreamEvent` carries
 *     the per-yield payload a tool's async generator produces)
 * Anything else passes through.
 */
function unwrapStrandsEvent(event: unknown): unknown {
  if (!event || typeof event !== "object") return event;
  const kind = (event as { type?: unknown }).type;
  if (kind === "modelStreamUpdateEvent" && "event" in event) {
    return (event as { event: unknown }).event;
  }
  if (kind === "toolStreamUpdateEvent" && "event" in event) {
    return (event as { event: unknown }).event;
  }
  if (kind === "contentBlockEvent" && "contentBlock" in event) {
    return (event as { contentBlock: unknown }).contentBlock;
  }
  return event;
}

/**
 * Transform explicit START/CONTENT/END triples into self-expanding chunk
 * equivalents, driven by `StrandsAgentConfig.emitChunkEvents`.
 *
 * Per `concepts/events.mdx` (TextMessageChunk):
 * - First chunk carries `messageId` (+ optional `role`) — the client
 *   transformer auto-emits `TEXT_MESSAGE_START`.
 * - Each chunk with a `delta` auto-emits `TEXT_MESSAGE_CONTENT`.
 * - `TEXT_MESSAGE_END` is auto-emitted by the client transformer when
 *   ids change or the stream ends — we drop our explicit END event.
 *
 * Same pattern for `TOOL_CALL_*` and `REASONING_MESSAGE_*`.
 */
async function* collapseToChunkEvents(
  source: AsyncGenerator<BaseEvent, void, void>,
): AsyncGenerator<BaseEvent, void, void> {
  for await (const event of source) {
    switch (event.type) {
      case EventType.TEXT_MESSAGE_START: {
        const e = event as { messageId?: string; role?: string };
        yield {
          type: EventType.TEXT_MESSAGE_CHUNK,
          messageId: e.messageId,
          role: e.role,
        } as BaseEvent;
        break;
      }
      case EventType.TEXT_MESSAGE_CONTENT: {
        const e = event as { messageId?: string; delta?: string };
        yield {
          type: EventType.TEXT_MESSAGE_CHUNK,
          messageId: e.messageId,
          delta: e.delta,
        } as BaseEvent;
        break;
      }
      case EventType.TEXT_MESSAGE_END:
        break;
      case EventType.TOOL_CALL_START: {
        const e = event as {
          toolCallId?: string;
          toolCallName?: string;
          parentMessageId?: string;
        };
        yield {
          type: EventType.TOOL_CALL_CHUNK,
          toolCallId: e.toolCallId,
          toolCallName: e.toolCallName,
          parentMessageId: e.parentMessageId,
        } as BaseEvent;
        break;
      }
      case EventType.TOOL_CALL_ARGS: {
        const e = event as { toolCallId?: string; delta?: string };
        yield {
          type: EventType.TOOL_CALL_CHUNK,
          toolCallId: e.toolCallId,
          delta: e.delta,
        } as BaseEvent;
        break;
      }
      case EventType.TOOL_CALL_END:
        break;
      case EventType.REASONING_MESSAGE_START: {
        const e = event as { messageId?: string };
        yield {
          type: EventType.REASONING_MESSAGE_CHUNK,
          messageId: e.messageId,
        } as BaseEvent;
        break;
      }
      case EventType.REASONING_MESSAGE_CONTENT: {
        const e = event as { messageId?: string; delta?: string };
        yield {
          type: EventType.REASONING_MESSAGE_CHUNK,
          messageId: e.messageId,
          delta: e.delta,
        } as BaseEvent;
        break;
      }
      case EventType.REASONING_MESSAGE_END:
        break;
      default:
        yield event;
    }
  }
}

/**
 * Build the message-history seed handed to `AgentConfig.messages` on
 * cold-cache agent creation. TypeScript-only: the Python SDK mutates
 * `Agent.messages` in place after construction via
 * `_buildStrandsHistory`, whereas the TS SDK consumes a seed at
 * construction time.
 *
 * - Normal run (tail is a `user` turn): seed everything except the final
 *   user turn; the final turn is passed to `agent.stream(...)` as the
 *   fresh prompt.
 * - Continuation run (tail is a `tool` message) or orphan tail: seed the
 *   entire history so the agent sees its own tool call + result before the
 *   synthetic continuation prompt fires.
 *
 * Returns `undefined` when the resulting seed would be empty or would
 * start with an `assistant` turn (Bedrock rejects assistant-first history).
 */
export async function buildStrandsSeed(
  messages: AguiMessage[],
  log?: Logger,
): Promise<AgentConfig["messages"]> {
  if (messages.length === 0) return undefined;

  let sliceEnd = messages.length;
  const tail = messages[messages.length - 1];
  if (tail?.role === "user") sliceEnd = messages.length - 1;
  if (sliceEnd <= 0) return undefined;

  const seed = await convertMessagesForStrandsSeed(
    messages.slice(0, sliceEnd),
    log,
  );
  if (seed.length === 0) return undefined;

  // Bedrock requires history to start with `user`; trim any leading
  // assistant turns (rare, e.g. bot-initiated UIs).
  while (seed.length > 0 && seed[0]?.role !== "user") seed.shift();
  if (seed.length === 0) return undefined;

  return seed as unknown as AgentConfig["messages"];
}

/**
 * Convert AG-UI messages into the `MessageData` shape `AgentConfig.messages`
 * accepts on cold-cache agent construction. Similar in spirit to
 * `_buildStrandsHistory` but drops orphan tool turns (Bedrock rejects them).
 */
export async function convertMessagesForStrandsSeed(
  messages: AguiMessage[],
  log?: Logger,
): Promise<Array<{ role: "user" | "assistant"; content: unknown[] }>> {
  const out: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];
  let pendingToolCalls: Map<string, string> | null = null;
  let pendingToolResults: unknown[] | null = null;

  const flushToolResults = (): void => {
    if (pendingToolResults && pendingToolResults.length > 0) {
      out.push({ role: "user", content: pendingToolResults });
    }
    pendingToolResults = null;
    pendingToolCalls = null;
  };

  for (const msg of messages) {
    const role = msg.role;
    if (role === "system" || role === "developer") continue;

    if (role === "assistant") {
      flushToolResults();
      const toolCalls = (
        msg as {
          toolCalls?: {
            id: string;
            function: { name: string; arguments: string };
          }[];
        }
      ).toolCalls;
      const content: unknown[] = [];
      if (typeof msg.content === "string" && msg.content.length > 0) {
        content.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        // Assistant-side multimodal history is rare — preserve text only.
        for (const c of msg.content) {
          if (c && typeof c === "object" && "text" in (c as object)) {
            content.push({ text: (c as { text: string }).text });
          }
        }
      }
      if (toolCalls && toolCalls.length > 0) {
        pendingToolCalls = new Map();
        for (const tc of toolCalls) {
          if (!tc?.id || !tc.function?.name) continue;
          let input: unknown = {};
          try {
            input = tc.function.arguments
              ? JSON.parse(tc.function.arguments)
              : {};
          } catch (e) {
            log?.warn(
              `${LOG_PREFIX} seed tool args JSON parse failed for ${tc.function.name}; using raw string`,
              e,
            );
            input = tc.function.arguments ?? {};
          }
          content.push({
            toolUse: { name: tc.function.name, toolUseId: tc.id, input },
          });
          pendingToolCalls.set(tc.id, tc.function.name);
        }
      }
      if (content.length === 0) continue;
      out.push({ role: "assistant", content });
      continue;
    }

    if (role === "tool") {
      const toolCallId = (msg as { toolCallId?: string }).toolCallId;
      if (!toolCallId || !pendingToolCalls || !pendingToolCalls.has(toolCallId))
        continue;
      const rawContent: unknown = (msg as { content?: unknown }).content;
      const textContent =
        typeof rawContent === "string"
          ? rawContent
          : Array.isArray(rawContent)
            ? (rawContent as unknown[])
                .map((c) =>
                  c && typeof c === "object" && "text" in (c as object)
                    ? ((c as { text?: string }).text ?? "")
                    : "",
                )
                .join("")
            : "";
      pendingToolResults ??= [];
      pendingToolResults.push({
        toolResult: {
          toolUseId: toolCallId,
          status: "success" as const,
          content: [{ text: textContent }],
        },
      });
      continue;
    }

    // role === "user"
    flushToolResults();
    const content: unknown[] = [];
    const rawUserContent = msg.content;
    if (typeof rawUserContent === "string") {
      if (rawUserContent.length > 0) content.push({ text: rawUserContent });
    } else if (Array.isArray(rawUserContent)) {
      const hasMedia = rawUserContent.some((c: unknown) => {
        if (!c || typeof c !== "object") return false;
        const type = (c as { type?: string }).type;
        return (
          type === "image" ||
          type === "audio" ||
          type === "video" ||
          type === "document"
        );
      });
      if (hasMedia) {
        try {
          const blocks = await convertAguiContentToStrands(
            rawUserContent as never,
            log,
          );
          for (const b of blocks) {
            if (b instanceof TextBlock) {
              content.push({ text: b.text });
            } else {
              // Image/Video/Document `toJSON()` emits the wrapped
              // discriminated union the MessageData schema expects.
              const serialised =
                typeof (b as { toJSON?: () => unknown }).toJSON === "function"
                  ? (b as { toJSON: () => unknown }).toJSON()
                  : b;
              content.push(serialised);
            }
          }
        } catch (e) {
          (log ?? DEFAULT_LOGGER).warn(
            `${LOG_PREFIX} seed multimodal conversion failed; dropping attachments for this turn`,
            e,
          );
          const text = flattenContentToText(rawUserContent as never);
          if (text.length > 0) content.push({ text });
        }
      } else {
        for (const c of rawUserContent) {
          if (c && typeof c === "object" && "text" in (c as object)) {
            content.push({ text: (c as { text: string }).text });
          }
        }
      }
    }
    if (content.length === 0) continue;
    out.push({ role: "user", content });
  }

  flushToolResults();
  return out;
}
