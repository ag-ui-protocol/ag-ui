import { z } from "zod";

export const FunctionCallSchema = z.object({
  name: z.string(),
  arguments: z.string(),
});

export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: FunctionCallSchema,
  encryptedValue: z.string().optional(),
});

export const BaseMessageSchema = z.object({
  id: z.string(),
  role: z.string(),
  content: z.string().optional(),
  name: z.string().optional(),
  encryptedValue: z.string().optional(),
});

export const TextInputContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const BinaryInputContentObjectSchema = z.object({
  type: z.literal("binary"),
  mimeType: z.string(),
  id: z.string().optional(),
  url: z.string().optional(),
  data: z.string().optional(),
  filename: z.string().optional(),
});

const ensureBinaryPayload = (
  value: { id?: string; url?: string; data?: string },
  ctx: z.RefinementCtx,
) => {
  if (!value.id && !value.url && !value.data) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "BinaryInputContent requires at least one of id, url, or data.",
      path: ["id"],
    });
  }
};

export const BinaryInputContentSchema = BinaryInputContentObjectSchema.superRefine((value, ctx) => {
  ensureBinaryPayload(value, ctx);
});

const InputContentBaseSchema = z.discriminatedUnion("type", [
  TextInputContentSchema,
  BinaryInputContentObjectSchema,
]);

export const InputContentSchema = InputContentBaseSchema.superRefine((value, ctx) => {
  if (value.type === "binary") {
    ensureBinaryPayload(value, ctx);
  }
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
  content: z.union([z.string(), z.array(InputContentSchema)]),
});

export const ToolMessageSchema = z.object({
  id: z.string(),
  content: z.string(),
  role: z.literal("tool"),
  toolCallId: z.string(),
  error: z.string().optional(),
  encryptedValue: z.string().optional(),
});

export const ActivityMessageSchema = z.object({
  id: z.string(),
  role: z.literal("activity"),
  activityType: z.string(),
  content: z.record(z.any()),
});

export const ReasoningMessageSchema = z.object({
  id: z.string(),
  role: z.literal("reasoning"),
  content: z.string(),
  encryptedValue: z.string().optional(),
});

export const MessageSchema = z.discriminatedUnion("role", [
  DeveloperMessageSchema,
  SystemMessageSchema,
  AssistantMessageSchema,
  UserMessageSchema,
  ToolMessageSchema,
  ActivityMessageSchema,
  ReasoningMessageSchema,
]);

export const RoleSchema = z.union([
  z.literal("developer"),
  z.literal("system"),
  z.literal("assistant"),
  z.literal("user"),
  z.literal("tool"),
  z.literal("activity"),
  z.literal("reasoning"),
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
  parentRunId: z.string().optional(),
  state: z.any(),
  messages: z.array(MessageSchema),
  tools: z.array(ToolSchema),
  context: z.array(ContextSchema),
  forwardedProps: z.any(),
});

export const StateSchema = z.any();

export type ToolCall = z.infer<typeof ToolCallSchema>;
export type FunctionCall = z.infer<typeof FunctionCallSchema>;
export type TextInputContent = z.infer<typeof TextInputContentSchema>;
export type BinaryInputContent = z.infer<typeof BinaryInputContentSchema>;
export type InputContent = z.infer<typeof InputContentSchema>;
export type DeveloperMessage = z.infer<typeof DeveloperMessageSchema>;
export type SystemMessage = z.infer<typeof SystemMessageSchema>;
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;
export type UserMessage = z.infer<typeof UserMessageSchema>;
export type ToolMessage = z.infer<typeof ToolMessageSchema>;
export type ActivityMessage = z.infer<typeof ActivityMessageSchema>;
export type ReasoningMessage = z.infer<typeof ReasoningMessageSchema>;
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

export class AGUIConnectNotImplementedError extends AGUIError {
  constructor() {
    super("Connect not implemented. This method is not supported by the current agent.");
  }
}
