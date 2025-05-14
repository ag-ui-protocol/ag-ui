import { z } from "zod";

export const FunctionCallSchema = z.object({
  name: z.string(),
  arguments: z.string(),
});

export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: FunctionCallSchema,
});

export const BaseMessageSchema = z.object({
  id: z.string(),
  role: z.string(),
  content: z.string().optional(),
  name: z.string().optional(),
});

export const DeveloperMessageSchema = BaseMessageSchema.extend({
  role: z.literal("developer"),
  content: z.string(),
});

export const SystemMessageSchema = BaseMessageSchema.extend({
  role: z.literal("system"),
  content: z.string(),
});

export const AssistantMessageSchema = BaseMessageSchema.extend({
  role: z.literal("assistant"),
  content: z.string().optional(),
  toolCalls: z.array(ToolCallSchema).optional(),
});

export const UserMessageSchema = BaseMessageSchema.extend({
  role: z.literal("user"),
  content: z.string(),
});

export const ToolMessageSchema = z.object({
  id: z.string(),
  content: z.string(),
  role: z.literal("tool"),
  toolCallId: z.string(),
});

export const MessageSchema = z.discriminatedUnion("role", [
  DeveloperMessageSchema,
  SystemMessageSchema,
  AssistantMessageSchema,
  UserMessageSchema,
  ToolMessageSchema,
]);

export const RoleSchema = z.union([
  z.literal("developer"),
  z.literal("system"),
  z.literal("assistant"),
  z.literal("user"),
  z.literal("tool"),
]);

export const ContextSchema = z.object({
  description: z.string(),
  value: z.string(),
});

export const ToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.any(), // JSON Schema for the tool parameters
});

export const RunAgentInputSchema = z.object({
  threadId: z.string(),
  runId: z.string(),
  state: z.any(),
  messages: z.array(MessageSchema),
  tools: z.array(ToolSchema),
  context: z.array(ContextSchema),
  forwardedProps: z.any(),
});

export const StateSchema = z.any();

export type ToolCall = z.infer<typeof ToolCallSchema>;
export type FunctionCall = z.infer<typeof FunctionCallSchema>;
export type DeveloperMessage = z.infer<typeof DeveloperMessageSchema>;
export type SystemMessage = z.infer<typeof SystemMessageSchema>;
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;
export type UserMessage = z.infer<typeof UserMessageSchema>;
export type ToolMessage = z.infer<typeof ToolMessageSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type Context = z.infer<typeof ContextSchema>;
export type Tool = z.infer<typeof ToolSchema>;
export type RunAgentInput = z.infer<typeof RunAgentInputSchema>;
export type State = z.infer<typeof StateSchema>;
export type Role = z.infer<typeof RoleSchema>;

export class AGUIError extends Error {
  constructor(message: string) {
    super(message);
  }
}
