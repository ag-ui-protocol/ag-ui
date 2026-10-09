import { describe, it, expect, expectTypeOf } from "vitest";
import { of, type Observable } from "rxjs";
import {
  EventType,
  type BaseEvent,
  type Interrupt,
  type Message,
  type RunAgentInput,
  type RunFinishedEvent,
  type RunStartedEvent,
  type State,
} from "@ag-ui/core";
import { AbstractAgent, type RunAgentResult } from "@/agent/agent";
import { HttpAgent } from "@/agent/http";
import type {
  Agent,
  ConnectAgentOptions,
  ResolvedAgentDebugConfig,
  RunAgentParameters,
} from "@/agent/types";
import type { AgentSubscriber } from "@/agent/subscriber";
import type { DebugLogger } from "@/debug-logger";
import type * as V1 from "./fixtures/client-1-0";

const THREAD_ID = "thread-1";
const RUN_ID = "run-1";

const runStarted: RunStartedEvent = {
  type: EventType.RUN_STARTED,
  threadId: THREAD_ID,
  runId: RUN_ID,
};
const runFinished: RunFinishedEvent = {
  type: EventType.RUN_FINISHED,
  threadId: THREAD_ID,
  runId: RUN_ID,
};

class ScriptedAgent extends AbstractAgent {
  constructor(private readonly events: BaseEvent[]) {
    super({ threadId: THREAD_ID });
  }

  run(): Observable<BaseEvent> {
    return of(...this.events);
  }
}

/** Code written against this copy: it only takes the class. */
function readThreadId(agent: AbstractAgent) {
  return agent.threadId;
}

/*
 * A second copy of the client, as an app gets it from a duplicate install.
 * Each class has its own private or protected member, so none of them match
 * the classes of this copy. The class extends nothing.
 */
declare class ForeignDebugLogger {
  private readonly config: ResolvedAgentDebugConfig;
  event(prefix: string, label: string, data: unknown, summary?: Record<string, unknown>): void;
  lifecycle(prefix: string, label: string, data?: Record<string, unknown>): void;
  get eventsEnabled(): boolean;
  get lifecycleEnabled(): boolean;
  get enabled(): boolean;
}

declare abstract class ForeignMiddleware {
  abstract run(input: RunAgentInput, next: ForeignAgent): Observable<BaseEvent>;
  protected runNext(input: RunAgentInput, next: ForeignAgent): Observable<BaseEvent>;
}

type ForeignMiddlewareFunction = (
  input: RunAgentInput,
  next: ForeignAgent,
) => Observable<BaseEvent>;

declare class ForeignAgent {
  private readonly middlewares: ForeignMiddleware[];
  agentId?: string;
  description: string;
  threadId: string;
  messages: Message[];
  state: State;
  subscribers: AgentSubscriber<ForeignAgent>[];
  isRunning: boolean;
  pendingInterrupts: Interrupt[];
  get maxProtocolVersion(): string;
  get debug(): ResolvedAgentDebugConfig;
  get debugLogger(): ForeignDebugLogger | undefined;
  get activeRunCompletion(): Promise<void> | undefined;
  run(input: RunAgentInput): Observable<BaseEvent>;
  subscribe(subscriber: AgentSubscriber<ForeignAgent>): { unsubscribe: () => void };
  use(...middlewares: (ForeignMiddleware | ForeignMiddlewareFunction)[]): this;
  runAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber<ForeignAgent>,
  ): Promise<RunAgentResult>;
  connectAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber<ForeignAgent>,
    options?: ConnectAgentOptions,
  ): Promise<RunAgentResult>;
  abortRun(): void;
  detachActiveRun(): Promise<void>;
  clone(): ForeignAgent;
  addMessage(message: Message): void;
  addMessages(messages: Message[]): void;
  setMessages(messages: Message[]): void;
  setState(state: State): void;
  supportsConnect(): boolean;
}

describe("Agent accepts agents from any copy of @ag-ui/client", () => {
  it("accepts HttpAgent and AbstractAgent from @ag-ui/client 1.0.0", () => {
    expectTypeOf<V1.HttpAgent>().toExtend<Agent>();
    expectTypeOf<V1.AbstractAgent>().toExtend<Agent>();
  });

  it("accepts a class from another copy that has its own private members", () => {
    expectTypeOf<ForeignAgent>().toExtend<Agent>();
  });

  it("accepts AbstractAgent and HttpAgent from this copy", () => {
    expectTypeOf<AbstractAgent>().toExtend<Agent>();
    expectTypeOf<HttpAgent>().toExtend<Agent>();
  });

  it("is needed because AbstractAgent does not accept a 1.0.0 agent", () => {
    // @ts-expect-error -- the 1.0.0 class has its own private members and lacks members added later
    expectTypeOf<V1.HttpAgent>().toExtend<AbstractAgent>();
  });

  it("sees the private members of the 1.0.0 fixture", () => {
    // Same public members, so only the private `config` member can make the next line fail.
    expectTypeOf<V1.DebugLogger>().toExtend<Pick<DebugLogger, keyof DebugLogger>>();
    // @ts-expect-error -- each DebugLogger declares its own private `config`
    expectTypeOf<V1.DebugLogger>().toExtend<DebugLogger>();
  });

  it("returns an Agent from clone()", () => {
    expectTypeOf<ReturnType<Agent["clone"]>>().toEqualTypeOf<Agent>();
  });
});

describe("AgentSubscriber without a type argument", () => {
  it("passes params.agent to code that needs AbstractAgent", async () => {
    const seenThreadIds: string[] = [];
    const subscriber: AgentSubscriber = {
      onRunInitialized({ agent }) {
        seenThreadIds.push(readThreadId(agent));
      },
    };

    await new ScriptedAgent([runStarted, runFinished]).runAgent({}, subscriber);

    expect(seenThreadIds).toEqual([THREAD_ID]);
  });
});
