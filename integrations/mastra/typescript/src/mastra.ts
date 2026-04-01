import type {
  BaseEvent,
  RunAgentInput,
  RunFinishedEvent,
  RunStartedEvent,
  StateSnapshotEvent,
} from '@ag-ui/client';
import { AbstractAgent, EventType, randomUUID } from '@ag-ui/client';
import type { Agent as LocalMastraAgent } from '@mastra/core/agent';
import type { StorageThreadType } from '@mastra/core/memory';
import { RequestContext } from '@mastra/core/request-context';
import { Observable, tap } from 'rxjs';
import type { AgentLogger } from './logger';
import { createAgentLogger } from './logger';
import type { ChunkHandlerRegistry } from './registry';
import { createDefaultRegistry } from './registry';
import type {
  AGUIAgents,
  AdapterCommonOptions,
  ClientTools,
  CreateRunContextOptions,
  GetLocalAgentOptions,
  GetLocalAgentsOptions,
  GetNetworkOptions,
  GetRemoteAgentsOptions,
  MastraAdapterConfig,
  MastraAdapterOptions,
  RemoteMastraAgent,
  StreamChunk,
  StreamRunContext,
} from './types';
import { convertAGUIMessagesToMastra } from './utils';

const USER_MESSAGE_PREVIEW_LIMIT = 120;

/** AG-UI adapter that bridges CopilotKit runtime events with Mastra streaming agents. */
export class MastraAgentAdapter extends AbstractAgent {
  /** Immutable adapter construction config. */
  readonly #config: MastraAdapterConfig;

  /** Runtime dependencies shared across stream execution. */
  readonly #options: {
    registry: ChunkHandlerRegistry;
    logger: AgentLogger;
    eventLogger?: (input: RunAgentInput, event: BaseEvent) => void;
  };

  /** Per-thread abort controllers used for teardown and explicit aborts. */
  readonly #abortControllers = new Map<string, AbortController>();

  /**
   * Creates a Mastra AG-UI adapter instance.
   * @param config Adapter construction config.
   * @param options Optional behavior overrides.
   */
  constructor(config: MastraAdapterConfig, options: MastraAdapterOptions = {}) {
    super(config);

    this.#config = {
      ...config,
      requestContext: config.requestContext ?? new RequestContext(),
    };

    const rawLogger = options.logger ?? createAgentLogger(options.debug ?? this.debug);
    const logger = typeof rawLogger === 'function' ? rawLogger(config) : rawLogger;
    const defaultRegistry = createDefaultRegistry({
      errorMode: options.registryErrorMode ?? 'fail-fast',
      enableReasoning: options.registryEnableReasoning,
    });
    const registry =
      typeof options.registry === 'function'
        ? options.registry(defaultRegistry)
        : (options.registry ?? defaultRegistry);

    const eventLogger = options.eventLogger?.(config);
    this.#options = { registry, logger, eventLogger };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Creates a new adapter instance preserving config and runtime behavior options. */
  public clone(): MastraAgentAdapter {
    const { eventLogger } = this.#options;
    return new MastraAgentAdapter(this.#config, {
      registry: this.#options.registry.clone(),
      logger: this.#options.logger,
      ...(eventLogger && { eventLogger: () => eventLogger }),
    });
  }

  /** CopilotKit-compatible abort (no parameters). Aborts the latest active run. */
  public override abortRun(): void {
    super.abortRun();
    // Best-effort: abort all active controllers belonging to this agent instance
    for (const ctrl of this.#abortControllers.values()) {
      ctrl.abort();
    }
  }

  /**
   * Runs a CopilotKit agent call and emits AG-UI events as an observable stream.
   * @param input AG-UI run input payload.
   */
  run(input: RunAgentInput): Observable<BaseEvent> {
    const obs = new Observable<BaseEvent>((subscriber) => {
      const { threadId, runId } = input;
      const ctrl = new AbortController();
      this.#abortControllers.set(threadId, ctrl);

      // BUG-10 fix: guard all emits with !subscriber.closed
      const logger = this.#options.logger;
      const ctx = this.#createRunContext({
        subscriber,
        threadId,
        runId,
        logger,
        latestUserMessageText: extractLatestUserMessageText(input.messages),
      });

      const run = async () => {
        logger.info('run.started', { threadId, runId });

        // Emit RUN_STARTED
        ctx.emit({
          type: EventType.RUN_STARTED,
          threadId,
          runId,
        } satisfies RunStartedEvent);

        // Memory: write incoming state to working memory
        await this.#syncIncomingState(input, ctx);

        try {
          if (this.#isLocalAgent(this.#config.agent)) {
            await this.#doLocalStream(input, ctx, ctrl.signal);
          } else {
            await this.#doRemoteStream(input, ctx, ctrl.signal);
          }
        } catch (error) {
          if (!ctx.aborted) {
            logger.error('run.stream.error', { threadId, runId, error });
            ctx.fail(error instanceof Error ? error : new Error(String(error)));
          }
          return;
        }

        if (ctx.aborted || subscriber.closed) {
          logger.info('run.aborted', { threadId, runId });
          return;
        }

        // Memory: read back working memory and emit STATE_SNAPSHOT
        await this.#emitStateSnapshot(input, ctx);

        // Emit RUN_FINISHED
        ctx.emit({
          type: EventType.RUN_FINISHED,
          threadId,
          runId,
        } satisfies RunFinishedEvent);

        logger.info('run.finished', { threadId, runId });

        if (!subscriber.closed) subscriber.complete();
      };

      void run().catch((error: unknown) => {
        if (ctx.aborted) {
          return;
        }

        logger.error('run.unhandled.error', { threadId, runId, error });
        ctx.fail(error instanceof Error ? error : new Error(String(error)));
      });

      // BUG-9 fix: teardown actually aborts the stream
      return () => {
        ctrl.abort();
        this.#abortControllers.delete(threadId);
      };
    });
    const eventLogger = this.#options.eventLogger;
    return eventLogger ? obs.pipe(tap((event) => eventLogger(input, event))) : obs;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Builds the mutable per-run stream context consumed by chunk handlers.
   * @param options Context creation options.
   */
  #createRunContext(options: CreateRunContextOptions): StreamRunContext {
    let messageId = randomUUID();
    let reasoningId = randomUUID();
    let reasoningMessageId = randomUUID();
    let reasoningOpen = false;
    const subscriber = options.subscriber;
    const threadId = options.threadId;
    const runId = options.runId;
    const logger = options.logger;
    const agentId = this.#config.agentId;
    const resourceId = this.#config.resourceId;
    const latestUserMessageText = options.latestUserMessageText;

    const context: StreamRunContext = {
      get messageId() { // Current primary message ID reused by text and tool events.
        return messageId;
      },
      set messageId(id: string) { // Sync the primary message ID from server or upstream state.
        messageId = id;
      },
      get reasoningId() { // Stable ID for the current reasoning block.
        return reasoningId;
      },
      get reasoningMessageId() { // Stable message ID for the current reasoning message.
        return reasoningMessageId;
      },
      get reasoningOpen() { // Whether the reasoning block is currently open.
        return reasoningOpen;
      },
      set reasoningOpen(value: boolean) { // Update reasoning-open state to avoid duplicate open/close events.
        reasoningOpen = value;
      },
      hasEmittedText: false, // Whether the current step has already emitted text.
      latestUserMessageText, // Latest user-authored text preview for reasoning or logging.
      aborted: false, // Whether the current run has been aborted.
      subscriber, // Active RxJS subscriber that receives emitted AG-UI events.
      threadId, // Current CopilotKit thread ID.
      runId, // Current CopilotKit run ID.
      agentId, // Bound adapter/agent identifier.
      resourceId, // Bound resource identifier, usually user or session scoped.
      logger, // Logger instance used for this run.
      emit: (event: BaseEvent) => { // Emit an event to the subscriber and attach a timestamp.
        if (!subscriber.closed)
          subscriber.next({
            ...event,
            timestamp: Date.now(),
          });
      },
      fail: (error: Error) => { // Forward a failure to the subscriber.
        if (!subscriber.closed) subscriber.error(error);
      },
      rotateMessageId: () => { // Generate a new local message ID for the next message.
        messageId = randomUUID();
      },
      syncMessageId: (id: string) => { // Override the local message ID with an upstream/server value.
        messageId = id;
      },
      markAborted: () => { // Mark the run as aborted so later steps can short-circuit.
        context.aborted = true;
      },
    };

    return context;
  }

  /**
   * Type guard that detects whether the bound agent is a local Mastra agent.
   * @param agent Agent instance to check.
   */
  #isLocalAgent(agent: LocalMastraAgent | RemoteMastraAgent): agent is LocalMastraAgent {
    return 'getMemory' in agent;
  }

  /**
   * Writes incoming `input.state` into Mastra working memory for local agents.
   * @param input Current run input.
   * @param ctx Mutable stream run context.
   */
  async #syncIncomingState(input: RunAgentInput, ctx: StreamRunContext): Promise<void> {
    const { agent } = this.#config;
    if (!this.#isLocalAgent(agent)) return;

    const incomingState = omitMessagesState(input.state);
    if (Object.keys(incomingState).length === 0) return;

    try {
      const memory = await agent.getMemory({
        requestContext: this.#config.requestContext,
      });
      if (!memory) return;

      let thread: StorageThreadType | null = await memory.getThreadById({
        threadId: input.threadId,
      });

      if (!thread) {
        thread = {
          id: input.threadId,
          title: '',
          metadata: {},
          resourceId: this.#config.resourceId ?? input.threadId,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }

      const existingMemory = this.#parseStoredWorkingMemory({
        rawWorkingMemory: thread.metadata?.workingMemory,
        ctx,
      });

      const workingMemory = JSON.stringify({
        ...existingMemory,
        ...incomingState,
      });

      await memory.saveThread({
        thread: {
          ...thread,
          metadata: { ...thread.metadata, workingMemory },
        },
      });
    } catch (error) {
      this.#options.logger.error('run.memory.syncState.error', {
        threadId: ctx.threadId,
        runId: ctx.runId,
        messageId: ctx.messageId,
        error,
      });
    }
  }

  /**
   * Parses persisted working-memory metadata into a mergeable record.
   * @param options Working-memory parse options.
   * @returns Stored working-memory object, or an empty record when missing/corrupt.
   */
  #parseStoredWorkingMemory(options: {
    rawWorkingMemory: unknown;
    ctx: StreamRunContext;
  }): Record<string, unknown> {
    const rawWorkingMemory = options.rawWorkingMemory;
    if (typeof rawWorkingMemory !== 'string') {
      return {};
    }

    try {
      const parsedWorkingMemory: unknown = JSON.parse(rawWorkingMemory);
      return isRecord(parsedWorkingMemory) ? parsedWorkingMemory : {};
    } catch (error) {
      this.#options.logger.warn('run.memory.syncState.parseFallback', {
        threadId: options.ctx.threadId,
        runId: options.ctx.runId,
        messageId: options.ctx.messageId,
        error,
      });

      return {};
    }
  }

  /**
   * Reads working memory after stream completion and emits `STATE_SNAPSHOT` when available.
   * @param input Current run input.
   * @param ctx Mutable stream run context.
   */
  async #emitStateSnapshot(input: RunAgentInput, ctx: StreamRunContext): Promise<void> {
    const { agent } = this.#config;
    if (!this.#isLocalAgent(agent)) return;

    try {
      const memory = await agent.getMemory({
        requestContext: this.#config.requestContext,
      });
      if (!memory) return;

      const workingMemory = await memory.getWorkingMemory({
        resourceId: this.#config.resourceId,
        threadId: input.threadId,
        memoryConfig: { workingMemory: { enabled: true } },
      });

      if (typeof workingMemory === 'string') {
        const snapshot = JSON.parse(workingMemory);
        if (snapshot && !('$schema' in snapshot)) {
          ctx.emit({
            type: EventType.STATE_SNAPSHOT,
            snapshot,
          } satisfies StateSnapshotEvent);
        }
      }
    } catch (error) {
      this.#options.logger.error('run.memory.stateSnapshot.error', {
        threadId: ctx.threadId,
        runId: ctx.runId,
        messageId: ctx.messageId,
        error,
      });
    }
  }

  /**
   * Converts AG-UI tool descriptors into Mastra `clientTools` map format.
   * @param tools AG-UI tool descriptors from run input.
   */
  #buildClientTools(tools: RunAgentInput['tools']): ClientTools {
    return tools.reduce<ClientTools>((acc, tool) => {
      acc[tool.name] = {
        id: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      };
      return acc;
    }, {});
  }

  /**
   * Streams responses from a local Mastra agent and dispatches chunks via registry.
   * @param input Current run input.
   * @param ctx Mutable stream run context.
   * @param abortSignal Abort signal propagated to stream processing.
   */
  async #doLocalStream(
    input: RunAgentInput,
    ctx: StreamRunContext,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const { agent, resourceId, requestContext } = this.#config;
    if (!this.#isLocalAgent(agent)) return;

    const convertedMessages = convertAGUIMessagesToMastra(input.messages);
    requestContext?.set('ag-ui', { context: input.context });

    const clientTools = this.#buildClientTools(input.tools ?? []);
    const registry = this.#options.registry;
    const logger = this.#options.logger;

    const response = await agent.stream(convertedMessages, {
      memory: {
        thread: input.threadId,
        resource: resourceId ?? input.threadId,
      },
      runId: input.runId,
      clientTools,
      requestContext,
      // BUG-4 fix: pass abort signal so the underlying LLM call can be cancelled
      abortSignal,
    });

    if (!response || typeof response !== 'object') {
      throw new Error('Invalid response from local agent');
    }

    logger.debug('stream.local.started', {
      threadId: input.threadId,
      runId: input.runId,
      messageId: ctx.messageId,
    });

    // BUG-7 fix: try/finally to ensure cleanup
    try {
      for await (const chunk of response.fullStream) {
        if (abortSignal.aborted || ctx.aborted) break;
        if (chunk.type !== 'text-delta')
          logger.debug('stream.chunk.dispatched', {
            threadId: input.threadId,
            runId: input.runId,
            messageId: ctx.messageId,
            chunk,
          });
        registry.process(chunk, ctx);
        if (ctx.aborted) break;
      }
    } finally {
      logger.debug('stream.local.finished', {
        threadId: input.threadId,
        runId: input.runId,
        messageId: ctx.messageId,
      });
    }
  }

  /**
   * Streams responses from a remote Mastra agent and dispatches chunks via registry.
   * @param input Current run input.
   * @param ctx Mutable stream run context.
   * @param abortSignal Abort signal propagated to stream processing.
   */
  async #doRemoteStream(
    input: RunAgentInput,
    ctx: StreamRunContext,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const { agent, resourceId, requestContext } = this.#config;
    if (this.#isLocalAgent(agent)) return;

    const remoteAgent: RemoteMastraAgent = agent;

    const convertedMessages = convertAGUIMessagesToMastra(input.messages);
    requestContext?.set('ag-ui', { context: input.context });

    const clientTools = this.#buildClientTools(input.tools ?? []);
    const registry = this.#options.registry;
    const logger = this.#options.logger;

    const response = await remoteAgent.stream(convertedMessages, {
      memory: {
        thread: input.threadId,
        resource: resourceId ?? input.threadId,
      },
      runId: input.runId,
      clientTools,
    });

    if (!response || typeof response.processDataStream !== 'function') {
      throw new Error('Invalid response from remote agent');
    }

    // BUG-8 fix: abort mid-stream when signal fires
    const abortHandler = () => {
      ctx.markAborted();
    };
    abortSignal.addEventListener('abort', abortHandler, { once: true });

    logger.debug('stream.remote.started', {
      threadId: input.threadId,
      runId: input.runId,
      messageId: ctx.messageId,
    });

    try {
      await response.processDataStream({
        onChunk: async (chunk: StreamChunk) => {
          if (abortSignal.aborted || ctx.aborted) return;
          if (chunk.type !== 'text-delta')
            logger.debug('stream.chunk.dispatched', {
              threadId: input.threadId,
              runId: input.runId,
              messageId: ctx.messageId,
              chunk,
            });
          registry.process(chunk, ctx);
        },
      });
    } finally {
      abortSignal.removeEventListener('abort', abortHandler);
      logger.debug('stream.remote.finished', {
        threadId: input.threadId,
        runId: input.runId,
        messageId: ctx.messageId,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Static factory helpers
  // -------------------------------------------------------------------------

  /**
   * Resolves final adapter options by merging shorthand debug flag and explicit options.
   * @param debug Inline debug override.
   * @param adapterOptions Adapter options object.
   */
  static #resolveAdapterOptions(
    debug: boolean | undefined,
    adapterOptions: MastraAdapterOptions | undefined,
  ): MastraAdapterOptions {
    return {
      ...adapterOptions,
      debug: debug ?? adapterOptions?.debug,
    };
  }

  /**
   * Internal helper that creates a configured adapter for one agent instance.
   * @param agentId Adapter/agent identifier.
   * @param agent Local or remote Mastra agent.
   * @param options Shared adapter options.
   */
  static #createAdapter(
    agentId: string,
    agent: LocalMastraAgent | RemoteMastraAgent,
    options: AdapterCommonOptions,
  ): MastraAgentAdapter {
    return new MastraAgentAdapter(
      {
        agentId,
        agent,
        resourceId: options.resourceId,
        requestContext: options.requestContext,
      },
      this.#resolveAdapterOptions(options.debug, options.adapterOptions),
    );
  }

  /**
   * Creates AG-UI adapters for all local agents in a Mastra runtime.
   * @param options Factory options for local agents.
   */
  static getLocalAgents(options: GetLocalAgentsOptions): AGUIAgents {
    const agents = options.mastra.listAgents() ?? {};

    return Object.entries(agents).reduce<AGUIAgents>((acc, entry) => {
      const agentId = entry[0];
      const agent = entry[1];
      acc[agentId] = this.#createAdapter(agentId, agent, options);
      return acc;
    }, {});
  }

  /**
   * Creates AG-UI adapter for a specific local agent by ID.
   * @param options Factory options for a single local agent.
   */
  static getLocalAgent(options: GetLocalAgentOptions): AbstractAgent {
    const agent = options.mastra.getAgent(options.agentId);
    if (!agent) {
      throw new Error(`Agent ${options.agentId} not found`);
    }

    return this.#createAdapter(options.agentId, agent, options);
  }

  /**
   * Creates AG-UI adapters for all remote agents discovered via Mastra client.
   * @param options Factory options for remote agents.
   */
  static async getRemoteAgents(options: GetRemoteAgentsOptions): Promise<AGUIAgents> {
    const agents = await options.mastraClient.listAgents();

    return Object.entries(agents).reduce<AGUIAgents>((acc, entry) => {
      const agentId = entry[0];
      const agent = options.mastraClient.getAgent(agentId);
      acc[agentId] = this.#createAdapter(agentId, agent, options);
      return acc;
    }, {});
  }

  /**
   * Creates AG-UI adapter for a specific local network agent by ID.
   * @param options Factory options for a local network agent.
   */
  static getNetwork(options: GetNetworkOptions): AbstractAgent {
    const network = options.mastra.getAgent(options.networkId);
    if (!network) {
      throw new Error(`Network ${options.networkId} not found`);
    }

    return this.#createAdapter(
      network.id ?? options.networkId,
      network as LocalMastraAgent,
      options,
    );
  }
}

/** @deprecated Use `MastraAgentAdapter` instead. */
export { MastraAgentAdapter as MastraAgent };

/**
 * Extracts the latest user-authored text from AG-UI messages.
 * @param messages AG-UI message history.
 * @returns Latest user message preview; null when no text can be extracted.
 */
function extractLatestUserMessageText(messages: RunAgentInput['messages']): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;

    const messageContent = message.content;
    if (typeof messageContent === 'string') {
      const normalizedText = collapseWhitespace(messageContent);
      if (normalizedText.length > 0) {
        return toUserMessagePreview(normalizedText);
      }
      continue;
    }

    if (!Array.isArray(messageContent)) {
      continue;
    }

    const textParts: string[] = [];
    for (const part of messageContent) {
      if (part.type !== 'text') continue;
      const normalizedText = collapseWhitespace(part.text);
      if (normalizedText.length === 0) continue;
      textParts.push(normalizedText);
    }

    const combinedText = collapseWhitespace(textParts.join(' '));
    if (combinedText.length > 0) {
      return toUserMessagePreview(combinedText);
    }
  }

  return null;
}

/**
 * Truncates a user message preview to a readable length.
 * @param value Full normalized text.
 * @returns Short preview suitable for reasoning intro text.
 */
function toUserMessagePreview(value: string): string {
  if (value.length <= USER_MESSAGE_PREVIEW_LIMIT) {
    return value;
  }

  return `${value.slice(0, USER_MESSAGE_PREVIEW_LIMIT - 1).trimEnd()}…`;
}

/**
 * Collapses repeated whitespace in free-form text so reasoning previews stay compact.
 * @param value Raw input text.
 * @returns Whitespace-normalized text.
 */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Determines whether a parsed JSON value is a plain object record.
 * @param value Parsed JSON value.
 * @returns True when the value can be safely merged into working memory state.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalizes incoming AG-UI state into a mergeable record and strips transient messages.
 * @param state AG-UI run state payload.
 * @returns Mergeable state record without `messages`.
 */
function omitMessagesState(state: RunAgentInput['state']): Record<string, unknown> {
  if (!isRecord(state)) {
    return {};
  }

  const { messages: _messages, ...stateWithoutMessages } = state;
  return stateWithoutMessages;
}
