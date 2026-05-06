import { describe, it, expectTypeOf } from "vitest";
import type {
  ToolCall as ToolCallStatic,
  FunctionCall as FunctionCallStatic,
  Message as MessageStatic,
  AssistantMessage as AssistantMessageStatic,
  UserMessage as UserMessageStatic,
  ToolMessage as ToolMessageStatic,
  ActivityMessage as ActivityMessageStatic,
  ReasoningMessage as ReasoningMessageStatic,
  DeveloperMessage as DeveloperMessageStatic,
  SystemMessage as SystemMessageStatic,
  Tool as ToolStatic,
  Context as ContextStatic,
  Interrupt as InterruptStatic,
  ResumeEntry as ResumeEntryStatic,
  RunAgentInput as RunAgentInputStatic,
  Role as RoleStatic,
  InputContent as InputContentStatic,
  BinaryInputContent as BinaryInputContentStatic,
} from "../types-static";
import type {
  ToolCall,
  FunctionCall,
  Message,
  AssistantMessage,
  UserMessage,
  ToolMessage,
  ActivityMessage,
  ReasoningMessage,
  DeveloperMessage,
  SystemMessage,
  Tool,
  Context,
  Interrupt,
  ResumeEntry,
  RunAgentInput,
  Role,
  InputContent,
  BinaryInputContent,
} from "../types";

describe("static types match z.infer types", () => {
  it("ToolCall", () => {
    expectTypeOf<ToolCallStatic>().toEqualTypeOf<ToolCall>();
  });
  it("FunctionCall", () => {
    expectTypeOf<FunctionCallStatic>().toEqualTypeOf<FunctionCall>();
  });
  it("Message", () => {
    expectTypeOf<MessageStatic>().toEqualTypeOf<Message>();
  });
  it("AssistantMessage", () => {
    expectTypeOf<AssistantMessageStatic>().toEqualTypeOf<AssistantMessage>();
  });
  it("UserMessage", () => {
    expectTypeOf<UserMessageStatic>().toEqualTypeOf<UserMessage>();
  });
  it("ToolMessage", () => {
    expectTypeOf<ToolMessageStatic>().toEqualTypeOf<ToolMessage>();
  });
  it("ActivityMessage", () => {
    expectTypeOf<ActivityMessageStatic>().toEqualTypeOf<ActivityMessage>();
  });
  it("ReasoningMessage", () => {
    expectTypeOf<ReasoningMessageStatic>().toEqualTypeOf<ReasoningMessage>();
  });
  it("DeveloperMessage", () => {
    expectTypeOf<DeveloperMessageStatic>().toEqualTypeOf<DeveloperMessage>();
  });
  it("SystemMessage", () => {
    expectTypeOf<SystemMessageStatic>().toEqualTypeOf<SystemMessage>();
  });
  it("Tool", () => {
    expectTypeOf<ToolStatic>().toEqualTypeOf<Tool>();
  });
  it("Context", () => {
    expectTypeOf<ContextStatic>().toEqualTypeOf<Context>();
  });
  it("Interrupt", () => {
    expectTypeOf<InterruptStatic>().toEqualTypeOf<Interrupt>();
  });
  it("ResumeEntry", () => {
    expectTypeOf<ResumeEntryStatic>().toEqualTypeOf<ResumeEntry>();
  });
  it("RunAgentInput", () => {
    expectTypeOf<RunAgentInputStatic>().toEqualTypeOf<RunAgentInput>();
  });
  it("Role", () => {
    expectTypeOf<RoleStatic>().toEqualTypeOf<Role>();
  });
  it("InputContent", () => {
    expectTypeOf<InputContentStatic>().toEqualTypeOf<InputContent>();
  });
  it("BinaryInputContent", () => {
    expectTypeOf<BinaryInputContentStatic>().toEqualTypeOf<BinaryInputContent>();
  });
});

import type {
  BaseEvent as BaseEventStatic,
  AGUIEvent as AGUIEventStatic,
  TextMessageStartEvent as TextMessageStartEventStatic,
  TextMessageContentEvent as TextMessageContentEventStatic,
  TextMessageEndEvent as TextMessageEndEventStatic,
  TextMessageChunkEvent as TextMessageChunkEventStatic,
  ToolCallStartEvent as ToolCallStartEventStatic,
  ToolCallArgsEvent as ToolCallArgsEventStatic,
  ToolCallEndEvent as ToolCallEndEventStatic,
  ToolCallChunkEvent as ToolCallChunkEventStatic,
  ToolCallResultEvent as ToolCallResultEventStatic,
  StateSnapshotEvent as StateSnapshotEventStatic,
  StateDeltaEvent as StateDeltaEventStatic,
  MessagesSnapshotEvent as MessagesSnapshotEventStatic,
  ActivitySnapshotEvent as ActivitySnapshotEventStatic,
  ActivityDeltaEvent as ActivityDeltaEventStatic,
  RawEvent as RawEventStatic,
  CustomEvent as CustomEventStatic,
  RunStartedEvent as RunStartedEventStatic,
  RunFinishedEvent as RunFinishedEventStatic,
  RunFinishedOutcome as RunFinishedOutcomeStatic,
  RunFinishedSuccessOutcome as RunFinishedSuccessOutcomeStatic,
  RunFinishedInterruptOutcome as RunFinishedInterruptOutcomeStatic,
  RunErrorEvent as RunErrorEventStatic,
  StepStartedEvent as StepStartedEventStatic,
  StepFinishedEvent as StepFinishedEventStatic,
  ReasoningStartEvent as ReasoningStartEventStatic,
  ReasoningMessageStartEvent as ReasoningMessageStartEventStatic,
  ReasoningMessageContentEvent as ReasoningMessageContentEventStatic,
  ReasoningMessageEndEvent as ReasoningMessageEndEventStatic,
  ReasoningMessageChunkEvent as ReasoningMessageChunkEventStatic,
  ReasoningEndEvent as ReasoningEndEventStatic,
  ReasoningEncryptedValueEvent as ReasoningEncryptedValueEventStatic,
  ThinkingStartEvent as ThinkingStartEventStatic,
  ThinkingEndEvent as ThinkingEndEventStatic,
  ThinkingTextMessageStartEvent as ThinkingTextMessageStartEventStatic,
  ThinkingTextMessageContentEvent as ThinkingTextMessageContentEventStatic,
  ThinkingTextMessageEndEvent as ThinkingTextMessageEndEventStatic,
} from "../events-static";
import type {
  BaseEvent,
  AGUIEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageChunkEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallChunkEvent,
  ToolCallResultEvent,
  StateSnapshotEvent,
  StateDeltaEvent,
  MessagesSnapshotEvent,
  ActivitySnapshotEvent,
  ActivityDeltaEvent,
  RawEvent,
  CustomEvent,
  RunStartedEvent,
  RunFinishedEvent,
  RunFinishedOutcome,
  RunFinishedSuccessOutcome,
  RunFinishedInterruptOutcome,
  RunErrorEvent,
  StepStartedEvent,
  StepFinishedEvent,
  ReasoningStartEvent,
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningMessageChunkEvent,
  ReasoningEndEvent,
  ReasoningEncryptedValueEvent,
  ThinkingStartEvent,
  ThinkingEndEvent,
  ThinkingTextMessageStartEvent,
  ThinkingTextMessageContentEvent,
  ThinkingTextMessageEndEvent,
} from "../events";

describe("static event types match z.infer event types", () => {
  it("BaseEvent", () => { expectTypeOf<BaseEventStatic>().toEqualTypeOf<BaseEvent>(); });
  it("AGUIEvent", () => { expectTypeOf<AGUIEventStatic>().toEqualTypeOf<AGUIEvent>(); });
  it("TextMessageStartEvent", () => { expectTypeOf<TextMessageStartEventStatic>().toEqualTypeOf<TextMessageStartEvent>(); });
  it("TextMessageContentEvent", () => { expectTypeOf<TextMessageContentEventStatic>().toEqualTypeOf<TextMessageContentEvent>(); });
  it("TextMessageEndEvent", () => { expectTypeOf<TextMessageEndEventStatic>().toEqualTypeOf<TextMessageEndEvent>(); });
  it("TextMessageChunkEvent", () => { expectTypeOf<TextMessageChunkEventStatic>().toEqualTypeOf<TextMessageChunkEvent>(); });
  it("ToolCallStartEvent", () => { expectTypeOf<ToolCallStartEventStatic>().toEqualTypeOf<ToolCallStartEvent>(); });
  it("ToolCallArgsEvent", () => { expectTypeOf<ToolCallArgsEventStatic>().toEqualTypeOf<ToolCallArgsEvent>(); });
  it("ToolCallEndEvent", () => { expectTypeOf<ToolCallEndEventStatic>().toEqualTypeOf<ToolCallEndEvent>(); });
  it("ToolCallChunkEvent", () => { expectTypeOf<ToolCallChunkEventStatic>().toEqualTypeOf<ToolCallChunkEvent>(); });
  it("ToolCallResultEvent", () => { expectTypeOf<ToolCallResultEventStatic>().toEqualTypeOf<ToolCallResultEvent>(); });
  it("StateSnapshotEvent", () => { expectTypeOf<StateSnapshotEventStatic>().toEqualTypeOf<StateSnapshotEvent>(); });
  it("StateDeltaEvent", () => { expectTypeOf<StateDeltaEventStatic>().toEqualTypeOf<StateDeltaEvent>(); });
  it("MessagesSnapshotEvent", () => { expectTypeOf<MessagesSnapshotEventStatic>().toEqualTypeOf<MessagesSnapshotEvent>(); });
  it("ActivitySnapshotEvent", () => { expectTypeOf<ActivitySnapshotEventStatic>().toEqualTypeOf<ActivitySnapshotEvent>(); });
  it("ActivityDeltaEvent", () => { expectTypeOf<ActivityDeltaEventStatic>().toEqualTypeOf<ActivityDeltaEvent>(); });
  it("RawEvent", () => { expectTypeOf<RawEventStatic>().toEqualTypeOf<RawEvent>(); });
  it("CustomEvent", () => { expectTypeOf<CustomEventStatic>().toEqualTypeOf<CustomEvent>(); });
  it("RunStartedEvent", () => { expectTypeOf<RunStartedEventStatic>().toEqualTypeOf<RunStartedEvent>(); });
  it("RunFinishedEvent", () => { expectTypeOf<RunFinishedEventStatic>().toEqualTypeOf<RunFinishedEvent>(); });
  it("RunFinishedOutcome", () => { expectTypeOf<RunFinishedOutcomeStatic>().toEqualTypeOf<RunFinishedOutcome>(); });
  it("RunFinishedSuccessOutcome", () => { expectTypeOf<RunFinishedSuccessOutcomeStatic>().toEqualTypeOf<RunFinishedSuccessOutcome>(); });
  it("RunFinishedInterruptOutcome", () => { expectTypeOf<RunFinishedInterruptOutcomeStatic>().toEqualTypeOf<RunFinishedInterruptOutcome>(); });
  it("RunErrorEvent", () => { expectTypeOf<RunErrorEventStatic>().toEqualTypeOf<RunErrorEvent>(); });
  it("StepStartedEvent", () => { expectTypeOf<StepStartedEventStatic>().toEqualTypeOf<StepStartedEvent>(); });
  it("StepFinishedEvent", () => { expectTypeOf<StepFinishedEventStatic>().toEqualTypeOf<StepFinishedEvent>(); });
  it("ReasoningStartEvent", () => { expectTypeOf<ReasoningStartEventStatic>().toEqualTypeOf<ReasoningStartEvent>(); });
  it("ReasoningMessageStartEvent", () => { expectTypeOf<ReasoningMessageStartEventStatic>().toEqualTypeOf<ReasoningMessageStartEvent>(); });
  it("ReasoningMessageContentEvent", () => { expectTypeOf<ReasoningMessageContentEventStatic>().toEqualTypeOf<ReasoningMessageContentEvent>(); });
  it("ReasoningMessageEndEvent", () => { expectTypeOf<ReasoningMessageEndEventStatic>().toEqualTypeOf<ReasoningMessageEndEvent>(); });
  it("ReasoningMessageChunkEvent", () => { expectTypeOf<ReasoningMessageChunkEventStatic>().toEqualTypeOf<ReasoningMessageChunkEvent>(); });
  it("ReasoningEndEvent", () => { expectTypeOf<ReasoningEndEventStatic>().toEqualTypeOf<ReasoningEndEvent>(); });
  it("ReasoningEncryptedValueEvent", () => { expectTypeOf<ReasoningEncryptedValueEventStatic>().toEqualTypeOf<ReasoningEncryptedValueEvent>(); });
  it("ThinkingStartEvent", () => { expectTypeOf<ThinkingStartEventStatic>().toEqualTypeOf<ThinkingStartEvent>(); });
  it("ThinkingEndEvent", () => { expectTypeOf<ThinkingEndEventStatic>().toEqualTypeOf<ThinkingEndEvent>(); });
  it("ThinkingTextMessageStartEvent", () => { expectTypeOf<ThinkingTextMessageStartEventStatic>().toEqualTypeOf<ThinkingTextMessageStartEvent>(); });
  it("ThinkingTextMessageContentEvent", () => { expectTypeOf<ThinkingTextMessageContentEventStatic>().toEqualTypeOf<ThinkingTextMessageContentEvent>(); });
  it("ThinkingTextMessageEndEvent", () => { expectTypeOf<ThinkingTextMessageEndEventStatic>().toEqualTypeOf<ThinkingTextMessageEndEvent>(); });
});

import type {
  SubAgentInfo as SubAgentInfoStatic,
  IdentityCapabilities as IdentityCapabilitiesStatic,
  TransportCapabilities as TransportCapabilitiesStatic,
  ToolsCapabilities as ToolsCapabilitiesStatic,
  OutputCapabilities as OutputCapabilitiesStatic,
  StateCapabilities as StateCapabilitiesStatic,
  MultiAgentCapabilities as MultiAgentCapabilitiesStatic,
  ReasoningCapabilities as ReasoningCapabilitiesStatic,
  MultimodalInputCapabilities as MultimodalInputCapabilitiesStatic,
  MultimodalOutputCapabilities as MultimodalOutputCapabilitiesStatic,
  MultimodalCapabilities as MultimodalCapabilitiesStatic,
  ExecutionCapabilities as ExecutionCapabilitiesStatic,
  HumanInTheLoopCapabilities as HumanInTheLoopCapabilitiesStatic,
  AgentCapabilities as AgentCapabilitiesStatic,
} from "../capabilities-static";
import type {
  SubAgentInfo,
  IdentityCapabilities,
  TransportCapabilities,
  ToolsCapabilities,
  OutputCapabilities,
  StateCapabilities,
  MultiAgentCapabilities,
  ReasoningCapabilities,
  MultimodalInputCapabilities,
  MultimodalOutputCapabilities,
  MultimodalCapabilities,
  ExecutionCapabilities,
  HumanInTheLoopCapabilities,
  AgentCapabilities,
} from "../capabilities";

describe("static capability types match z.infer capability types", () => {
  it("SubAgentInfo", () => { expectTypeOf<SubAgentInfoStatic>().toEqualTypeOf<SubAgentInfo>(); });
  it("IdentityCapabilities", () => { expectTypeOf<IdentityCapabilitiesStatic>().toEqualTypeOf<IdentityCapabilities>(); });
  it("TransportCapabilities", () => { expectTypeOf<TransportCapabilitiesStatic>().toEqualTypeOf<TransportCapabilities>(); });
  it("ToolsCapabilities", () => { expectTypeOf<ToolsCapabilitiesStatic>().toEqualTypeOf<ToolsCapabilities>(); });
  it("OutputCapabilities", () => { expectTypeOf<OutputCapabilitiesStatic>().toEqualTypeOf<OutputCapabilities>(); });
  it("StateCapabilities", () => { expectTypeOf<StateCapabilitiesStatic>().toEqualTypeOf<StateCapabilities>(); });
  it("MultiAgentCapabilities", () => { expectTypeOf<MultiAgentCapabilitiesStatic>().toEqualTypeOf<MultiAgentCapabilities>(); });
  it("ReasoningCapabilities", () => { expectTypeOf<ReasoningCapabilitiesStatic>().toEqualTypeOf<ReasoningCapabilities>(); });
  it("MultimodalInputCapabilities", () => { expectTypeOf<MultimodalInputCapabilitiesStatic>().toEqualTypeOf<MultimodalInputCapabilities>(); });
  it("MultimodalOutputCapabilities", () => { expectTypeOf<MultimodalOutputCapabilitiesStatic>().toEqualTypeOf<MultimodalOutputCapabilities>(); });
  it("MultimodalCapabilities", () => { expectTypeOf<MultimodalCapabilitiesStatic>().toEqualTypeOf<MultimodalCapabilities>(); });
  it("ExecutionCapabilities", () => { expectTypeOf<ExecutionCapabilitiesStatic>().toEqualTypeOf<ExecutionCapabilities>(); });
  it("HumanInTheLoopCapabilities", () => { expectTypeOf<HumanInTheLoopCapabilitiesStatic>().toEqualTypeOf<HumanInTheLoopCapabilities>(); });
  it("AgentCapabilities", () => { expectTypeOf<AgentCapabilitiesStatic>().toEqualTypeOf<AgentCapabilities>(); });
});
