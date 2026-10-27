import { NativeChildRecovery } from "./native-recovery";
import { startLoopbackMcp } from "./loopback-mcp";
import {
  RecoveryRun,
  unresolvedToolUses,
  historicalToolResults,
  type SessionBinding,
} from "./recovery";
import {
  getSessionInfo,
  getSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
/**
 * Claude Agent SDK adapter for AG-UI protocol.
 */

import { Observable, Subscriber } from "rxjs";
import { AbstractAgent, EventType, randomUUID } from "@ag-ui/client";
import {
  PROTOCOL_VERSION,
  type BaseEvent,
  type RunAgentInput,
  type Message,
  type ToolMessage,
} from "@ag-ui/core";

import { createSdkMcpServer, query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Query,
  HookCallback,
  Options,
  SDKResultMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";

import type { ClaudeAgentAdapterConfig, ProcessedEvent } from "./types";
import {
  ALLOWED_FORWARDED_PROPS,
  STATE_MANAGEMENT_TOOL_NAME,
  STATE_MANAGEMENT_TOOL_FULL_NAME,
  AG_UI_MCP_SERVER_NAME,
} from "./config";
import {
  type FrontendToolResult,
  processMessages,
  recoveryUserMessages,
  buildStateContextAddendum,
  extractToolNames,
  stripMcpPrefix,
  convertAguiToolToClaudeSdk,
  createStateManagementTool,
  applyForwardedProps,
  hasState,
  buildAguiAssistantMessage,
  buildAguiToolMessage,
  mergeStateUpdate,
  unsupportedInputParts,
  isStateManagementTool,
} from "./utils";
import { handleToolUseBlock } from "./handlers";

/**
 * AG-UI adapter for the Anthropic Claude Agent SDK.
 *
 * Manages the SDK query lifecycle internally via per-request `query()` calls
 * with session resume for multi-turn. Call `adapter.run(input)` to get an
 * Observable of AG-UI events.
 *
 * **Header forwarding:** CopilotKit Runtime sets `agent.headers` with per-request
 * forwarded headers (e.g. `x-aimock-context`, `x-test-id`). This property is
 * declared here for forward compatibility so the runtime's assignment is not lost.
 * However, headers are NOT functionally forwarded to LLM calls because the Claude
 * Agent SDK is process-based — `query()` spawns a CLI child process, and there is
 * no mechanism to inject HTTP headers into the LLM API calls made by that process.
 *
 * If the Claude Agent SDK adds a `headers` or `extraHeaders` option to its
 * `Options` type in the future, this adapter should wire `this.headers` through
 * at that point.
 */
export class ClaudeAgentAdapter extends AbstractAgent {
  private static readonly DEFAULT_MAX_SESSIONS = 1000;
  private static readonly DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

  /**
   * Per-request HTTP headers set by CopilotKit Runtime via `configureAgentForRequest()`.
   *
   * These headers are NOT functionally forwarded to LLM calls because the Claude
   * Agent SDK has no per-request HTTP header mechanism (it is process-based, not HTTP).
   * This property exists for forward compatibility — if Anthropic adds per-request
   * header support to the SDK Options type, wire it here.
   */
  public headers?: Record<string, string>;

  private config: ClaudeAgentAdapterConfig;
  private bindings = new Map<string, SessionBinding>();
  private admitted = new Set<string>();
  private activeQueries = new Map<string, Pick<Query, "close" | "interrupt">>();
  private sessions = new Map<
    string,
    { sessionId: string; lastUsed: number; active: boolean }
  >();

  constructor(config: ClaudeAgentAdapterConfig = {}) {
    super(config);
    this.config = config;
  }

  private evictSessions(): void {
    const ttlMs =
      this.config.sessionTtlMs ?? ClaudeAgentAdapter.DEFAULT_SESSION_TTL_MS;
    const maxSessions =
      this.config.maxSessions ?? ClaudeAgentAdapter.DEFAULT_MAX_SESSIONS;
    const now = Date.now();

    // Remove idle entries older than TTL
    for (const [key, entry] of this.sessions.entries()) {
      if (!entry.active && now - entry.lastUsed > ttlMs) {
        this.sessions.delete(key);
        this.bindings.delete(key);
      }
    }

    // If still over the limit, remove oldest idle entries
    if (this.sessions.size > maxSessions) {
      const idle = [...this.sessions.entries()]
        .filter(([, e]) => !e.active)
        .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);

      for (const [key] of idle) {
        if (this.sessions.size <= maxSessions) break;
        this.sessions.delete(key);
        this.bindings.delete(key);
      }
    }
  }

  public clearSession(threadId: string): void {
    this.sessions.delete(threadId);
    this.bindings.delete(threadId);
  }

  public clone(): ClaudeAgentAdapter {
    const cloned = super.clone() as ClaudeAgentAdapter;
    cloned.config = { ...this.config };
    if (this.headers) {
      cloned.headers = { ...this.headers };
    }
    return cloned;
  }

  public async interrupt(): Promise<void> {
    for (const q of this.activeQueries.values()) {
      await q.interrupt();
    }
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<ProcessedEvent>((subscriber) => {
      if (this.headers && Object.keys(this.headers).length > 0) {
        console.debug(
          "[ClaudeAdapter] headers set but not forwarded (Claude Agent SDK does not support per-request HTTP headers)",
        );
      }

      const threadId = input.threadId;
      if (this.admitted.has(threadId)) {
        subscriber.next({
          type: EventType.RUN_ERROR,
          message: "A run is already active for this thread.",
        });
        subscriber.complete();
        return;
      }
      this.admitted.add(threadId);
      const runInput = input;

      this.translateStream(runInput, subscriber).catch((error) => {
        subscriber.error(error);
      });
      return () => this.activeQueries.get(threadId)?.close?.();
    });
  }

  private async translateStream(
    input: RunAgentInput,
    subscriber: Subscriber<ProcessedEvent>,
  ): Promise<void> {
    const queryKey = input.threadId ?? "default";
    const threadId = input.threadId ?? randomUUID();
    const runId = input.runId ?? randomUUID();
    let loopback: Awaited<ReturnType<typeof startLoopbackMcp>> | undefined;
    let releaseResumeInput: (() => void) | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const runCtx = {
      currentState: hasState(input.state) ? input.state : null,
      lastResultData: undefined as Record<string, unknown> | undefined,
    };

    try {
      if (input.parentRunId) {
        console.debug(
          `[ClaudeAdapter] Run ${runId.slice(0, 8)}... branched from ${input.parentRunId.slice(0, 8)}...`,
        );
      }

      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId,
        runId,
        protocolVersion: PROTOCOL_VERSION,
        input,
      });

      this.evictSessions();
      const cachedSession = this.sessions.get(threadId);
      if (cachedSession) cachedSession.active = true;
      const recoveryConfig = this.config.sessionRecovery;
      let binding = recoveryConfig
        ? await recoveryConfig.store.load(threadId)
        : this.bindings.get(threadId);
      binding = binding ? structuredClone(binding) : undefined;
      const requested =
        (input.forwardedProps as Record<string, unknown> | undefined)?.resume ??
        this.config.resume;
      if (requested && typeof requested !== "string")
        throw new Error("resume must be the original session UUID.");
      if (binding && requested && requested !== binding.sessionId)
        throw new Error(
          "Requested session conflicts with the durable thread binding.",
        );
      if (!binding && requested)
        binding = {
          sessionId: requested as string,
          profile: recoveryConfig?.profile ?? "default",
        };
      const profile = binding?.profile ?? recoveryConfig?.profile ?? "default";
      const profileOptions = recoveryConfig
        ? await recoveryConfig.resolveProfile(profile)
        : {};
      const options = this.buildOptions(
        {
          ...input,
          tools:
            binding?.pending && binding.frontendTools
              ? binding.frontendTools
              : input.tools,
        },
        profileOptions,
        (name, args) => {
          if (this.config.nativeChildRecovery)
            throw new Error(
              "Frontend tool must be suspended before execution in native recovery mode",
            );
          return recovery.resolveFrontendResult(name, args);
        },
      );
      if (this.config.nativeChildRecovery) {
        const proxy = options.mcpServers?.[AG_UI_MCP_SERVER_NAME];
        const native = new NativeChildRecovery(
          this.config.nativeChildRecovery,
          {
            [STATE_MANAGEMENT_TOOL_FULL_NAME]: async (call) => {
              const result = await createStateManagementTool().handler(
                call.input,
              );
              return {
                content: result.content
                  .map((b: { text: string }) => b.text)
                  .join("\n"),
                is_error: !!result.isError,
              };
            },
          },
          proxy && typeof proxy === "object" && proxy.type === "sdk"
            ? async (workerOptions) => {
                const endpoint = await startLoopbackMcp(proxy);
                return {
                  options: {
                    ...workerOptions,
                    mcpServers: {
                      ...workerOptions.mcpServers,
                      [AG_UI_MCP_SERVER_NAME]: endpoint.config,
                    },
                  },
                  close: () => endpoint.close(),
                };
              }
            : undefined,
        );
        options.resume = binding?.sessionId ?? options.resume;
        options.sessionId = options.resume
          ? undefined
          : (options.sessionId ?? randomUUID());
        if (this.config.queryTimeoutMs)
          timeoutHandle = setTimeout(
            () =>
              native.abort("SDK query timed out; parent remains unresolved"),
            this.config.queryTimeoutMs,
          );
        if (hasState(input.state))
          subscriber.next({
            type: EventType.STATE_SNAPSHOT,
            snapshot: input.state,
          });
        const sdkStream = native.run(
          input,
          options,
          processMessages(input).userMessage,
        );
        this.activeQueries.set(queryKey, {
          close: () => native.abort("SDK run cancelled"),
          interrupt: async () => {
            native.abort("SDK run interrupted");
            return undefined;
          },
        });
        await this.streamMessages(
          sdkStream,
          threadId,
          runId,
          input,
          new Set(extractToolNames(input.tools)),
          subscriber,
          runCtx,
        );
        if (native.sessionId) {
          const saved = { sessionId: native.sessionId, profile };
          this.bindings.set(threadId, saved);
          if (recoveryConfig) await recoveryConfig.store.save(threadId, saved);
        }
        subscriber.next({
          type: EventType.RUN_FINISHED,
          threadId,
          runId,
          ...(native.outcome ? { outcome: native.outcome } : {}),
        });
        subscriber.complete();
        return;
      }
      let nativeHistory:
        | Awaited<ReturnType<typeof getSessionMessages>>
        | undefined;
      if (binding?.pending && !binding.unsupportedPendingTools?.length) {
        nativeHistory = await getSessionMessages(binding.sessionId, {
          dir: options.cwd,
          sessionStore: options.sessionStore,
        });
        const unresolved = unresolvedToolUses(nativeHistory);
        if (
          unresolved.length > 1 &&
          unresolved.some((call) => call.id === binding.pending!.id)
        ) {
          binding.unsupportedPendingTools = unresolved;
          if (recoveryConfig)
            await recoveryConfig.store.save(threadId, structuredClone(binding));
          this.bindings.set(threadId, structuredClone(binding));
        }
      }
      const recovery = await RecoveryRun.restore(
        binding,
        input,
        recoveryConfig?.deferTools ?? [],
        async () => {
          return historicalToolResults(
            nativeHistory ??
              (await getSessionMessages(binding!.sessionId, {
                dir: options.cwd,
                sessionStore: options.sessionStore,
              })),
          );
        },
      );
      const proxy = options.mcpServers?.[AG_UI_MCP_SERVER_NAME];
      if (proxy && typeof proxy === "object" && proxy.type === "sdk") {
        loopback = await startLoopbackMcp(proxy);
        options.mcpServers = {
          ...options.mcpServers,
          [AG_UI_MCP_SERVER_NAME]: loopback.config,
        };
      }
      if (binding) {
        if (options.forkSession || options.resumeSessionAt || options.continue)
          throw new Error(
            "Original-session recovery cannot fork, rewind or continue the newest session.",
          );
        options.resume = binding.sessionId;
        options.forkSession = false;
        // Saved tools can replay before SDK callback registration without this
        // CLI startup barrier (bundled CLI >= 2.1.261).
        options.extraArgs = { ...options.extraArgs, "await-initialize": null };
        const info = await getSessionInfo(binding.sessionId, {
          dir: options.cwd,
          sessionStore: options.sessionStore,
        });
        if (!info)
          throw new Error(
            "Original SDK session is unavailable. Restore its transcript/store and original working directory.",
          );
      }
      if (
        binding?.pending &&
        Object.entries(options.mcpServers ?? {}).some(
          ([name, server]) =>
            typeof server === "object" &&
            server.type === "sdk" &&
            binding.pending!.name.startsWith(`mcp__${name}__`),
        )
      ) {
        throw new Error(
          "This SDK cannot restore a deferred in-process MCP tool before startup. The saved call is retained but is not actionable; use a supported SDK fix before resuming.",
        );
      }
      if (recovery.awaitingDecision) {
        subscriber.next({
          type: EventType.RUN_FINISHED,
          threadId,
          runId,
          outcome: recovery.outcome,
        });
        subscriber.complete();
        return;
      }
      // Persist before acknowledging deferral, not in stream cleanup: cancellation
      // can skip cleanup or arrive without a terminal SDK result. Serialize saves
      // so concurrent hooks cannot overwrite a larger batch with an older one.
      let checkpointQueue = Promise.resolve();
      const saveRecoveryBinding = async () => {
        const previous = checkpointQueue;
        let release!: () => void;
        checkpointQueue = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          if (!recovery.binding) return;
          const snapshot = structuredClone(recovery.binding);
          if (recoveryConfig)
            await recoveryConfig.store.save(threadId, snapshot);
          this.bindings.set(threadId, snapshot);
        } finally {
          release();
        }
      };
      const durableHook: HookCallback = async (...args) => {
        const output = await recovery.hook(...args);
        if (recovery.checkpointDeferred(args[0].session_id, profile))
          await saveRecoveryBinding();
        return output;
      };
      options.hooks = {
        ...options.hooks,
        PreToolUse: [
          ...(options.hooks?.PreToolUse ?? []),
          { hooks: [durableHook] },
        ],
      };
      // Keep the SDK control channel alive for hook answers without enqueueing
      // an empty user turn after the CLI automatically replays the deferral.
      let resumeGate = new Promise<void>((resolve) => {
        releaseResumeInput = resolve;
      });
      const newMessages = recovery.resuming
        ? recoveryUserMessages(input, binding!.pending!.id)
        : [];
      const prompt = recovery.resuming
        ? (async function* (): AsyncIterable<SDKUserMessage> {
            await resumeGate;
            for (const message of newMessages) {
              await resumeGate;
              if (subscriber.closed) return;
              // Arm before yielding: the SDK can consume the prompt immediately.
              // Only a validated successful result unlocks the following turn.
              resumeGate = new Promise<void>((resolve) => {
                releaseResumeInput = resolve;
              });
              const converted = processMessages({
                ...input,
                messages: [message],
              }).userMessage;
              if (typeof converted === "string") {
                yield {
                  type: "user",
                  session_id: binding!.sessionId,
                  parent_tool_use_id: null,
                  message: { role: "user", content: converted },
                };
              } else {
                yield* converted;
              }
            }
          })()
        : processMessages(input).userMessage;
      for (const notice of unsupportedInputParts(input)) {
        subscriber.next({
          type: EventType.CUSTOM,
          name: "claude:unsupported_input",
          value: notice,
        });
      }

      const abortController = this.config.queryTimeoutMs
        ? new AbortController()
        : undefined;
      if (abortController) {
        timeoutHandle = setTimeout(
          () => abortController.abort(),
          this.config.queryTimeoutMs!,
        );
      }

      if (subscriber.closed) return;
      const messageStream = query({
        prompt,
        options: {
          ...options,
          model: options.model, // SDK picks default if omitted
          ...(abortController ? { abortController } : {}),
        },
      });
      this.activeQueries.set(queryKey, messageStream);

      const frontendToolNames = new Set(
        input.tools?.length ? extractToolNames(input.tools) : [],
      );
      if (frontendToolNames.size > 0) {
        console.debug(
          `[ClaudeAdapter] Frontend tools detected: [${[...frontendToolNames].join(", ")}]`,
        );
      }

      if (hasState(input.state)) {
        subscriber.next({
          type: EventType.STATE_SNAPSHOT,
          snapshot: input.state,
        });
      }

      await this.streamMessages(
        this.observeRecovery(
          messageStream,
          recovery,
          profile,
          () => releaseResumeInput?.(),
          saveRecoveryBinding,
        ),
        threadId,
        runId,
        input,
        frontendToolNames,
        subscriber,
        runCtx,
      );

      await loopback?.close();
      loopback = undefined;
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
        result: runCtx.lastResultData,
        ...(recovery.outcome ? { outcome: recovery.outcome } : {}),
      });

      subscriber.complete();
    } catch (error) {
      console.error(`[ClaudeAdapter] Error:`, error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      subscriber.next({
        type: EventType.RUN_ERROR,
        threadId,
        runId,
        message: errorMessage,
      });
      subscriber.complete();
    } finally {
      releaseResumeInput?.();
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      this.activeQueries.delete(queryKey);
      this.admitted.delete(queryKey);

      // Conversion can fail before streamMessages gets a chance to mark a
      // resumed session idle, so cover every terminal path here as well.
      const idleEntry = this.sessions.get(queryKey);
      if (idleEntry) {
        idleEntry.active = false;
        idleEntry.lastUsed = Date.now();
        this.evictSessions();
      }
      await loopback?.close();
    }
  }

  private async *observeRecovery(
    stream: AsyncIterable<SDKMessage>,
    recovery: RecoveryRun,
    profile: string,
    releaseInput: () => void,
    saveBinding: () => Promise<void>,
  ): AsyncIterable<SDKMessage> {
    for await (const message of stream) {
      if (message.type === "assistant" && message.parent_tool_use_id) {
        for (const block of message.message.content) {
          if (block.type === "tool_use")
            recovery.observeChildTool(
              {
                id: block.id,
                name: block.name,
                input: block.input as Record<string, unknown>,
              },
              message.parent_tool_use_id,
            );
        }
      }
      if (message.type === "user" && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (
            block.type === "tool_result" &&
            recovery.observeToolResult(
              block.tool_use_id,
              message.parent_tool_use_id,
            ) &&
            recovery.binding
          ) {
            await saveBinding();
          }
        }
      }
      if (
        (message.type === "system" && message.subtype === "init") ||
        message.type === "result"
      ) {
        recovery.observe(
          message.session_id,
          profile,
          message.type === "result" ? message : undefined,
        );
        if (recovery.binding) {
          await saveBinding();
        }
        recovery.assertSupported();
        if (message.type === "result" && message.is_error)
          throw new Error(
            "SDK resume/run failed; check the original files, tools, credentials and execution configuration.",
          );
      }
      if (message.type === "result") releaseInput();
      yield message;
    }
  }

  /** Build Claude SDK Options from base config + RunAgentInput. */
  public buildOptions(
    input: RunAgentInput,
    profileOptions: Options = {},
    resolveFrontendResult?: (
      name: string,
      args: Record<string, unknown>,
    ) => FrontendToolResult,
  ): Options {
    // Start with sensible defaults
    const merged: Record<string, unknown> = {
      includePartialMessages: true,
      // Load no filesystem settings unless the caller asks for them. The SDK
      // treats an omitted settingSources as "load everything", which pulls the
      // host's ~/.claude settings and the working directory's CLAUDE.md into
      // every run.
      settingSources: [],
    };

    // Exclude AG-UI specific fields from SDK options
    const {
      agentId: _agentId,
      description: _desc,
      threadId: _threadId,
      initialMessages: _msgs,
      initialState: _state,
      debug: _debug,
      sessionRecovery: _recovery,
      nativeChildRecovery: _nativeChildRecovery,
      maxSessions: _maxSessions,
      sessionTtlMs: _sessionTtlMs,
      queryTimeoutMs: _queryTimeoutMs,
      ...sdkOptions
    } = this.config;

    for (const [key, value] of Object.entries(sdkOptions)) {
      if (value != null) {
        merged[key] = value;
      }
    }

    Object.assign(merged, profileOptions);

    // Append state and context to the system prompt
    const addendum = buildStateContextAddendum(input);
    if (addendum) {
      const base = (merged.systemPrompt as string) ?? "";
      merged.systemPrompt = base ? `${base}\n\n${addendum}` : addendum;
      console.debug(
        `[ClaudeAdapter] Appended state/context (${addendum.length} chars) to systemPrompt`,
      );
    }

    // Ensure ag_ui tools are always allowed (frontend tools + state management)
    if (hasState(input.state) || input.tools?.length) {
      const allowedTools = (merged.allowedTools as string[]) ?? [];
      const toolsToAdd: string[] = [];

      // Add state management tool if state is provided
      if (
        hasState(input.state) &&
        !allowedTools.includes(STATE_MANAGEMENT_TOOL_FULL_NAME)
      ) {
        toolsToAdd.push(STATE_MANAGEMENT_TOOL_FULL_NAME);
      }

      // Add frontend tools (prefixed with mcp__ag_ui__)
      if (input.tools?.length) {
        for (const toolName of extractToolNames(input.tools)) {
          const prefixedName = `mcp__ag_ui__${toolName}`;
          if (!allowedTools.includes(prefixedName)) {
            toolsToAdd.push(prefixedName);
          }
        }
      }

      if (toolsToAdd.length > 0) {
        merged.allowedTools = [...allowedTools, ...toolsToAdd];
        console.debug(
          `[ClaudeAdapter] Auto-granted permission to ag_ui tools: [${toolsToAdd.join(", ")}]`,
        );
      }
    }

    // Apply forwardedProps as per-run overrides
    if (hasState(input.forwardedProps)) {
      applyForwardedProps(
        input.forwardedProps as Record<string, unknown>,
        merged,
        ALLOWED_FORWARDED_PROPS,
      );
    }

    // Add dynamic tools from input.tools and state management
    const existingServers = (merged.mcpServers ?? {}) as Record<
      string,
      unknown
    >;
    const agUiTools: ReturnType<typeof convertAguiToolToClaudeSdk>[] = [];

    // Add frontend tools from input.tools
    if (input.tools?.length) {
      console.debug(
        `[ClaudeAdapter] Building dynamic MCP server with ${input.tools.length} frontend tools`,
      );
      for (const toolDef of input.tools) {
        try {
          agUiTools.push(
            convertAguiToolToClaudeSdk(toolDef, resolveFrontendResult),
          );
        } catch (e) {
          console.warn(`[ClaudeAdapter] Failed to convert tool:`, e);
        }
      }
    }

    // Add state management tool if meaningful state is provided
    if (hasState(input.state)) {
      console.debug(
        "[ClaudeAdapter] Adding ag_ui_update_state tool for state management",
      );
      agUiTools.push(createStateManagementTool());
    }

    // Create ag_ui MCP server if we have any tools
    if (agUiTools.length > 0) {
      const agUiServer = createSdkMcpServer({
        name: AG_UI_MCP_SERVER_NAME,
        version: "1.0.0",
        tools: agUiTools,
      });

      merged.mcpServers = {
        ...existingServers,
        [AG_UI_MCP_SERVER_NAME]: agUiServer,
      };

      console.debug(
        `[ClaudeAdapter] Created ag_ui MCP server with ${agUiTools.length} tools`,
      );
    }

    return merged as Options;
  }

  /** Consume a Claude SDK message stream and emit AG-UI events. */
  private async streamMessages(
    messageStream: AsyncIterable<unknown>,
    threadId: string,
    runId: string,
    input: RunAgentInput,
    frontendToolNames: Set<string>,
    subscriber: Subscriber<ProcessedEvent>,
    runCtx: {
      currentState: unknown;
      lastResultData: Record<string, unknown> | undefined;
    },
  ): Promise<void> {
    // Per-run state (local to this invocation)
    let currentMessageId: string | null = null;
    let lastStreamedMessageId: string | null = null;
    let inReasoningBlock = false;
    let reasoningMessageId: string | null = null;
    let hasStreamedText = false;
    let accumulatedSignature = "";

    // Tool call streaming state
    let currentToolCallId: string | null = null;
    let currentToolCallName: string | null = null;
    let currentToolDisplayName: string | null = null;
    let accumulatedToolJson = "";

    const processedToolIds = new Set<string>();

    // ── MESSAGES_SNAPSHOT accumulation ──
    const runMessages: Message[] = [];
    // SDK assistant records contain individual blocks, sharing a native message ID.
    const assistantRecords = new Map<
      string,
      Map<string, SDKAssistantMessage["message"]["content"]>
    >();

    const upsertMessage = (msg: Message) => {
      const idx = runMessages.findIndex((m) => m.id === msg.id);
      if (idx !== -1) {
        runMessages[idx] = msg;
      } else {
        runMessages.push(msg);
      }
    };

    type ToolCallEntry = {
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    };
    let pendingMsg: {
      id: string;
      content: string;
      toolCalls: ToolCallEntry[];
    } | null = null;

    const flushPendingMsg = () => {
      if (!pendingMsg) return;
      if (pendingMsg.content || pendingMsg.toolCalls.length > 0) {
        const previous = runMessages.find(
          (message) => message.id === pendingMsg!.id,
        );
        const prior = previous?.role === "assistant" ? previous : undefined;
        const text =
          typeof prior?.content === "string" &&
          prior.content.length > pendingMsg.content.length
            ? prior.content
            : pendingMsg.content;
        const toolCalls = [
          ...new Map(
            [...(prior?.toolCalls ?? []), ...pendingMsg.toolCalls].map(
              (call) => [call.id, call],
            ),
          ).values(),
        ];
        upsertMessage({
          id: pendingMsg.id,
          role: "assistant" as const,
          ...(text ? { content: text } : {}),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        });
      }
      pendingMsg = null;
    };

    let messageCount = 0;

    try {
      for await (const rawMessage of messageStream) {
        messageCount++;

        const message = rawMessage as Record<string, unknown> & {
          type: string;
        };

        // Handle streaming events
        if (message.type === "stream_event") {
          const streamMsg = message as SDKPartialAssistantMessage;
          const event = streamMsg.event as unknown as Record<string, unknown>;
          const eventType = event.type as string;

          if (eventType === "message_start") {
            // Defer TEXT_MESSAGE_START until we get actual text (avoids empty messages from thinking-only blocks)
            currentMessageId =
              (event.message as { id?: string } | undefined)?.id ??
              randomUUID();
            lastStreamedMessageId = currentMessageId;
            hasStreamedText = false;
            pendingMsg = { id: currentMessageId, content: "", toolCalls: [] };
          } else if (eventType === "content_block_delta") {
            const delta = (event.delta as Record<string, unknown>) ?? {};
            const deltaType = delta.type as string;

            if (deltaType === "text_delta") {
              const text = delta.text as string | undefined;
              if (text && currentMessageId) {
                if (!hasStreamedText) {
                  subscriber.next({
                    type: EventType.TEXT_MESSAGE_START,
                    threadId,
                    runId,
                    messageId: currentMessageId,
                    role: "assistant",
                  });
                }
                hasStreamedText = true;
                if (pendingMsg) pendingMsg.content += text;

                subscriber.next({
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  threadId,
                  runId,
                  messageId: currentMessageId,
                  delta: text,
                });
              }
            } else if (deltaType === "thinking_delta") {
              const thinking = delta.thinking as string | undefined;
              if (thinking && reasoningMessageId) {
                subscriber.next({
                  type: EventType.REASONING_MESSAGE_CONTENT,
                  messageId: reasoningMessageId,
                  delta: thinking,
                });
              }
            } else if (deltaType === "signature_delta") {
              const sig = delta.signature as string | undefined;
              if (sig) {
                accumulatedSignature += sig;
              }
            } else if (deltaType === "input_json_delta") {
              const partialJson = delta.partial_json as string | undefined;
              if (partialJson && currentToolCallId) {
                accumulatedToolJson += partialJson;
                subscriber.next({
                  type: EventType.TOOL_CALL_ARGS,
                  threadId,
                  runId,
                  toolCallId: currentToolCallId,
                  delta: partialJson,
                });
              }
            }
          } else if (eventType === "content_block_start") {
            const block =
              (event.content_block as Record<string, unknown>) ?? {};

            if (block.type === "thinking") {
              inReasoningBlock = true;
              reasoningMessageId = randomUUID();
              subscriber.next({
                type: EventType.REASONING_START,
                messageId: reasoningMessageId,
              });
              subscriber.next({
                type: EventType.REASONING_MESSAGE_START,
                messageId: reasoningMessageId,
                role: "reasoning",
              });
            } else if (block.type === "tool_use") {
              currentToolCallId = (block.id as string) ?? null;
              currentToolCallName = (block.name as string) ?? "unknown";
              accumulatedToolJson = "";

              if (currentToolCallId) {
                currentToolDisplayName = stripMcpPrefix(currentToolCallName);
                processedToolIds.add(currentToolCallId);

                subscriber.next({
                  type: EventType.TOOL_CALL_START,
                  threadId,
                  runId,
                  toolCallId: currentToolCallId,
                  toolCallName: currentToolDisplayName, // Use unprefixed name for frontend matching!
                  parentMessageId: currentMessageId ?? undefined, // Link to parent message
                });
              }
            }
          } else if (eventType === "content_block_stop") {
            if (inReasoningBlock && reasoningMessageId) {
              inReasoningBlock = false;
              subscriber.next({
                type: EventType.REASONING_MESSAGE_END,
                messageId: reasoningMessageId,
              });
              subscriber.next({
                type: EventType.REASONING_END,
                messageId: reasoningMessageId,
              });

              // Emit encrypted signature if present
              if (accumulatedSignature && currentMessageId) {
                subscriber.next({
                  type: EventType.REASONING_ENCRYPTED_VALUE,
                  subtype: "message",
                  entityId: currentMessageId,
                  encryptedValue: accumulatedSignature,
                });
              }

              accumulatedSignature = "";
              reasoningMessageId = null;
            }

            // Close tool call if we were streaming one
            if (currentToolCallId) {
              // Check if this is the state management tool
              if (isStateManagementTool(currentToolCallName ?? "")) {
                // Parse accumulated JSON and emit STATE_SNAPSHOT
                try {
                  const stateArgs = JSON.parse(accumulatedToolJson);
                  if (typeof stateArgs === "object" && stateArgs !== null) {
                    const prevStateJson = JSON.stringify(runCtx.currentState);
                    runCtx.currentState = mergeStateUpdate(
                      runCtx.currentState,
                      stateArgs,
                    );

                    const newStateJson = JSON.stringify(runCtx.currentState);

                    if (newStateJson !== prevStateJson) {
                      subscriber.next({
                        type: EventType.STATE_SNAPSHOT,
                        snapshot: runCtx.currentState,
                      });
                    }
                  }
                } catch {
                  console.warn(
                    "[ClaudeAdapter] Failed to parse tool JSON for state update",
                  );
                  subscriber.next({
                    type: EventType.CUSTOM,
                    name: "state_update_error",
                    value: { error: "Failed to parse state update" },
                  });
                }
              }

              // Push tool call onto in-flight message (skip state management)
              if (
                pendingMsg &&
                currentToolCallId &&
                currentToolDisplayName &&
                !isStateManagementTool(currentToolCallName ?? "")
              ) {
                pendingMsg.toolCalls.push({
                  id: currentToolCallId,
                  type: "function" as const,
                  function: {
                    name: currentToolDisplayName,
                    arguments: accumulatedToolJson,
                  },
                });
              }

              // For regular backend tools, emit TOOL_CALL_END at content_block_stop.
              // The SDK executes backend tools internally and returns results in
              // a subsequent message (ToolResultBlock in Python, SDKUserMessage in TS).
              subscriber.next({
                type: EventType.TOOL_CALL_END,
                threadId,
                runId,
                toolCallId: currentToolCallId,
              });

              currentToolCallId = null;
              currentToolCallName = null;
              currentToolDisplayName = null;
              accumulatedToolJson = "";
            }
          } else if (eventType === "message_stop") {
            flushPendingMsg();

            if (currentMessageId && hasStreamedText) {
              subscriber.next({
                type: EventType.TEXT_MESSAGE_END,
                threadId,
                runId,
                messageId: currentMessageId,
              });
            }
            currentMessageId = null;
          } else if (eventType === "message_delta") {
            const delta = (event.delta as Record<string, unknown>) ?? {};
            const stopReason = delta.stop_reason as string | undefined;
            if (stopReason) {
              console.debug(
                `[ClaudeAdapter] Message stop_reason: ${stopReason}`,
              );
            }
          }
        }
        // Handle complete assistant messages
        else if (message.type === "assistant") {
          const assistantMsg = message as SDKAssistantMessage;
          const content = assistantMsg.message?.content ?? [];

          const msgId =
            assistantMsg.message?.id ??
            currentMessageId ??
            lastStreamedMessageId ??
            assistantMsg.uuid ??
            randomUUID();
          lastStreamedMessageId = null;
          subscriber.next({
            type: EventType.CUSTOM,
            name: "claude:assistant_content",
            value: {
              messageId: msgId,
              uuid: assistantMsg.uuid,
              parentToolUseId: assistantMsg.parent_tool_use_id,
              content,
            },
          });
          {
            const records = assistantRecords.get(msgId) ?? new Map();
            records.set(
              assistantMsg.uuid ?? `${msgId}:${records.size}`,
              content,
            );
            assistantRecords.set(msgId, records);
            const aguiMsg = buildAguiAssistantMessage(
              {
                ...assistantMsg,
                message: {
                  ...assistantMsg.message,
                  content: [...records.values()].flat(),
                },
              },
              msgId,
            );
            if (aguiMsg) {
              upsertMessage(aguiMsg);
            }
          }

          // Process any tool_use blocks not already seen via streaming
          for (const block of content) {
            if (block.type !== "tool_use") continue;
            const toolBlock = block as BetaToolUseBlock;
            if (toolBlock.id && processedToolIds.has(toolBlock.id)) continue;

            const { updatedState } = handleToolUseBlock(
              toolBlock,
              msgId,
              threadId,
              runId,
              runCtx.currentState,
              subscriber,
            );
            if (toolBlock.id) processedToolIds.add(toolBlock.id);
            if (updatedState !== null) runCtx.currentState = updatedState;
          }
        }
        // Handle user messages (tool results)
        else if (message.type === "user") {
          const userMsg = message as SDKUserMessage;

          const msgContent = (userMsg.message ?? userMsg) as {
            content?: unknown[];
          };
          const contentBlocks = msgContent.content;

          if (Array.isArray(contentBlocks)) {
            for (const blk of contentBlocks) {
              const block = blk as Record<string, unknown>;
              if (block.type === "tool_result" && block.tool_use_id) {
                const toolUseId = block.tool_use_id as string;
                const resultContent = block.content;

                const toolMsg = buildAguiToolMessage(
                  toolUseId,
                  resultContent,
                  block.is_error === true,
                );
                upsertMessage(toolMsg);

                subscriber.next({
                  type: EventType.TOOL_CALL_RESULT,
                  threadId,
                  runId,
                  // The native echo updates the submitted result, rather than
                  // introducing a second outward message for the same call.
                  messageId:
                    input.messages.find(
                      (message) =>
                        message.role === "tool" &&
                        message.toolCallId === toolUseId,
                    )?.id ?? toolMsg.id,
                  toolCallId: toolUseId,
                  content: toolMsg.content!,
                  rawEvent: {
                    ...block,
                    uuid: userMsg.uuid,
                    parent_tool_use_id: userMsg.parent_tool_use_id,
                    tool_use_result: message.tool_use_result,
                  },
                  role: "tool",
                });
              }
            }
          }
        }
        // Handle system messages
        else if (message.type === "system") {
          const raw = message as unknown as Record<string, unknown>;
          const subtype = raw.subtype as string | undefined;
          const data = raw.data as Record<string, unknown> | undefined;

          // Capture session_id for multi-turn resume
          if (subtype === "init") {
            const sid = (raw.session_id ?? data?.session_id) as
              | string
              | undefined;
            if (sid) {
              this.sessions.set(threadId, {
                sessionId: sid,
                lastUsed: Date.now(),
                active: true,
              });
              this.evictSessions();
              console.debug(
                `[ClaudeAdapter] Captured session_id=${sid} for thread=${threadId}`,
              );
            }
          }

          // Emit system messages as CUSTOM events with the raw SDK data
          subscriber.next({
            type: EventType.CUSTOM,
            name: `system:${subtype ?? "unknown"}`,
            value: data ?? raw,
          });
        }
        // Handle result messages
        else if (message.type === "result") {
          const resultMsg = message as SDKResultMessage;

          runCtx.lastResultData = {
            isError: (resultMsg as { is_error?: boolean }).is_error ?? false,
            durationMs: (resultMsg as { duration_ms?: number }).duration_ms,
            durationApiMs: (resultMsg as { duration_api_ms?: number })
              .duration_api_ms,
            numTurns: (resultMsg as { num_turns?: number }).num_turns,
            totalCostUsd: (resultMsg as { total_cost_usd?: number })
              .total_cost_usd,
            usage:
              (resultMsg as { usage?: Record<string, unknown> }).usage ?? {},
            structuredOutput: (resultMsg as { structured_output?: unknown })
              .structured_output,
          };

          const resultText = (resultMsg as { result?: string }).result;
          if (!hasStreamedText && resultText) {
            // With partial streaming disabled, ResultMessage repeats the last
            // complete assistant message. Preserve its canonical identity.
            const lastAssistant = runMessages
              .filter((m) => m.role === "assistant")
              .at(-1);
            const matchingAssistant =
              lastAssistant?.content === resultText ? lastAssistant : undefined;
            const resultMsgId = matchingAssistant?.id ?? randomUUID();
            subscriber.next({
              type: EventType.TEXT_MESSAGE_START,
              threadId,
              runId,
              messageId: resultMsgId,
              role: "assistant",
            });
            subscriber.next({
              type: EventType.TEXT_MESSAGE_CONTENT,
              threadId,
              runId,
              messageId: resultMsgId,
              delta: resultText,
            });
            subscriber.next({
              type: EventType.TEXT_MESSAGE_END,
              threadId,
              runId,
              messageId: resultMsgId,
            });

            upsertMessage(
              matchingAssistant ?? {
                id: resultMsgId,
                role: "assistant" as const,
                content: resultText,
              },
            );
          }
        }
      }
    } finally {
      // ── Event cleanup ──
      // Close any hanging events so the frontend doesn't get stuck
      // waiting for END events that will never arrive.
      if (currentToolCallId) {
        console.debug(
          `[ClaudeAdapter] Cleanup: closing hanging TOOL_CALL_START for ${currentToolCallId}`,
        );
        subscriber.next({
          type: EventType.TOOL_CALL_END,
          threadId,
          runId,
          toolCallId: currentToolCallId,
        });
        currentToolCallId = null;
      }

      if (inReasoningBlock && reasoningMessageId) {
        console.debug(
          "[ClaudeAdapter] Cleanup: closing hanging reasoning block",
        );
        subscriber.next({
          type: EventType.REASONING_MESSAGE_END,
          messageId: reasoningMessageId,
        });
        subscriber.next({
          type: EventType.REASONING_END,
          messageId: reasoningMessageId,
        });
        inReasoningBlock = false;
        reasoningMessageId = null;
      }

      if (hasStreamedText && currentMessageId) {
        console.debug(
          `[ClaudeAdapter] Cleanup: closing hanging TEXT_MESSAGE_START for ${currentMessageId}`,
        );
        subscriber.next({
          type: EventType.TEXT_MESSAGE_END,
          threadId,
          runId,
          messageId: currentMessageId,
        });
      }

      flushPendingMsg();

      // Mark session as idle after run completes and run TTL/LRU eviction
      const idleEntry = this.sessions.get(threadId);
      if (idleEntry) {
        idleEntry.active = false;
        idleEntry.lastUsed = Date.now();
        this.evictSessions();
      }
    }

    // Emit MESSAGES_SNAPSHOT with input messages + new messages from this run
    if (runMessages.length > 0) {
      // SDK echoes are authoritative for saved content/error projection. Match
      // frontend answers by call ID, retaining their UI message identity.
      const allMessages: Message[] = [];
      for (const message of [...(input.messages ?? []), ...runMessages]) {
        const index = allMessages.findIndex(
          (existing) =>
            existing.id === message.id ||
            (existing.role === "tool" &&
              message.role === "tool" &&
              existing.toolCallId === message.toolCallId),
        );
        if (index === -1) allMessages.push(message);
        else allMessages[index] = { ...message, id: allMessages[index].id };
      }
      console.debug(
        `[ClaudeAdapter] MESSAGES_SNAPSHOT: ${allMessages.length} msgs (${messageCount} SDK messages processed)`,
      );
      subscriber.next({
        type: EventType.MESSAGES_SNAPSHOT,
        messages: allMessages,
      });
    }
  }
}
