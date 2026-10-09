/**
 * Declarations copied from the published `@ag-ui/client@1.0.0` package,
 * file `dist/index.d.ts`. Trimmed to `AbstractAgent`, `HttpAgent`,
 * `AgentSubscriber`, `AgentSubscriberParams`, and the types they reference.
 * Doc comments are removed. The declarations that are kept are unchanged,
 * except one union that is written out (see `RuntimeMetaEventName`).
 *
 * Why this file exists: an app can get agents from a second copy of
 * `@ag-ui/client` (another version, or a duplicate install). The classes of
 * that copy have their own `private` and `protected` members, so TypeScript
 * does not match them to the classes of this copy. `agent-compat.test.ts`
 * uses these declarations to prove that such an agent still fits `Agent`.
 *
 * Keep every `private` and `protected` member. They are the reason the two
 * copies do not match.
 */
import type {
  AgentCapabilities,
  BaseEvent,
  CustomEvent,
  Interrupt,
  Message,
  MessagesSnapshotEvent,
  RawEvent,
  ActivityDeltaEvent,
  ActivityMessage,
  ActivitySnapshotEvent,
  ReasoningEncryptedValueEvent,
  ReasoningEndEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningMessageStartEvent,
  ReasoningStartEvent,
  ResumeEntry,
  RunAgentInput,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  State,
  StateDeltaEvent,
  StateSnapshotEvent,
  StepFinishedEvent,
  StepStartedEvent,
  SubagentErrorEvent,
  SubagentFinishedEvent,
  SubagentStartedEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCall,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/core";
import type { Observable } from "rxjs";

//#region src/agent/types.d.ts
interface ResolvedAgentDebugConfig {
  enabled: boolean;
  events: boolean;
  lifecycle: boolean;
  verbose: boolean;
}
type AgentDebugConfig =
  | boolean
  | {
      events?: boolean;
      lifecycle?: boolean;
      verbose?: boolean;
    };
interface AgentConfig {
  agentId?: string;
  description?: string;
  threadId?: string;
  initialMessages?: Message[];
  initialState?: State;
  debug?: AgentDebugConfig;
}
type HttpAgentFetchFn = (url: string, requestInit: RequestInit) => Promise<Response>;
interface HttpAgentConfig extends AgentConfig {
  url: string;
  headers?: Record<string, string>;
  fetch?: HttpAgentFetchFn;
}
interface RunAgentParameters
  extends Partial<Pick<RunAgentInput, "runId" | "tools" | "context" | "forwardedProps">> {
  resume?: ResumeEntry[];
}
//#endregion

//#region src/debug-logger.d.ts
declare class DebugLogger {
  private config;
  constructor(config: ResolvedAgentDebugConfig);
  event(prefix: string, label: string, data: unknown, summary?: Record<string, unknown>): void;
  lifecycle(prefix: string, label: string, data?: Record<string, unknown>): void;
  get eventsEnabled(): boolean;
  get lifecycleEnabled(): boolean;
  get enabled(): boolean;
}
//#endregion

//#region src/legacy/types.d.ts
// 1.0.0 derives this union from a `LegacyRuntimeMetaEventName` const. The
// union is written out here, so the fixture has no unused const.
type RuntimeMetaEventName = "LangGraphInterruptEvent" | "PredictState" | "Exit";
interface LegacyTextMessageStart {
  type: "TextMessageStart";
  messageId: string;
  parentMessageId?: string;
  role?: string;
}
interface LegacyTextMessageContent {
  type: "TextMessageContent";
  messageId: string;
  content: string;
}
interface LegacyTextMessageEnd {
  type: "TextMessageEnd";
  messageId: string;
}
interface LegacyActionExecutionStart {
  type: "ActionExecutionStart";
  actionExecutionId: string;
  actionName: string;
  parentMessageId?: string;
}
interface LegacyActionExecutionArgs {
  type: "ActionExecutionArgs";
  actionExecutionId: string;
  args: string;
}
interface LegacyActionExecutionEnd {
  type: "ActionExecutionEnd";
  actionExecutionId: string;
}
interface LegacyActionExecutionResult {
  type: "ActionExecutionResult";
  actionName: string;
  actionExecutionId: string;
  result: string;
}
interface LegacyAgentStateMessage {
  type: "AgentStateMessage";
  threadId: string;
  agentName: string;
  nodeName: string;
  runId: string;
  active: boolean;
  role: string;
  state: string;
  running: boolean;
}
interface LegacyMetaEvent {
  type: "MetaEvent";
  name: RuntimeMetaEventName;
  value?: any;
}
interface LegacyRunError {
  type: "RunError";
  message: string;
  code?: string;
}
type LegacyRuntimeProtocolEvent =
  | LegacyTextMessageStart
  | LegacyTextMessageContent
  | LegacyTextMessageEnd
  | LegacyActionExecutionStart
  | LegacyActionExecutionArgs
  | LegacyActionExecutionEnd
  | LegacyActionExecutionResult
  | LegacyAgentStateMessage
  | LegacyMetaEvent
  | LegacyRunError;
//#endregion

//#region src/agent/subscriber.d.ts
interface AgentStateMutation {
  messages?: Message[];
  state?: State;
  stopPropagation?: boolean;
}
interface AgentSubscriberParams {
  messages: ReadonlyArray<Readonly<Message>>;
  state: Readonly<State>;
  agent: AbstractAgent;
  input: RunAgentInput;
}
type MaybePromise<T> = T | Promise<T>;
interface AgentSubscriber {
  onRunInitialized?(
    params: AgentSubscriberParams,
  ): MaybePromise<Omit<AgentStateMutation, "stopPropagation"> | void>;
  onRunFailed?(
    params: {
      error: Error;
    } & AgentSubscriberParams,
  ): MaybePromise<Omit<AgentStateMutation, "stopPropagation"> | void>;
  onRunFinalized?(
    params: AgentSubscriberParams,
  ): MaybePromise<Omit<AgentStateMutation, "stopPropagation"> | void>;
  onEvent?(
    params: {
      event: BaseEvent;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onRunStartedEvent?(
    params: {
      event: RunStartedEvent;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onRunFinishedEvent?(
    params: (
      | {
          event: RunFinishedEvent;
          outcome: "success";
          result?: unknown;
          pendingToolCallIds: string[];
        }
      | {
          event: RunFinishedEvent;
          outcome: "interrupt";
          interrupts: Interrupt[];
        }
      | {
          event: RunFinishedEvent;
          outcome: "cancelled";
        }
    ) &
      AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onRunErrorEvent?(
    params: {
      event: RunErrorEvent;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onStepStartedEvent?(
    params: {
      event: StepStartedEvent;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onStepFinishedEvent?(
    params: {
      event: StepFinishedEvent;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onSubagentStartedEvent?(
    params: {
      event: SubagentStartedEvent;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onSubagentFinishedEvent?(
    params: {
      event: SubagentFinishedEvent;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onSubagentErrorEvent?(
    params: {
      event: SubagentErrorEvent;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onTextMessageStartEvent?(
    params: {
      event: TextMessageStartEvent;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onTextMessageContentEvent?(
    params: {
      event: TextMessageContentEvent;
      textMessageBuffer: string;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onTextMessageEndEvent?(
    params: {
      event: TextMessageEndEvent;
      textMessageBuffer: string;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onToolCallStartEvent?(
    params: {
      event: ToolCallStartEvent;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onToolCallArgsEvent?(
    params: {
      event: ToolCallArgsEvent;
      toolCallBuffer: string;
      toolCallName: string;
      partialToolCallArgs: Record<string, any>;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onToolCallEndEvent?(
    params: {
      event: ToolCallEndEvent;
      toolCallName: string;
      toolCallArgs: Record<string, any>;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onToolCallResultEvent?(
    params: {
      event: ToolCallResultEvent;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onStateSnapshotEvent?(
    params: {
      event: StateSnapshotEvent;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onStateDeltaEvent?(
    params: {
      event: StateDeltaEvent;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onMessagesSnapshotEvent?(
    params: {
      event: MessagesSnapshotEvent;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onActivitySnapshotEvent?(
    params: {
      event: ActivitySnapshotEvent;
      activityMessage?: ActivityMessage;
      existingMessage?: Message;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onActivityDeltaEvent?(
    params: {
      event: ActivityDeltaEvent;
      activityMessage?: ActivityMessage;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onRawEvent?(
    params: {
      event: RawEvent;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onCustomEvent?(
    params: {
      event: CustomEvent;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onReasoningStartEvent?(
    params: {
      event: ReasoningStartEvent;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onReasoningMessageStartEvent?(
    params: {
      event: ReasoningMessageStartEvent;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onReasoningMessageContentEvent?(
    params: {
      event: ReasoningMessageContentEvent;
      reasoningMessageBuffer: string;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onReasoningMessageEndEvent?(
    params: {
      event: ReasoningMessageEndEvent;
      reasoningMessageBuffer: string;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onReasoningEndEvent?(
    params: {
      event: ReasoningEndEvent;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onReasoningEncryptedValueEvent?(
    params: {
      event: ReasoningEncryptedValueEvent;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onMessagesChanged?(
    params: Omit<AgentSubscriberParams, "input"> & {
      input?: RunAgentInput;
    },
  ): MaybePromise<void>;
  onStateChanged?(
    params: Omit<AgentSubscriberParams, "input"> & {
      input?: RunAgentInput;
    },
  ): MaybePromise<void>;
  onNewMessage?(
    params: {
      message: Message;
    } & Omit<AgentSubscriberParams, "input"> & {
        input?: RunAgentInput;
      },
  ): MaybePromise<void>;
  onNewToolCall?(
    params: {
      toolCall: ToolCall;
    } & Omit<AgentSubscriberParams, "input"> & {
        input?: RunAgentInput;
      },
  ): MaybePromise<void>;
}
//#endregion

//#region src/agent/http.d.ts
interface RunHttpAgentConfig extends RunAgentParameters {
  abortController?: AbortController;
}
declare class HttpAgent extends AbstractAgent {
  url: string;
  headers: Record<string, string>;
  fetch: HttpAgentFetchFn;
  abortController: AbortController;
  protected requestInit(input: RunAgentInput): RequestInit;
  runAgent(parameters?: RunHttpAgentConfig, subscriber?: AgentSubscriber): Promise<RunAgentResult>;
  abortRun(): void;
  constructor(config: HttpAgentConfig);
  run(input: RunAgentInput): Observable<BaseEvent>;
  clone(): HttpAgent;
}
//#endregion

//#region src/middleware/middleware.d.ts
type MiddlewareFunction = (input: RunAgentInput, next: AbstractAgent) => Observable<BaseEvent>;
interface EventWithState {
  event: BaseEvent;
  messages: Message[];
  state: any;
}
declare abstract class Middleware {
  abstract run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent>;
  protected runNext(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent>;
  protected runNextWithState(input: RunAgentInput, next: AbstractAgent): Observable<EventWithState>;
}
//#endregion

//#region src/agent/agent.d.ts
interface RunAgentResult {
  result: any;
  newMessages: Message[];
}
declare abstract class AbstractAgent {
  agentId?: string;
  description: string;
  threadId: string;
  messages: Message[];
  state: State;
  private _debug;
  private _debugLogger;
  subscribers: AgentSubscriber[];
  isRunning: boolean;
  pendingInterrupts: Interrupt[];
  private middlewares;
  private activeRunDetach$?;
  private activeRunCompletionPromise?;
  private resolvingPeerCeiling;
  private resolvePeerCeiling;
  get maxProtocolVersion(): string;
  get maxVersion(): string;
  get debug(): ResolvedAgentDebugConfig;
  set debug(value: AgentDebugConfig | ResolvedAgentDebugConfig);
  get debugLogger(): DebugLogger | undefined;
  set debugLogger(value: DebugLogger | boolean | undefined);
  private resolvedCeilingDuringConstruction;
  constructor({
    agentId,
    description,
    threadId,
    initialMessages,
    initialState,
    debug,
  }?: AgentConfig);
  subscribe(subscriber: AgentSubscriber): {
    unsubscribe: () => void;
  };
  abstract run(input: RunAgentInput): Observable<BaseEvent>;
  getCapabilities?(): Promise<AgentCapabilities>;
  use(...middlewares: (Middleware | MiddlewareFunction)[]): this;
  runAgent(parameters?: RunAgentParameters, subscriber?: AgentSubscriber): Promise<RunAgentResult>;
  protected connect(input: RunAgentInput): Observable<BaseEvent>;
  connectAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult>;
  abortRun(): void;
  detachActiveRun(): Promise<void>;
  protected apply(
    input: RunAgentInput,
    events$: Observable<BaseEvent>,
    subscribers: AgentSubscriber[],
  ): Observable<AgentStateMutation>;
  protected processApplyEvents(
    input: RunAgentInput,
    events$: Observable<AgentStateMutation>,
    subscribers: AgentSubscriber[],
  ): Observable<AgentStateMutation>;
  protected prepareRunAgentInput(parameters?: RunAgentParameters): RunAgentInput;
  protected onInitialize(input: RunAgentInput, subscribers: AgentSubscriber[]): Promise<void>;
  protected onError(
    input: RunAgentInput,
    error: Error,
    subscribers: AgentSubscriber[],
  ): Observable<AgentStateMutation>;
  protected onFinalize(input: RunAgentInput, subscribers: AgentSubscriber[]): Promise<void>;
  clone(): any;
  addMessage(message: Message): void;
  addMessages(messages: Message[]): void;
  setMessages(messages: Message[]): void;
  setState(state: State): void;
  legacy_to_be_removed_runAgentBridged(
    config?: RunAgentParameters,
  ): Observable<LegacyRuntimeProtocolEvent>;
}
//#endregion

export {
  AbstractAgent,
  AgentSubscriber,
  AgentSubscriberParams,
  DebugLogger,
  HttpAgent,
  Middleware,
  type MiddlewareFunction,
};
