/**
 * AG-UI integration for the OpenAI Agents JS SDK.
 *
 * The adapter translates `Runner.run(agent, { stream: true })` stream events
 * into AG-UI protocol events. Call `adapter.run(input)` and subscribe to the
 * resulting AG-UI event stream.
 *
 * @example
 * ```typescript
 * import { OpenAIAgentsAdapter } from "@ag-ui/openai-agents-js";
 *
 * const adapter = new OpenAIAgentsAdapter({ model: "gpt-5" });
 * const events$ = adapter.run(input);
 * ```
 */

import { AbstractAgent } from "@ag-ui/client";
import { Observable, type Subscriber } from "rxjs";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";

import { DEFAULT_MODEL, ENV, STATE_MANAGEMENT_TOOL_NAME } from "./config";
import type { OpenAIAgentsAdapterConfig, ProcessedEvent } from "./types";
import { hasState, InMemoryRunStateStore } from "./state";
import type { RunStateStore } from "./state";
import { messagesToSdkInput, outputToString } from "./utils";
import {
  StreamContext,
  buildMessagesSnapshot,
  closeOpenBlocks,
  handleAgentUpdatedStreamEvent,
  handleRawModelStreamEvent,
  handleRunItemStreamEvent,
} from "./handlers";
import { buildTools } from "./tools";

/**
 * Lazily imported SDK surface. We import dynamically so the package can be
 * consumed even when `@openai/agents` is only a peer dependency, and so unit
 * tests can mock the module at the boundary.
 */
interface OpenAIAgentsModule {
  Agent: new <T = unknown>(config: Record<string, unknown>) => unknown;
  tool?: (options: Record<string, unknown>) => unknown;
  run: (
    agent: unknown,
    input: unknown,
    options: { stream: true; signal: AbortSignal },
  ) => Promise<AsyncIterable<unknown>>;
  setDefaultOpenAIClient?: (client: unknown) => void;
  setDefaultOpenAIKey?: (key: string) => void;
  setOpenAIAPI?: (value: "chat_completions" | "responses") => void;
  setTracingDisabled?: (disabled: boolean) => void;
}

/**
 * Error thrown when the adapter cannot construct a valid OpenAI client.
 */
export class OpenAIAgentsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAIAgentsConfigError";
  }
}

export class OpenAIAgentsAdapter extends AbstractAgent {
  protected config: OpenAIAgentsAdapterConfig;

  /** Whether the global SDK provider has been configured by this adapter. */
  private providerConfigured = false;

  /**
   * Pause/resume persistence for the shared `currentState` across HITL halts.
   * Defaults to an in-memory store; users can inject a durable backend
   * (DynamoDB / S3 / Redis / etc.) via `config.runStateStore`.
   */
  private runStateStore: RunStateStore;

  constructor(config: OpenAIAgentsAdapterConfig = {}) {
    super(config);
    this.config = config;
    this.runStateStore =
      config.runStateStore ??
      new InMemoryRunStateStore({
        maxStates: config.maxStates,
        ttlMs: config.stateTtlMs,
      });
  }

  public clone(): OpenAIAgentsAdapter {
    const cloned = super.clone() as OpenAIAgentsAdapter;
    cloned.config = { ...this.config };
    cloned.runStateStore = this.runStateStore;
    cloned.providerConfigured = false;
    return cloned;
  }

  /**
   * Resolve the effective model name: explicit config > env > default.
   */
  protected resolveModel(): string {
    return (
      this.config.model ??
      (typeof process !== "undefined" ? process.env?.[ENV.MODEL] : undefined) ??
      DEFAULT_MODEL
    );
  }

  /**
   * Resolve the effective API key: explicit config > env.
   * Throws `OpenAIAgentsConfigError` when no key is available and no
   * preconfigured `openAIClient` was supplied.
   */
  protected resolveApiKey(): string | undefined {
    const key =
      this.config.apiKey ??
      (typeof process !== "undefined" ? process.env?.[ENV.API_KEY] : undefined);
    if (!key && !this.config.openAIClient) {
      throw new OpenAIAgentsConfigError(
        `OpenAI API key is required. Set the ${ENV.API_KEY} environment variable or pass \`apiKey\` to the adapter config.`,
      );
    }
    return key;
  }

  /**
   * Resolve the effective base URL: explicit config > env.
   */
  protected resolveBaseUrl(): string | undefined {
    return (
      this.config.baseURL ??
      (typeof process !== "undefined" ? process.env?.[ENV.BASE_URL] : undefined)
    );
  }

  /**
   * Validate the config: `baseURL` and `openAIClient` are mutually exclusive
   * (SDK constraint). Public so callers can fail-fast before a run.
   */
  public validateConfig(): void {
    if (this.config.openAIClient && (this.config.baseURL || this.config.apiKey)) {
      throw new OpenAIAgentsConfigError(
        "`openAIClient` cannot be combined with `apiKey` or `baseURL`.",
      );
    }
  }

  /**
   * Configure the global SDK provider for an OpenAI-compatible endpoint
   * (e.g. LiteLLM). Idempotent — only runs once per adapter instance.
   *
   * NOTE: `setDefaultOpenAIClient` / `setOpenAIAPI` / `setTracingDisabled` are
   * process-global SDK settings. This adapter sets them when a custom
   * `baseURL`/`openAIClient` is configured. If a host process uses multiple
   * SDK configurations simultaneously, prefer constructing a single shared
   * `openAIClient` and passing it via `openAIClient` (the SDK will use it as
   * the default without additional global calls).
   */
  protected async configureProvider(mod: OpenAIAgentsModule): Promise<void> {
    if (this.providerConfigured) return;
    this.validateConfig();

    if (this.config.openAIClient) {
      // Caller supplied a fully-configured client; let the SDK use it.
      mod.setDefaultOpenAIClient?.(this.config.openAIClient);
      mod.setTracingDisabled?.(true);
      this.providerConfigured = true;
      return;
    }

    const baseURL = this.resolveBaseUrl();
    if (baseURL) {
      // OpenAI-compatible endpoint (LiteLLM). Most such proxies do not support
      // the Responses API, so switch to Chat Completions mode and disable
      // tracing (no platform.openai.com key for trace export).
      const key = this.resolveApiKey();
      const OpenAI = (await import("openai")).default;
      const client = new OpenAI({ apiKey: key, baseURL });
      mod.setDefaultOpenAIClient?.(client);
      mod.setOpenAIAPI?.("chat_completions");
      mod.setTracingDisabled?.(true);
      this.providerConfigured = true;
      return;
    }

    // Default cloud path: set the key so the SDK can authenticate.
    // resolveApiKey() throws when no key is available and no openAIClient is
    // set; the openAIClient branch above already returned, so here it is
    // defined.
    const key = this.resolveApiKey() as string;
    mod.setDefaultOpenAIKey?.(key);
    this.providerConfigured = true;
  }

  /**
   * Build the OpenAI Agents JS `Agent` from adapter config + run input.
   *
   * Wires instructions + model, and converts `input.tools` (AG-UI frontend
   * tools) into SDK `FunctionTool`s, injecting the `ag_ui_update_state`
   * state tool when the run carries state. Tools are non-strict (JSON Schema
   * passthrough) with stub `execute`s — the real frontend-execution flow
   * (halt on `tool_called`, resume with the frontend result) lands in Phase 5.
   */
  protected buildAgent(mod: OpenAIAgentsModule, input: RunAgentInput): unknown {
    const baseInstructions =
      this.config.instructions ??
      input.context?.find((c) => typeof c === "object" && c)?.description ??
      "You are a helpful assistant.";
    const instructions = hasState(input.state)
      ? `${baseInstructions}\n\n## Current Shared State\n${JSON.stringify(input.state)}`
      : baseInstructions;

    const tools = mod.tool ? buildTools(input, { tool: mod.tool }) : [];

    // Merge any SDK-native backend tools from config (server-side execution)
    // alongside the AG-UI frontend tools + injected state tool above.
    const allTools = Array.isArray(this.config.tools)
      ? [...tools, ...this.config.tools]
      : tools;

    const agentConfig: Record<string, unknown> = {
      name: this.config.agentId ?? "ag-ui-openai-agent",
      instructions,
      model: this.resolveModel(),
      tools: allTools,
    };

    return new mod.Agent(agentConfig);
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<ProcessedEvent>((subscriber) => {
      const controller = new AbortController();
      void this.runAsync(input, subscriber, controller.signal).catch((error) => {
        if (!subscriber.closed) subscriber.error(error);
      });
      return () => controller.abort();
    });
  }

  private async runAsync(
    input: RunAgentInput,
    subscriber: Subscriber<ProcessedEvent>,
    signal: AbortSignal,
  ): Promise<void> {
    const threadId = input.threadId ?? this.threadId;
    const runId = input.runId ?? this.config.agentId ?? "run";

    this.validateConfig();
    if (!this.config.openAIClient) this.resolveApiKey();

    const mod = (await import("@openai/agents")) as unknown as OpenAIAgentsModule;
    if (signal.aborted) return;
    await this.configureProvider(mod);
    if (signal.aborted) return;
    const sdkInput = messagesToSdkInput(input.messages ?? []);

    // Names of AG-UI frontend tools — a `tool_called` for one of these halts
    // the run so the frontend can execute it. (Phase 5.)
    const frontendToolNames = new Set<string>(
      (input.tools ?? [])
        .map((t) => t?.name)
        .filter((n): n is string => typeof n === "string"),
    );

    // Hydrate shared state: prefer the run's own state; fall back to any state
    // stashed for this thread across a prior HITL pause. (Phase 5.)
    let effectiveState: unknown = input.state;
    if (!hasState(effectiveState)) {
      const stashed = await this.runStateStore.get(threadId);
      if (stashed !== undefined) effectiveState = stashed;
    }
    if (signal.aborted) return;

    const agent = this.buildAgent(mod, { ...input, state: effectiveState });

    const ctx = new StreamContext(runId, effectiveState);
    ctx.frontendToolNames = frontendToolNames;
    ctx.interruptFrontendTools = this.config.interruptOnFrontendToolCall !== false;

    try {
      if (input.parentRunId) {
        console.debug(
          `[OpenAIAgentsAdapter] Run ${runId.slice(0, 8)} branched from ${input.parentRunId.slice(0, 8)}`,
        );
      }

      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId,
        runId,
        ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      });

      // Announce the initial shared state so the frontend can hydrate. Mirrors
      // the claude-agent-sdk behaviour: only emit when state is meaningful.
      if (hasState(effectiveState)) {
        subscriber.next({
          type: EventType.STATE_SNAPSHOT,
          snapshot: effectiveState,
        });
      }

      if (signal.aborted) return;
      const stream = (await mod.run(agent, sdkInput, { stream: true, signal })) as AsyncIterable<any>;
      if (signal.aborted) return;
      let pendingFrontendCalls: Set<string> | undefined;

      for await (const ev of stream) {
        if (subscriber.closed) break;
        // The SDK emits response_done before its run-item events; use its
        // output to retain every frontend call from the same model response.
        if (ev?.type === "raw_model_stream_event" && ev.data?.type === "response_done") {
          const output = ev.data.response?.output;
          if (Array.isArray(output)) {
            pendingFrontendCalls = new Set(
              output
                .filter((item) => item?.type === "function_call" && frontendToolNames.has(item.name))
                .map((item) => item.callId ?? item.call_id)
                .filter((id): id is string => typeof id === "string"),
            );
          }
        }
        if (ctx.halt && !pendingFrontendCalls?.size &&
            !(ev?.type === "run_item_stream_event" && ev.name === "tool_called")) break;
        const emitted = dispatchStreamEvent(ev, ctx);
        for (const e of emitted) subscriber.next(e as ProcessedEvent);
        if (ev?.type === "run_item_stream_event" && ev.name === "tool_called") {
          const raw = ev.item?.rawItem;
          pendingFrontendCalls?.delete(raw?.callId ?? raw?.call_id);
        }
        if (ctx.halt && pendingFrontendCalls && pendingFrontendCalls.size === 0) break;
      }
      if (signal.aborted) return;

      // Close any open message / reasoning blocks at end-of-stream.
      for (const e of closeOpenBlocks(ctx)) subscriber.next(e as ProcessedEvent);

      subscriber.next({
        type: EventType.MESSAGES_SNAPSHOT,
        messages: buildMessagesSnapshot(input.messages ?? [], ctx.messages),
      });

      // Persist the evolved shared state for this thread so a resumed run can
      // hydrate it even if the frontend doesn't resend `state`. (Phase 5.)
      if (signal.aborted) return;
      if (hasState(ctx.currentState)) {
        await this.runStateStore.set(threadId, ctx.currentState);
      }

      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
        ...(ctx.interrupts.length > 0
          ? { outcome: { type: "interrupt", interrupts: ctx.interrupts } }
          : { outcome: { type: "success" } }),
      });
      subscriber.complete();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      if (!subscriber.closed) {
        subscriber.next({
          type: EventType.RUN_ERROR,
          message,
        });
        subscriber.complete();
      }
    }
  }
}

/**
 * Dispatch a single SDK stream event to the appropriate handler.
 *
 * `RunStreamEvent` is a discriminated union on `type`:
 *  - `raw_model_stream_event`   → `handleRawModelStreamEvent`
 *  - `run_item_stream_event`     → `handleRunItemStreamEvent`
 *  - `agent_updated_stream_event`→ `handleAgentUpdatedStreamEvent`
 */
function dispatchStreamEvent(ev: any, ctx: StreamContext): BaseEvent[] {
  if (!ev || typeof ev !== "object") return [];
  switch (ev.type) {
    case "raw_model_stream_event":
      return handleRawModelStreamEvent(ev.data, ctx);
    case "run_item_stream_event":
      return handleRunItemStreamEvent(ev.name, ev.item, ctx);
    case "agent_updated_stream_event":
      return handleAgentUpdatedStreamEvent(ev.agent);
    default:
      return [];
  }
}

// Re-export helpers used by tests so they don't have to reach into internals.
export { StreamContext, messagesToSdkInput, outputToString };
export { STATE_MANAGEMENT_TOOL_NAME };
