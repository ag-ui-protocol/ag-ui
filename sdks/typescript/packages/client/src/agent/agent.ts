import { defaultApplyEvents } from "@/apply/default";
import {
  Message,
  State,
  RunAgentInput,
  BaseEvent,
  ToolCall,
  AssistantMessage,
  AgentCapabilities,
} from "@ag-ui/core";

import {
  AgentConfig,
  AgentDebugConfig,
  NotificationThrottleConfig,
  RunAgentParameters,
  ResolvedAgentDebugConfig,
  resolveAgentDebugConfig,
} from "./types";
import { DebugLogger, createDebugLogger } from "@/debug-logger";
import { v4 as uuidv4 } from "uuid";
import { structuredClone_ } from "@/utils";
import { compareVersions } from "compare-versions";
import { catchError, map, tap } from "rxjs/operators";
import { finalize } from "rxjs/operators";
import { takeUntil } from "rxjs/operators";
import { pipe, Observable, from, of, EMPTY, Subject, defer } from "rxjs";
import { verifyEvents } from "@/verify";
import { convertToLegacyEvents } from "@/legacy/convert";
import { LegacyRuntimeProtocolEvent } from "@/legacy/types";
import { lastValueFrom } from "rxjs";
import { transformChunks } from "@/chunks";
import { AgentStateMutation, AgentSubscriber, runSubscribersWithMutation } from "./subscriber";
import { AGUIConnectNotImplementedError } from "@ag-ui/core";
import {
  Middleware,
  MiddlewareFunction,
  FunctionMiddleware,
  BackwardCompatibility_0_0_39,
  BackwardCompatibility_0_0_45,
} from "@/middleware";
import packageJson from "../../package.json";

export interface RunAgentResult {
  result: any;
  newMessages: Message[];
}

export abstract class AbstractAgent {
  public agentId?: string;
  public description: string;
  public threadId: string;
  public messages: Message[];
  public state: State;
  private _debug: ResolvedAgentDebugConfig;
  private _debugLogger: DebugLogger | undefined;
  public readonly notificationThrottle: NotificationThrottleConfig | undefined;
  public subscribers: AgentSubscriber[] = [];
  public isRunning: boolean = false;
  private middlewares: Middleware[] = [];
  // Emits to immediately detach from the active run (stop processing its stream)
  private activeRunDetach$?: Subject<void>;
  private activeRunCompletionPromise?: Promise<void>;

  get maxVersion() {
    return packageJson.version;
  }

  get debug(): ResolvedAgentDebugConfig {
    return this._debug;
  }

  set debug(value: AgentDebugConfig | ResolvedAgentDebugConfig) {
    this._debug = resolveAgentDebugConfig(value as AgentDebugConfig);
    this._debugLogger = createDebugLogger(this._debug);
  }

  get debugLogger(): DebugLogger | undefined {
    return this._debugLogger;
  }

  set debugLogger(value: DebugLogger | boolean | undefined) {
    if (typeof value === "boolean") {
      this._debugLogger = value
        ? createDebugLogger(resolveAgentDebugConfig(true))
        : undefined;
    } else {
      this._debugLogger = value;
    }
  }

  constructor({
    agentId,
    description,
    threadId,
    initialMessages,
    initialState,
    debug,
    notificationThrottle,
  }: AgentConfig = {}) {
    this.agentId = agentId;
    this.description = description ?? "";
    this.threadId = threadId ?? uuidv4();
    this.messages = structuredClone_(initialMessages ?? []);
    this.state = structuredClone_(initialState ?? {});
    this._debug = resolveAgentDebugConfig(debug);
    this._debugLogger = createDebugLogger(this._debug);

    if (notificationThrottle) {
      const { intervalMs, minChunkSize } = notificationThrottle;
      if (!Number.isFinite(intervalMs) || intervalMs < 0) {
        throw new Error(
          `notificationThrottle.intervalMs must be a non-negative finite number, got ${intervalMs}`,
        );
      }
      if (minChunkSize !== undefined && (!Number.isFinite(minChunkSize) || minChunkSize < 0)) {
        throw new Error(
          `notificationThrottle.minChunkSize must be a non-negative finite number, got ${minChunkSize}`,
        );
      }
      this.notificationThrottle = {
        intervalMs,
        minChunkSize: minChunkSize ?? 0,
      };
    }

    if (compareVersions(this.maxVersion, "0.0.39") <= 0) {
      this.middlewares.unshift(new BackwardCompatibility_0_0_39());
    }

    // Auto-insert BackwardCompatibility_0_0_45 for backward compatibility
    // with legacy THINKING events (deprecated, will be removed in 1.0.0)
    if (compareVersions(this.maxVersion, "0.0.45") <= 0) {
      this.middlewares.unshift(new BackwardCompatibility_0_0_45());
    }
  }

  public subscribe(subscriber: AgentSubscriber) {
    this.subscribers.push(subscriber);
    return {
      unsubscribe: () => {
        this.subscribers = this.subscribers.filter((s) => s !== subscriber);
      },
    };
  }

  abstract run(input: RunAgentInput): Observable<BaseEvent>;

  /**
   * Returns the agent's current capabilities.
   * Optional — subclasses implement this to advertise what they support.
   */
  getCapabilities?(): Promise<AgentCapabilities>;

  public use(...middlewares: (Middleware | MiddlewareFunction)[]): this {
    const normalizedMiddlewares = middlewares.map((middleware) =>
      typeof middleware === "function" ? new FunctionMiddleware(middleware) : middleware,
    );
    this.middlewares.push(...normalizedMiddlewares);
    return this;
  }

  public async runAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    try {
      this.isRunning = true;
      this.agentId = this.agentId ?? uuidv4();
      const input = this.prepareRunAgentInput(parameters);

      this.debugLogger?.lifecycle("LIFECYCLE", "Run started:", {
        agentId: this.agentId,
        threadId: this.threadId,
      });

      let result: any = undefined;
      const currentMessageIds = new Set(this.messages.map((message) => message.id));

      const subscribers: AgentSubscriber[] = [
        {
          onRunFinishedEvent: (params) => {
            result = params.result;
          },
        },
        ...this.subscribers,
        subscriber ?? {},
      ];

      await this.onInitialize(input, subscribers);

      // Per-run detachment signal + completion promise
      this.activeRunDetach$ = new Subject<void>();
      let resolveActiveRunCompletion: (() => void) | undefined;
      this.activeRunCompletionPromise = new Promise<void>((resolve) => {
        resolveActiveRunCompletion = resolve;
      });

      const pipeline = pipe(
        () => {
          // Build middleware chain using reduceRight so middlewares can intercept runs.
          if (this.middlewares.length === 0) {
            return this.run(input);
          }

          const chainedAgent = this.middlewares.reduceRight(
            (nextAgent: AbstractAgent, middleware) =>
              ({
                run: (i: RunAgentInput) => middleware.run(i, nextAgent),
                get messages() {
                  return nextAgent.messages;
                },
                get state() {
                  return nextAgent.state;
                },
              }) as AbstractAgent,
            this, // Original agent is the final 'next'
          );

          return chainedAgent.run(input);
        },
        transformChunks(this.debugLogger),
        verifyEvents(this.debugLogger),
        // Stop processing immediately when this run is detached
        (source$) => source$.pipe(takeUntil(this.activeRunDetach$!)),
        (source$) => this.apply(input, source$, subscribers),
        (source$) => this.processApplyEvents(input, source$, subscribers),
        catchError((error) => {
          this.debugLogger?.lifecycle("LIFECYCLE", "Run errored:", {
            agentId: this.agentId,
            error: error instanceof Error ? error.message : String(error),
          });
          this.isRunning = false;
          return this.onError(input, error, subscribers);
        }),
        finalize(() => {
          this.debugLogger?.lifecycle("LIFECYCLE", "Run finished:", {
            agentId: this.agentId,
            threadId: this.threadId,
          });
          this.isRunning = false;
          void this.onFinalize(input, subscribers);
          resolveActiveRunCompletion?.();
          resolveActiveRunCompletion = undefined;
          this.activeRunCompletionPromise = undefined;
          this.activeRunDetach$ = undefined;
        }),
      );

      await lastValueFrom(pipeline(of(null)));
      const newMessages = structuredClone_(this.messages).filter(
        (message: Message) => !currentMessageIds.has(message.id),
      );
      return { result, newMessages };
    } finally {
      this.isRunning = false;
    }
  }

  protected connect(input: RunAgentInput): Observable<BaseEvent> {
    throw new AGUIConnectNotImplementedError();
  }
  public async connectAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    try {
      this.isRunning = true;
      this.agentId = this.agentId ?? uuidv4();
      const input = this.prepareRunAgentInput(parameters);
      let result: any = undefined;
      const currentMessageIds = new Set(this.messages.map((message) => message.id));

      const subscribers: AgentSubscriber[] = [
        {
          onRunFinishedEvent: (params) => {
            result = params.result;
          },
        },
        ...this.subscribers,
        subscriber ?? {},
      ];

      await this.onInitialize(input, subscribers);

      // Per-run detachment signal + completion promise
      this.activeRunDetach$ = new Subject<void>();
      let resolveActiveRunCompletion: (() => void) | undefined;
      this.activeRunCompletionPromise = new Promise<void>((resolve) => {
        resolveActiveRunCompletion = resolve;
      });

      const pipeline = pipe(
        () => defer(() => this.connect(input)),
        transformChunks(this.debugLogger),
        verifyEvents(this.debugLogger),
        // Stop processing immediately when this run is detached
        (source$) => source$.pipe(takeUntil(this.activeRunDetach$!)),
        (source$) => this.apply(input, source$, subscribers),
        (source$) => this.processApplyEvents(input, source$, subscribers),
        catchError((error) => {
          this.isRunning = false;
          if (!(error instanceof AGUIConnectNotImplementedError)) {
            return this.onError(input, error, subscribers);
          }
          return EMPTY;
        }),
        finalize(() => {
          this.isRunning = false;
          void this.onFinalize(input, subscribers);
          resolveActiveRunCompletion?.();
          resolveActiveRunCompletion = undefined;
          this.activeRunCompletionPromise = undefined;
          this.activeRunDetach$ = undefined;
        }),
      );

      // defaultValue prevents EmptyError when catchError returns EMPTY
      // (e.g. ConnectNotImplementedError path)
      await lastValueFrom(pipeline(of(null)), { defaultValue: undefined });
      const newMessages = structuredClone_(this.messages).filter(
        (message: Message) => !currentMessageIds.has(message.id),
      );
      return { result, newMessages };
    } finally {
      this.isRunning = false;
    }
  }

  public abortRun() {}

  public async detachActiveRun(): Promise<void> {
    if (!this.activeRunDetach$) {
      return;
    }
    const completion = this.activeRunCompletionPromise ?? Promise.resolve();
    this.activeRunDetach$.next();
    this.activeRunDetach$?.complete();
    await completion;
  }

  protected apply(
    input: RunAgentInput,
    events$: Observable<BaseEvent>,
    subscribers: AgentSubscriber[],
  ): Observable<AgentStateMutation> {
    return defaultApplyEvents(input, events$, this, subscribers, this.debugLogger);
  }

  protected processApplyEvents(
    input: RunAgentInput,
    events$: Observable<AgentStateMutation>,
    subscribers: AgentSubscriber[],
  ): Observable<AgentStateMutation> {
    // Step 1: Always apply mutations immediately (agent.messages/state stay current)
    const mutated$ = events$.pipe(
      tap((event) => {
        if (event.messages) this.messages = event.messages;
        if (event.state) this.state = event.state;
      }),
    );

    // Step 2: Notify subscribers — throttled when configured, immediate otherwise
    if (this.notificationThrottle) {
      return this.processThrottledNotifications(mutated$, input, subscribers);
    }

    return mutated$.pipe(
      tap((event) => {
        if (event.messages) {
          subscribers.forEach((subscriber) => {
            subscriber.onMessagesChanged?.({
              messages: this.messages,
              state: this.state,
              agent: this,
              input,
            });
          });
        }
        if (event.state) {
          subscribers.forEach((subscriber) => {
            subscriber.onStateChanged?.({
              state: this.state,
              messages: this.messages,
              agent: this,
              input,
            });
          });
        }
      }),
    );
  }

  /**
   * Throttled notification layer.
   *
   * The first event always fires immediately (leading edge). Subsequent
   * notifications fire when any condition is met:
   *   - `intervalMs` has elapsed since the last notification, OR
   *   - `minChunkSize` new characters have accumulated on the active assistant message
   *
   * A trailing timer ensures pending notifications are flushed after each
   * window. On stream completion (or error), any remaining pending
   * notification is always delivered.
   */
  private processThrottledNotifications(
    mutated$: Observable<AgentStateMutation>,
    input: RunAgentInput,
    subscribers: AgentSubscriber[],
  ): Observable<AgentStateMutation> {
    const throttleMs = this.notificationThrottle!.intervalMs;
    const minChunkSize = this.notificationThrottle!.minChunkSize ?? 0;

    let lastNotifyTime = 0;
    let charsSinceLastNotify = 0;
    let lastContentLength = 0;
    let lastTrackedMessageId: string | null = null;
    let pendingMessages = false;
    let pendingState = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const notify = () => {
      if (disposed) return;
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      lastNotifyTime = Date.now();
      charsSinceLastNotify = 0;

      // Snapshot the content length of the current trailing assistant message
      if (this.messages.length > 0) {
        const lastMsg = this.messages[this.messages.length - 1];
        if (lastMsg.role === "assistant" && typeof lastMsg.content === "string") {
          lastContentLength = lastMsg.content.length;
          lastTrackedMessageId = lastMsg.id;
        }
      }

      if (pendingMessages) {
        pendingMessages = false;
        subscribers.forEach((subscriber) => {
          try {
            subscriber.onMessagesChanged?.({
              messages: this.messages,
              state: this.state,
              agent: this,
              input,
            });
          } catch (err) {
            console.error("AG-UI: Subscriber onMessagesChanged threw during throttled notification:", err);
          }
        });
      }
      if (pendingState) {
        pendingState = false;
        subscribers.forEach((subscriber) => {
          try {
            subscriber.onStateChanged?.({
              state: this.state,
              messages: this.messages,
              agent: this,
              input,
            });
          } catch (err) {
            console.error("AG-UI: Subscriber onStateChanged threw during throttled notification:", err);
          }
        });
      }
    };

    const scheduleTrailing = () => {
      if (timerId !== null) return;
      const elapsed = Date.now() - lastNotifyTime;
      const remaining = Math.max(0, throttleMs - elapsed);
      timerId = setTimeout(notify, remaining);
    };

    return mutated$.pipe(
      tap((event) => {
        if (event.messages) {
          if (minChunkSize > 0 && this.messages.length > 0) {
            const lastMsg = this.messages[this.messages.length - 1];
            if (lastMsg.role === "assistant" && typeof lastMsg.content === "string") {
              // Reset tracking when the message identity changes
              if (lastMsg.id !== lastTrackedMessageId) {
                lastTrackedMessageId = lastMsg.id;
                lastContentLength = 0;
              }
              charsSinceLastNotify = Math.max(0, lastMsg.content.length - lastContentLength);
            }
          }
          pendingMessages = true;
        }
        if (event.state) {
          pendingState = true;
        }

        const now = Date.now();
        // Sentinel: lastNotifyTime is 0 only before the very first notification
        const isLeading = lastNotifyTime === 0;
        const timeThresholdMet = throttleMs > 0 && (now - lastNotifyTime) >= throttleMs;
        const chunkThresholdMet = minChunkSize > 0 && charsSinceLastNotify >= minChunkSize;

        if (isLeading || timeThresholdMet || chunkThresholdMet) {
          notify();
        } else {
          scheduleTrailing();
        }
      }),
      finalize(() => {
        disposed = true;
        if (timerId !== null) {
          clearTimeout(timerId);
          timerId = null;
        }
        if (pendingMessages || pendingState) {
          // Temporarily allow one final flush even though disposed
          disposed = false;
          notify();
          disposed = true;
        }
      }),
    );
  }

  protected prepareRunAgentInput(parameters?: RunAgentParameters): RunAgentInput {
    const clonedMessages = structuredClone_(this.messages) as Message[];
    const messagesWithoutActivity = clonedMessages.filter((message) => message.role !== "activity");

    return {
      threadId: this.threadId,
      runId: parameters?.runId || uuidv4(),
      tools: structuredClone_(parameters?.tools ?? []),
      context: structuredClone_(parameters?.context ?? []),
      forwardedProps: structuredClone_(parameters?.forwardedProps ?? {}),
      state: structuredClone_(this.state),
      messages: messagesWithoutActivity,
    };
  }

  protected async onInitialize(input: RunAgentInput, subscribers: AgentSubscriber[]) {
    const onRunInitializedMutation = await runSubscribersWithMutation(
      subscribers,
      this.messages,
      this.state,
      (subscriber, messages, state) =>
        subscriber.onRunInitialized?.({ messages, state, agent: this, input }),
    );
    if (
      onRunInitializedMutation.messages !== undefined ||
      onRunInitializedMutation.state !== undefined
    ) {
      if (onRunInitializedMutation.messages) {
        this.messages = onRunInitializedMutation.messages;
        input.messages = onRunInitializedMutation.messages;
        subscribers.forEach((subscriber) => {
          subscriber.onMessagesChanged?.({
            messages: this.messages,
            state: this.state,
            agent: this,
            input,
          });
        });
      }
      if (onRunInitializedMutation.state) {
        this.state = onRunInitializedMutation.state;
        input.state = onRunInitializedMutation.state;
        subscribers.forEach((subscriber) => {
          subscriber.onStateChanged?.({
            state: this.state,
            messages: this.messages,
            agent: this,
            input,
          });
        });
      }
    }
  }

  protected onError(input: RunAgentInput, error: Error, subscribers: AgentSubscriber[]) {
    return from(
      runSubscribersWithMutation(
        subscribers,
        this.messages,
        this.state,
        (subscriber, messages, state) =>
          subscriber.onRunFailed?.({ error, messages, state, agent: this, input }),
      ),
    ).pipe(
      map((onRunFailedMutation) => {
        const mutation = onRunFailedMutation as AgentStateMutation;
        if (mutation.messages !== undefined || mutation.state !== undefined) {
          if (mutation.messages !== undefined) {
            this.messages = mutation.messages;
            subscribers.forEach((subscriber) => {
              subscriber.onMessagesChanged?.({
                messages: this.messages,
                state: this.state,
                agent: this,
                input,
              });
            });
          }
          if (mutation.state !== undefined) {
            this.state = mutation.state;
            subscribers.forEach((subscriber) => {
              subscriber.onStateChanged?.({
                state: this.state,
                messages: this.messages,
                agent: this,
                input,
              });
            });
          }
        }

        if (mutation.stopPropagation !== true) {
          console.error("Agent execution failed:", error);
          throw error;
        }

        // Return an empty mutation instead of null to prevent EmptyError
        return {} as AgentStateMutation;
      }),
    );
  }

  protected async onFinalize(input: RunAgentInput, subscribers: AgentSubscriber[]) {
    const onRunFinalizedMutation = await runSubscribersWithMutation(
      subscribers,
      this.messages,
      this.state,
      (subscriber, messages, state) =>
        subscriber.onRunFinalized?.({ messages, state, agent: this, input }),
    );

    if (
      onRunFinalizedMutation.messages !== undefined ||
      onRunFinalizedMutation.state !== undefined
    ) {
      if (onRunFinalizedMutation.messages !== undefined) {
        this.messages = onRunFinalizedMutation.messages;
        subscribers.forEach((subscriber) => {
          subscriber.onMessagesChanged?.({
            messages: this.messages,
            state: this.state,
            agent: this,
            input,
          });
        });
      }
      if (onRunFinalizedMutation.state !== undefined) {
        this.state = onRunFinalizedMutation.state;
        subscribers.forEach((subscriber) => {
          subscriber.onStateChanged?.({
            state: this.state,
            messages: this.messages,
            agent: this,
            input,
          });
        });
      }
    }
  }

  public clone() {
    const cloned = Object.create(Object.getPrototypeOf(this));

    cloned.agentId = this.agentId;
    cloned.description = this.description;
    cloned.threadId = this.threadId;
    cloned.messages = structuredClone_(this.messages);
    cloned.state = structuredClone_(this.state);
    cloned._debug = this._debug;
    cloned._debugLogger = this._debugLogger;
    // notificationThrottle is readonly on the class; bypass via Object.defineProperty
    Object.defineProperty(cloned, "notificationThrottle", {
      value: this.notificationThrottle
        ? { ...this.notificationThrottle }
        : undefined,
      writable: false,
      enumerable: true,
      configurable: true,
    });
    cloned.isRunning = this.isRunning;
    cloned.subscribers = [...this.subscribers];
    cloned.middlewares = [...this.middlewares];

    return cloned;
  }

  public addMessage(message: Message) {
    // Add message to the messages array
    this.messages.push(message);

    // Notify subscribers sequentially in the background
    (async () => {
      // Fire onNewMessage sequentially
      for (const subscriber of this.subscribers) {
        await subscriber.onNewMessage?.({
          message,
          messages: this.messages,
          state: this.state,
          agent: this,
        });
      }

      // Fire onNewToolCall if the message is from assistant and contains tool calls
      if (message.role === "assistant" && message.toolCalls) {
        for (const toolCall of message.toolCalls) {
          for (const subscriber of this.subscribers) {
            await subscriber.onNewToolCall?.({
              toolCall,
              messages: this.messages,
              state: this.state,
              agent: this,
            });
          }
        }
      }

      // Fire onMessagesChanged sequentially
      for (const subscriber of this.subscribers) {
        await subscriber.onMessagesChanged?.({
          messages: this.messages,
          state: this.state,
          agent: this,
        });
      }
    })();
  }

  public addMessages(messages: Message[]) {
    // Add all messages to the messages array
    this.messages.push(...messages);

    // Notify subscribers sequentially in the background
    (async () => {
      // Fire onNewMessage and onNewToolCall for each message sequentially
      for (const message of messages) {
        // Fire onNewMessage sequentially
        for (const subscriber of this.subscribers) {
          await subscriber.onNewMessage?.({
            message,
            messages: this.messages,
            state: this.state,
            agent: this,
          });
        }

        // Fire onNewToolCall if the message is from assistant and contains tool calls
        if (message.role === "assistant" && message.toolCalls) {
          for (const toolCall of message.toolCalls) {
            for (const subscriber of this.subscribers) {
              await subscriber.onNewToolCall?.({
                toolCall,
                messages: this.messages,
                state: this.state,
                agent: this,
              });
            }
          }
        }
      }

      // Fire onMessagesChanged once at the end sequentially
      for (const subscriber of this.subscribers) {
        await subscriber.onMessagesChanged?.({
          messages: this.messages,
          state: this.state,
          agent: this,
        });
      }
    })();
  }

  public setMessages(messages: Message[]) {
    // Replace the entire messages array
    this.messages = structuredClone_(messages);

    // Notify subscribers sequentially in the background
    (async () => {
      // Fire onMessagesChanged sequentially
      for (const subscriber of this.subscribers) {
        await subscriber.onMessagesChanged?.({
          messages: this.messages,
          state: this.state,
          agent: this,
        });
      }
    })();
  }

  public setState(state: State) {
    // Replace the entire state
    this.state = structuredClone_(state);

    // Notify subscribers sequentially in the background
    (async () => {
      // Fire onStateChanged sequentially
      for (const subscriber of this.subscribers) {
        await subscriber.onStateChanged?.({
          messages: this.messages,
          state: this.state,
          agent: this,
        });
      }
    })();
  }

  public legacy_to_be_removed_runAgentBridged(
    config?: RunAgentParameters,
  ): Observable<LegacyRuntimeProtocolEvent> {
    this.agentId = this.agentId ?? uuidv4();
    const input = this.prepareRunAgentInput(config);

    // Build middleware chain for legacy bridge
    const runObservable = (() => {
      if (this.middlewares.length === 0) {
        return this.run(input);
      }

      const chainedAgent = this.middlewares.reduceRight(
        (nextAgent: AbstractAgent, middleware) =>
          ({
            run: (i: RunAgentInput) => middleware.run(i, nextAgent),
            get messages() {
              return nextAgent.messages;
            },
            get state() {
              return nextAgent.state;
            },
          }) as AbstractAgent,
        this,
      );

      return chainedAgent.run(input);
    })();

    return runObservable.pipe(
      transformChunks(this.debugLogger),
      verifyEvents(this.debugLogger),
      convertToLegacyEvents(this.threadId, input.runId, this.agentId),
      (events$: Observable<LegacyRuntimeProtocolEvent>) => {
        return events$.pipe(
          map((event) => {
            this.debugLogger?.event("LEGACY", "Event:", event, { type: event.type });
            return event;
          }),
        );
      },
    );
  }
}
