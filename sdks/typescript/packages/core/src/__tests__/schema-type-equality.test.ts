/**
 * Drift-prevention tests: assert that z.infer<typeof XxxSchema> (from
 * @ag-ui/core/schemas) exactly matches the hand-written types (from the
 * main @ag-ui/core entry). Any divergence between a schema and its
 * corresponding type will surface here as a compile error.
 */
import { describe, it, expectTypeOf } from "vitest";
import { z } from "zod";

// --------------------------------------------------------------------------
// Schema imports (from the schemas subpath module)
// --------------------------------------------------------------------------
import type {
  ToolCallSchema,
  FunctionCallSchema,
  MessageSchema,
  AssistantMessageSchema,
  UserMessageSchema,
  ToolMessageSchema,
  ActivityMessageSchema,
  ReasoningMessageSchema,
  DeveloperMessageSchema,
  SystemMessageSchema,
  ToolSchema,
  ContextSchema,
  InterruptSchema,
  ResumeEntrySchema,
  RunAgentInputSchema,
  RoleSchema,
  InputContentSchema,
  BinaryInputContentSchema,
} from "../schemas";

// --------------------------------------------------------------------------
// Type imports (from the canonical type modules)
// --------------------------------------------------------------------------
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

describe("schema inferred types match hand-written types (types.ts)", () => {
  it("ToolCall", () => {
    expectTypeOf<z.infer<typeof ToolCallSchema>>().toEqualTypeOf<ToolCall>();
  });
  it("FunctionCall", () => {
    expectTypeOf<z.infer<typeof FunctionCallSchema>>().toEqualTypeOf<FunctionCall>();
  });
  it("Message", () => {
    expectTypeOf<z.infer<typeof MessageSchema>>().toEqualTypeOf<Message>();
  });
  it("AssistantMessage", () => {
    expectTypeOf<z.infer<typeof AssistantMessageSchema>>().toEqualTypeOf<AssistantMessage>();
  });
  it("UserMessage", () => {
    expectTypeOf<z.infer<typeof UserMessageSchema>>().toEqualTypeOf<UserMessage>();
  });
  it("ToolMessage", () => {
    expectTypeOf<z.infer<typeof ToolMessageSchema>>().toEqualTypeOf<ToolMessage>();
  });
  it("ActivityMessage", () => {
    expectTypeOf<z.infer<typeof ActivityMessageSchema>>().toEqualTypeOf<ActivityMessage>();
  });
  it("ReasoningMessage", () => {
    expectTypeOf<z.infer<typeof ReasoningMessageSchema>>().toEqualTypeOf<ReasoningMessage>();
  });
  it("DeveloperMessage", () => {
    expectTypeOf<z.infer<typeof DeveloperMessageSchema>>().toEqualTypeOf<DeveloperMessage>();
  });
  it("SystemMessage", () => {
    expectTypeOf<z.infer<typeof SystemMessageSchema>>().toEqualTypeOf<SystemMessage>();
  });
  it("Tool", () => {
    expectTypeOf<z.infer<typeof ToolSchema>>().toEqualTypeOf<Tool>();
  });
  it("Context", () => {
    expectTypeOf<z.infer<typeof ContextSchema>>().toEqualTypeOf<Context>();
  });
  it("Interrupt", () => {
    expectTypeOf<z.infer<typeof InterruptSchema>>().toEqualTypeOf<Interrupt>();
  });
  it("ResumeEntry", () => {
    expectTypeOf<z.infer<typeof ResumeEntrySchema>>().toEqualTypeOf<ResumeEntry>();
  });
  it("RunAgentInput", () => {
    expectTypeOf<z.infer<typeof RunAgentInputSchema>>().toEqualTypeOf<RunAgentInput>();
  });
  it("Role", () => {
    expectTypeOf<z.infer<typeof RoleSchema>>().toEqualTypeOf<Role>();
  });
  it("InputContent", () => {
    expectTypeOf<z.infer<typeof InputContentSchema>>().toEqualTypeOf<InputContent>();
  });
  it("BinaryInputContent", () => {
    expectTypeOf<z.infer<typeof BinaryInputContentSchema>>().toEqualTypeOf<BinaryInputContent>();
  });
});

// --------------------------------------------------------------------------
// Event schema imports
// --------------------------------------------------------------------------
import type {
  BaseEventSchema,
  TextMessageStartEventSchema,
  TextMessageContentEventSchema,
  TextMessageEndEventSchema,
  TextMessageChunkEventSchema,
  ToolCallStartEventSchema,
  ToolCallArgsEventSchema,
  ToolCallEndEventSchema,
  ToolCallChunkEventSchema,
  ToolCallResultEventSchema,
  StateSnapshotEventSchema,
  StateDeltaEventSchema,
  MessagesSnapshotEventSchema,
  ActivitySnapshotEventSchema,
  ActivityDeltaEventSchema,
  RawEventSchema,
  CustomEventSchema,
  RunStartedEventSchema,
  RunFinishedEventSchema,
  RunFinishedOutcomeSchema,
  RunFinishedSuccessOutcomeSchema,
  RunFinishedInterruptOutcomeSchema,
  RunErrorEventSchema,
  StepStartedEventSchema,
  StepFinishedEventSchema,
  ReasoningStartEventSchema,
  ReasoningMessageStartEventSchema,
  ReasoningMessageContentEventSchema,
  ReasoningMessageEndEventSchema,
  ReasoningMessageChunkEventSchema,
  ReasoningEndEventSchema,
  ReasoningEncryptedValueEventSchema,
  ThinkingStartEventSchema,
  ThinkingEndEventSchema,
  ThinkingTextMessageStartEventSchema,
  ThinkingTextMessageContentEventSchema,
  ThinkingTextMessageEndEventSchema,
} from "../schemas";

// --------------------------------------------------------------------------
// Event type imports
// --------------------------------------------------------------------------
import type {
  BaseEvent,
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

describe("schema inferred types match hand-written types (events.ts)", () => {
  it("BaseEvent", () => {
    // BaseEventSchema uses .passthrough() so z.infer includes index signature;
    // we assert on the known fields only via structural subset check
    expectTypeOf<z.infer<typeof BaseEventSchema>>().toMatchTypeOf<BaseEvent>();
  });
  it("TextMessageStartEvent", () => {
    expectTypeOf<z.infer<typeof TextMessageStartEventSchema>>().toEqualTypeOf<TextMessageStartEvent>();
  });
  it("TextMessageContentEvent", () => {
    expectTypeOf<z.infer<typeof TextMessageContentEventSchema>>().toEqualTypeOf<TextMessageContentEvent>();
  });
  it("TextMessageEndEvent", () => {
    expectTypeOf<z.infer<typeof TextMessageEndEventSchema>>().toEqualTypeOf<TextMessageEndEvent>();
  });
  it("TextMessageChunkEvent", () => {
    expectTypeOf<z.infer<typeof TextMessageChunkEventSchema>>().toEqualTypeOf<TextMessageChunkEvent>();
  });
  it("ToolCallStartEvent", () => {
    expectTypeOf<z.infer<typeof ToolCallStartEventSchema>>().toEqualTypeOf<ToolCallStartEvent>();
  });
  it("ToolCallArgsEvent", () => {
    expectTypeOf<z.infer<typeof ToolCallArgsEventSchema>>().toEqualTypeOf<ToolCallArgsEvent>();
  });
  it("ToolCallEndEvent", () => {
    expectTypeOf<z.infer<typeof ToolCallEndEventSchema>>().toEqualTypeOf<ToolCallEndEvent>();
  });
  it("ToolCallChunkEvent", () => {
    expectTypeOf<z.infer<typeof ToolCallChunkEventSchema>>().toEqualTypeOf<ToolCallChunkEvent>();
  });
  it("ToolCallResultEvent", () => {
    expectTypeOf<z.infer<typeof ToolCallResultEventSchema>>().toEqualTypeOf<ToolCallResultEvent>();
  });
  it("StateSnapshotEvent", () => {
    expectTypeOf<z.infer<typeof StateSnapshotEventSchema>>().toEqualTypeOf<StateSnapshotEvent>();
  });
  it("StateDeltaEvent", () => {
    expectTypeOf<z.infer<typeof StateDeltaEventSchema>>().toEqualTypeOf<StateDeltaEvent>();
  });
  it("MessagesSnapshotEvent", () => {
    expectTypeOf<z.infer<typeof MessagesSnapshotEventSchema>>().toEqualTypeOf<MessagesSnapshotEvent>();
  });
  it("ActivitySnapshotEvent", () => {
    expectTypeOf<z.infer<typeof ActivitySnapshotEventSchema>>().toEqualTypeOf<ActivitySnapshotEvent>();
  });
  it("ActivityDeltaEvent", () => {
    expectTypeOf<z.infer<typeof ActivityDeltaEventSchema>>().toEqualTypeOf<ActivityDeltaEvent>();
  });
  it("RawEvent", () => {
    expectTypeOf<z.infer<typeof RawEventSchema>>().toEqualTypeOf<RawEvent>();
  });
  it("CustomEvent", () => {
    expectTypeOf<z.infer<typeof CustomEventSchema>>().toEqualTypeOf<CustomEvent>();
  });
  it("RunStartedEvent", () => {
    expectTypeOf<z.infer<typeof RunStartedEventSchema>>().toEqualTypeOf<RunStartedEvent>();
  });
  it("RunFinishedEvent", () => {
    expectTypeOf<z.infer<typeof RunFinishedEventSchema>>().toEqualTypeOf<RunFinishedEvent>();
  });
  it("RunFinishedOutcome", () => {
    expectTypeOf<z.infer<typeof RunFinishedOutcomeSchema>>().toEqualTypeOf<RunFinishedOutcome>();
  });
  it("RunFinishedSuccessOutcome", () => {
    expectTypeOf<z.infer<typeof RunFinishedSuccessOutcomeSchema>>().toEqualTypeOf<RunFinishedSuccessOutcome>();
  });
  it("RunFinishedInterruptOutcome", () => {
    expectTypeOf<z.infer<typeof RunFinishedInterruptOutcomeSchema>>().toEqualTypeOf<RunFinishedInterruptOutcome>();
  });
  it("RunErrorEvent", () => {
    expectTypeOf<z.infer<typeof RunErrorEventSchema>>().toEqualTypeOf<RunErrorEvent>();
  });
  it("StepStartedEvent", () => {
    expectTypeOf<z.infer<typeof StepStartedEventSchema>>().toEqualTypeOf<StepStartedEvent>();
  });
  it("StepFinishedEvent", () => {
    expectTypeOf<z.infer<typeof StepFinishedEventSchema>>().toEqualTypeOf<StepFinishedEvent>();
  });
  it("ReasoningStartEvent", () => {
    expectTypeOf<z.infer<typeof ReasoningStartEventSchema>>().toEqualTypeOf<ReasoningStartEvent>();
  });
  it("ReasoningMessageStartEvent", () => {
    expectTypeOf<z.infer<typeof ReasoningMessageStartEventSchema>>().toEqualTypeOf<ReasoningMessageStartEvent>();
  });
  it("ReasoningMessageContentEvent", () => {
    expectTypeOf<z.infer<typeof ReasoningMessageContentEventSchema>>().toEqualTypeOf<ReasoningMessageContentEvent>();
  });
  it("ReasoningMessageEndEvent", () => {
    expectTypeOf<z.infer<typeof ReasoningMessageEndEventSchema>>().toEqualTypeOf<ReasoningMessageEndEvent>();
  });
  it("ReasoningMessageChunkEvent", () => {
    expectTypeOf<z.infer<typeof ReasoningMessageChunkEventSchema>>().toEqualTypeOf<ReasoningMessageChunkEvent>();
  });
  it("ReasoningEndEvent", () => {
    expectTypeOf<z.infer<typeof ReasoningEndEventSchema>>().toEqualTypeOf<ReasoningEndEvent>();
  });
  it("ReasoningEncryptedValueEvent", () => {
    expectTypeOf<z.infer<typeof ReasoningEncryptedValueEventSchema>>().toEqualTypeOf<ReasoningEncryptedValueEvent>();
  });
  it("ThinkingStartEvent", () => {
    expectTypeOf<z.infer<typeof ThinkingStartEventSchema>>().toEqualTypeOf<ThinkingStartEvent>();
  });
  it("ThinkingEndEvent", () => {
    expectTypeOf<z.infer<typeof ThinkingEndEventSchema>>().toEqualTypeOf<ThinkingEndEvent>();
  });
  it("ThinkingTextMessageStartEvent", () => {
    expectTypeOf<z.infer<typeof ThinkingTextMessageStartEventSchema>>().toEqualTypeOf<ThinkingTextMessageStartEvent>();
  });
  it("ThinkingTextMessageContentEvent", () => {
    expectTypeOf<z.infer<typeof ThinkingTextMessageContentEventSchema>>().toEqualTypeOf<ThinkingTextMessageContentEvent>();
  });
  it("ThinkingTextMessageEndEvent", () => {
    expectTypeOf<z.infer<typeof ThinkingTextMessageEndEventSchema>>().toEqualTypeOf<ThinkingTextMessageEndEvent>();
  });
});

// --------------------------------------------------------------------------
// Capability schema imports
// --------------------------------------------------------------------------
import type {
  SubAgentInfoSchema,
  IdentityCapabilitiesSchema,
  TransportCapabilitiesSchema,
  ToolsCapabilitiesSchema,
  OutputCapabilitiesSchema,
  StateCapabilitiesSchema,
  MultiAgentCapabilitiesSchema,
  ReasoningCapabilitiesSchema,
  MultimodalInputCapabilitiesSchema,
  MultimodalOutputCapabilitiesSchema,
  MultimodalCapabilitiesSchema,
  ExecutionCapabilitiesSchema,
  HumanInTheLoopCapabilitiesSchema,
  AgentCapabilitiesSchema,
} from "../schemas";

// --------------------------------------------------------------------------
// Capability type imports
// --------------------------------------------------------------------------
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

describe("schema inferred types match hand-written types (capabilities.ts)", () => {
  it("SubAgentInfo", () => {
    expectTypeOf<z.infer<typeof SubAgentInfoSchema>>().toEqualTypeOf<SubAgentInfo>();
  });
  it("IdentityCapabilities", () => {
    expectTypeOf<z.infer<typeof IdentityCapabilitiesSchema>>().toEqualTypeOf<IdentityCapabilities>();
  });
  it("TransportCapabilities", () => {
    expectTypeOf<z.infer<typeof TransportCapabilitiesSchema>>().toEqualTypeOf<TransportCapabilities>();
  });
  it("ToolsCapabilities", () => {
    expectTypeOf<z.infer<typeof ToolsCapabilitiesSchema>>().toEqualTypeOf<ToolsCapabilities>();
  });
  it("OutputCapabilities", () => {
    expectTypeOf<z.infer<typeof OutputCapabilitiesSchema>>().toEqualTypeOf<OutputCapabilities>();
  });
  it("StateCapabilities", () => {
    expectTypeOf<z.infer<typeof StateCapabilitiesSchema>>().toEqualTypeOf<StateCapabilities>();
  });
  it("MultiAgentCapabilities", () => {
    expectTypeOf<z.infer<typeof MultiAgentCapabilitiesSchema>>().toEqualTypeOf<MultiAgentCapabilities>();
  });
  it("ReasoningCapabilities", () => {
    expectTypeOf<z.infer<typeof ReasoningCapabilitiesSchema>>().toEqualTypeOf<ReasoningCapabilities>();
  });
  it("MultimodalInputCapabilities", () => {
    expectTypeOf<z.infer<typeof MultimodalInputCapabilitiesSchema>>().toEqualTypeOf<MultimodalInputCapabilities>();
  });
  it("MultimodalOutputCapabilities", () => {
    expectTypeOf<z.infer<typeof MultimodalOutputCapabilitiesSchema>>().toEqualTypeOf<MultimodalOutputCapabilities>();
  });
  it("MultimodalCapabilities", () => {
    expectTypeOf<z.infer<typeof MultimodalCapabilitiesSchema>>().toEqualTypeOf<MultimodalCapabilities>();
  });
  it("ExecutionCapabilities", () => {
    expectTypeOf<z.infer<typeof ExecutionCapabilitiesSchema>>().toEqualTypeOf<ExecutionCapabilities>();
  });
  it("HumanInTheLoopCapabilities", () => {
    expectTypeOf<z.infer<typeof HumanInTheLoopCapabilitiesSchema>>().toEqualTypeOf<HumanInTheLoopCapabilities>();
  });
  it("AgentCapabilities", () => {
    expectTypeOf<z.infer<typeof AgentCapabilitiesSchema>>().toEqualTypeOf<AgentCapabilities>();
  });
});
