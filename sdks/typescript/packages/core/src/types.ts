import { z } from "zod";

export const FileAttachmentSchema = z.object({
  url: z
    .string()
    .refine((value) => value.startsWith("data:"), {
      message: "Attachment url must be a data URL (data:<mime>;base64,...)",
    }),
});

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

const RawUserMessageSchema = BaseMessageSchema.extend({
  role: z.literal("user"),
  content: z.string().optional(),
  attachments: z.array(FileAttachmentSchema).optional(),
});

export const UserMessageSchema = RawUserMessageSchema.superRefine((value, ctx) => {
  const hasContent = typeof value.content === "string" && value.content.trim().length > 0;
  const attachments = value.attachments ?? [];

  if (!hasContent && attachments.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "User messages must include content or at least one attachment.",
      path: ["attachments"],
    });
  }
});

export const ToolMessageSchema = z.object({
  id: z.string(),
  content: z.string(),
  role: z.literal("tool"),
  toolCallId: z.string(),
  error: z.string().optional(),
});

export const MessageSchema = z
  .discriminatedUnion("role", [
    DeveloperMessageSchema,
    SystemMessageSchema,
    AssistantMessageSchema,
    RawUserMessageSchema,
    ToolMessageSchema,
  ])
  .superRefine((value, ctx) => {
    if (value.role === "user") {
      const parsed = UserMessageSchema.safeParse(value);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue(issue);
        }
      }
    }
  });

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
export type FileAttachment = z.infer<typeof FileAttachmentSchema>;

export class AGUIError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export const userMessageHasBody = (message: UserMessage): boolean => {
  const content = message.content ?? "";
  const hasContent = content.trim().length > 0;
  const hasAttachments = (message.attachments?.length ?? 0) > 0;
  return hasContent || hasAttachments;
};

export const assertUserMessageHasBody = (message: UserMessage): void => {
  if (!userMessageHasBody(message)) {
    throw new AGUIError("User messages must include content or at least one attachment.");
  }
};
