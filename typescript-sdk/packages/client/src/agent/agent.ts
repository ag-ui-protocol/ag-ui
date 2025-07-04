import { defaultApplyEvents } from "@/apply/default";
import { Message, State, RunAgentInput, BaseEvent } from "@ag-ui/core";

import { AgentConfig, RunAgentParameters } from "./types";
import { v4 as uuidv4 } from "uuid";
import { structuredClone_ } from "@/utils";
import { catchError, map, tap, mergeMap } from "rxjs/operators";
import { finalize } from "rxjs/operators";
import { pipe, Observable, from, of, EMPTY } from "rxjs";
import { verifyEvents } from "@/verify";
import { convertToLegacyEvents } from "@/legacy/convert";
import { LegacyRuntimeProtocolEvent } from "@/legacy/types";
import { lastValueFrom } from "rxjs";
import { transformChunks } from "@/chunks";
import { AgentStateMutation, RunAgentSubscriber, runSubscribersWithMutation } from "./subscriber";

export abstract class AbstractAgent {
  public agentId?: string;
  public description: string;
  public threadId: string;
  public messages: Message[];
  public state: State;
  public debug: boolean = false;
  public subscribers: RunAgentSubscriber[] = [];

  constructor({
    agentId,
    description,
    threadId,
    initialMessages,
    initialState,
    debug,
  }: AgentConfig = {}) {
    this.agentId = agentId;
    this.description = description ?? "";
    this.threadId = threadId ?? uuidv4();
    this.messages = structuredClone_(initialMessages ?? []);
    this.state = structuredClone_(initialState ?? {});
    this.debug = debug ?? false;
  }

  public subscribe(subscriber: RunAgentSubscriber) {
    this.subscribers.push(subscriber);
    return {
      unsubscribe: () => {
        this.subscribers = this.subscribers.filter((s) => s !== subscriber);
      },
    };
  }

  protected abstract run(input: RunAgentInput): Observable<BaseEvent>;

  public async runAgent(
    parameters?: RunAgentParameters,
    subscriber?: RunAgentSubscriber,
  ): Promise<any> {
    this.agentId = this.agentId ?? uuidv4();
    const input = this.prepareRunAgentInput(parameters);
    let result: any = undefined;
    const subscribers: RunAgentSubscriber[] = [
      {
        onRunFinishedEvent: (params) => {
          result = params.result;
        },
      },
      ...this.subscribers,
      subscriber ?? {},
    ];

    await this.onInitialize(input, subscribers);

    const pipeline = pipe(
      () => this.run(input),
      transformChunks(this.debug),
      verifyEvents(this.debug),
      (source$) => this.apply(input, source$, subscribers),
      (source$) => this.processApplyEvents(input, source$, subscribers),
      catchError((error) => {
        return this.onError(input, error, subscribers);
      }),
      finalize(() => {
        void this.onFinalize(input, subscribers);
      }),
    );

    return lastValueFrom(pipeline(of(null))).then(() => result);
  }

  public abortRun() {}

  protected apply(
    input: RunAgentInput,
    events$: Observable<BaseEvent>,
    subscribers: RunAgentSubscriber[],
  ): Observable<AgentStateMutation> {
    return defaultApplyEvents(input, events$, this, subscribers);
  }

  protected processApplyEvents(
    input: RunAgentInput,
    events$: Observable<AgentStateMutation>,
    subscribers: RunAgentSubscriber[],
  ): Observable<AgentStateMutation> {
    return events$.pipe(
      tap((event) => {
        if (event.messages) {
          this.messages = event.messages;
          subscribers.forEach((subscriber) => {
            subscriber.onMessagesChanged?.({
              messages: this.messages,
              agent: this,
              input,
            });
          });
        }
        if (event.state) {
          this.state = event.state;
          subscribers.forEach((subscriber) => {
            subscriber.onStateChanged?.({
              state: this.state,
              agent: this,
              input,
            });
          });
        }
      }),
    );
  }

  protected prepareRunAgentInput(parameters?: RunAgentParameters): RunAgentInput {
    return {
      threadId: this.threadId,
      runId: parameters?.runId || uuidv4(),
      tools: structuredClone_(parameters?.tools ?? []),
      context: structuredClone_(parameters?.context ?? []),
      forwardedProps: structuredClone_(parameters?.forwardedProps ?? {}),
      state: structuredClone_(this.state),
      messages: structuredClone_(this.messages),
    };
  }

  protected async onInitialize(input: RunAgentInput, subscribers: RunAgentSubscriber[]) {
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
            agent: this,
            input,
          });
        });
      }
    }
  }

  protected onError(input: RunAgentInput, error: Error, subscribers: RunAgentSubscriber[]) {
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

        return null as unknown as never;
      }),
      mergeMap((value) => (value === null ? EMPTY : of(value))),
    );
  }

  protected async onFinalize(input: RunAgentInput, subscribers: RunAgentSubscriber[]) {
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
            agent: this,
            input,
          });
        });
      }
    }
  }

  public clone() {
    const cloned = Object.create(Object.getPrototypeOf(this));

    for (const key of Object.getOwnPropertyNames(this)) {
      const value = (this as any)[key];
      if (typeof value !== "function") {
        cloned[key] = structuredClone_(value);
      }
    }

    return cloned;
  }

  public legacy_to_be_removed_runAgentBridged(
    config?: RunAgentParameters,
  ): Observable<LegacyRuntimeProtocolEvent> {
    this.agentId = this.agentId ?? uuidv4();
    const input = this.prepareRunAgentInput(config);

    return this.run(input).pipe(
      transformChunks(this.debug),
      verifyEvents(this.debug),
      convertToLegacyEvents(this.threadId, input.runId, this.agentId),
      (events$: Observable<LegacyRuntimeProtocolEvent>) => {
        return events$.pipe(
          map((event) => {
            if (this.debug) {
              console.debug("[LEGACY]:", JSON.stringify(event));
            }
            return event;
          }),
        );
      },
    );
  }
}
