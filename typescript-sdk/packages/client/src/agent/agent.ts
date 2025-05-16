import { defaultApplyEvents } from "@/apply/default";
import { Message, State, RunAgentInput, RunAgent, ApplyEvents, BaseEvent } from "@ag-ui/core";

import { AgentConfig, RunAgentParameters } from "./types";
import { v4 as uuidv4 } from "uuid";
import { structuredClone_ } from "@/utils";
import { catchError, map, tap } from "rxjs/operators";
import { finalize } from "rxjs/operators";
import { throwError, pipe, Observable } from "rxjs";
import { verifyEvents } from "@/verify";
import { convertToLegacyEvents } from "@/legacy/convert";
import { LegacyRuntimeProtocolEvent } from "@/legacy/types";
import { lastValueFrom, of } from "rxjs";
import { transformChunks } from "@/chunks";

export abstract class AbstractAgent {
  public agentId?: string;
  public description: string;
  public threadId: string;
  public messages: Message[];
  public state: State;
  public debug: boolean;

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

  protected abstract run(...args: Parameters<RunAgent>): ReturnType<RunAgent>;

  public async runAgent(parameters?: RunAgentParameters): Promise<void> {
    this.agentId = this.agentId ?? uuidv4();
    const input = this.prepareRunAgentInput(parameters);

    const pipeline = pipe(
      () => this.run(input),
      transformChunks(this.debug),
      verifyEvents(this.debug),
      (source$) => this.apply(input, source$),
      (source$) => this.processApplyEvents(input, source$),
      catchError((error) => {
        this.onError(error);
        return throwError(() => error);
      }),
      finalize(() => {
        this.onFinalize();
      }),
    );

    return lastValueFrom(pipeline(of(null))).then(() => {});
  }

  public abortRun() {}

  protected apply(...args: Parameters<ApplyEvents>): ReturnType<ApplyEvents> {
    return defaultApplyEvents(...args);
  }

  protected processApplyEvents(
    input: RunAgentInput,
    events$: ReturnType<ApplyEvents>,
  ): ReturnType<ApplyEvents> {
    return events$.pipe(
      tap((event) => {
        if (event.messages) {
          this.messages = event.messages;
        }
        if (event.state) {
          this.state = event.state;
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

  protected onError(error: Error) {
    console.error("Agent execution failed:", error);
  }

  protected onFinalize() {}

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
