import { z } from "zod";

export const TextInputContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const BinaryInputContentSchema = z
  .object({
    type: z.literal("binary"),
    mimeType: z.string(),
    id: z.string().optional(),
    url: z.string().url().optional(),
    data: z.string().optional(),
    filename: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.id && !value.url && !value.data) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Binary content requires data, url, or id.",
        path: ["data"],
      });
    }
  });

export const InputContentSchema = z.union([TextInputContentSchema, BinaryInputContentSchema]);

const MessageContentSchema = z.union([z.string(), z.array(InputContentSchema)]).optional();

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
  content: MessageContentSchema,
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
});

export const UserMessageSchema = RawUserMessageSchema.superRefine((value, ctx) => {
  if (value.content === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "User messages must include content.",
      path: ["content"],
    });
    return;
  }

  if (typeof value.content === "string") {
    if (value.content.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "User messages must include non-empty text or binary content.",
        path: ["content"],
      });
    }
    return;
  }

  const items = value.content;
  if (items.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "User messages must include non-empty text or binary content.",
      path: ["content"],
    });
    return;
  }

  const hasMeaningfulContent = items.some((item) => {
    if (item.type === "text") {
      return item.text.trim().length > 0;
    }
    return true;
  });

  if (!hasMeaningfulContent) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "User messages must include non-empty text or binary content.",
      path: ["content"],
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
export type TextInputContent = z.infer<typeof TextInputContentSchema>;
export type BinaryInputContent = z.infer<typeof BinaryInputContentSchema>;
export type InputContent = z.infer<typeof InputContentSchema>;

export class AGUIError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export const userMessageHasBody = (message: UserMessage): boolean => {
  if (typeof message.content === "string") {
    return message.content.trim().length > 0;
  }

  const items = message.content ?? [];
  if (items.length === 0) {
    return false;
  }

  return items.some((item) => {
    if (item.type === "text") {
      return item.text.trim().length > 0;
    }
    return Boolean(item.data || item.url || item.id);
  });
};

export const assertUserMessageHasBody = (message: UserMessage): void => {
  if (!userMessageHasBody(message)) {
    throw new AGUIError("User messages must include non-empty text or binary content.");
  }
};

export const createTextInputContent = (text: string): TextInputContent => ({
  type: "text",
  text,
});

type BinaryContentParams = {
  mimeType: string;
  id?: string;
  url?: string;
  data?: string;
  filename?: string;
};

export const createBinaryInputContent = ({
  mimeType,
  id,
  url,
  data,
  filename,
}: BinaryContentParams): BinaryInputContent => ({
  type: "binary",
  mimeType,
  id,
  url,
  data,
  filename,
});

export const normalizeInputContent = (content: string | InputContent[]): InputContent[] => {
  if (Array.isArray(content)) {
    return content;
  }
  return [createTextInputContent(content)];
};

const maybeBuffer: any =
  typeof globalThis !== "undefined" && (globalThis as Record<string, unknown>).Buffer
    ? (globalThis as Record<string, any>).Buffer
    : undefined;
const hasNativeBuffer = typeof maybeBuffer?.from === "function";
const globalBtoa =
  typeof globalThis !== "undefined" && typeof globalThis.btoa === "function"
    ? (globalThis.btoa as (data: string) => string)
    : undefined;
const globalAtob =
  typeof globalThis !== "undefined" && typeof globalThis.atob === "function"
    ? (globalThis.atob as (data: string) => string)
    : undefined;

export const encodeBinaryData = (data: Uint8Array): string => {
  if (hasNativeBuffer) {
    return maybeBuffer.from(data).toString("base64");
  }

  let binary = "";
  data.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  if (!globalBtoa) {
    throw new AGUIError("Base64 encoding is not supported in this environment.");
  }
  return globalBtoa(binary);
};

export const decodeBinaryData = (base64: string): Uint8Array => {
  if (hasNativeBuffer) {
    return Uint8Array.from(maybeBuffer.from(base64, "base64"));
  }

  if (!globalAtob) {
    throw new AGUIError("Base64 decoding is not supported in this environment.");
  }
  const binary = globalAtob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};
