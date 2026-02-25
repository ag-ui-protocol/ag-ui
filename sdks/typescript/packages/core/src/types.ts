import * as z from "zod/v4-mini";

export const FunctionCallSchema = z.object({
  name: z.string(),
  arguments: z.string(),
});

export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: FunctionCallSchema,
  encryptedValue: z.optional(z.string()),
});

export const BaseMessageSchema = z.object({
  id: z.string(),
  role: z.string(),
  content: z.optional(z.string()),
  name: z.optional(z.string()),
  encryptedValue: z.optional(z.string()),
});

export const TextInputContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const BinaryInputContentObjectSchema = z.object({
  type: z.literal("binary"),
  mimeType: z.string(),
  id: z.optional(z.string()),
  url: z.optional(z.string()),
  data: z.optional(z.string()),
  filename: z.optional(z.string()),
});

const ensureBinaryPayload = (
  value: { id?: string; url?: string; data?: string },
  ctx: z.core.$RefinementCtx
) => {
  if (!value.id && !value.url && !value.data) {
    ctx.addIssue({
      code: "custom",
      message: "BinaryInputContent requires at least one of id, url, or data.",
      path: ["id"],
    });
  }
};

export const BinaryInputContentSchema = BinaryInputContentObjectSchema.check(z.superRefine((value, ctx) => {
  ensureBinaryPayload(value, ctx);
}));

const InputContentBaseSchema = z.discriminatedUnion("type", [
  TextInputContentSchema,
  BinaryInputContentObjectSchema,
]);

export const InputContentSchema = InputContentBaseSchema.check(z.superRefine((value, ctx) => {
  if (value.type === "binary") {
    ensureBinaryPayload(value, ctx);
  }
}));

export const DeveloperMessageSchema = z.extend(BaseMessageSchema, {
  role: z.literal("developer"),
  content: z.string(),
});

export const SystemMessageSchema = z.extend(BaseMessageSchema, {
  role: z.literal("system"),
  content: z.string(),
});

export const AssistantMessageSchema = z.extend(BaseMessageSchema, {
  role: z.literal("assistant"),
  content: z.optional(z.string()),
  toolCalls: z.optional(z.array(ToolCallSchema)),
});

export const UserMessageSchema = z.extend(BaseMessageSchema, {
  role: z.literal("user"),
  content: z.union([z.string(), z.array(InputContentSchema)]),
});

export const ToolMessageSchema = z.object({
  id: z.string(),
  content: z.string(),
  role: z.literal("tool"),
  toolCallId: z.string(),
  error: z.optional(z.string()),
  encryptedValue: z.optional(z.string()),
});

export const ActivityMessageSchema = z.object({
  id: z.string(),
  role: z.literal("activity"),
  activityType: z.string(),
  content: z.record(z.any(), z.any()),
});

export const ReasoningMessageSchema = z.object({
  id: z.string(),
  role: z.literal("reasoning"),
  content: z.string(),
  encryptedValue: z.optional(z.string()),
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
  parentRunId: z.optional(z.string()),
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
