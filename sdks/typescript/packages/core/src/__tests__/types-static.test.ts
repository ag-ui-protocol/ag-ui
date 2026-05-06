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
