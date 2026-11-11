import type {
  AssistantMessage,
  ContentPart,
  Interrupt,
  Message,
  ResumeEntry,
  ToolCall,
} from "@ag-ui/client";
import type { ModelMessage } from "ai";
import { decodeEnvelope, isRecord, jsonEqual, type ApprovalMarker } from "./provider-metadata";

/** Result text of a gated call whose approval the user rejected. */
export const REJECTED = "The user did not approve this tool call. It did not run.";

/** Result text of a gated call whose interrupt the user cancelled. */
export const CANCELLED = "The user cancelled this tool call. It did not run.";

/** Result text of a client tool call the user moved on from without answering. */
export const ABANDONED = "The user moved on without answering this tool call.";

/** Result text of a server tool call cut off before it returned (a cancel or an error). */
export const INTERRUPTED = "This tool call was interrupted before it returned.";

/** The answer an approval interrupt expects. */
export const APPROVAL_RESPONSE_SCHEMA = {
  type: "object",
  properties: { approved: { type: "boolean" } },
  required: ["approved"],
} as const;

/** A tool call the server paused for approval, as the server recorded it. */
export interface PendingApproval {
  toolCallId: string;
  approvalId: string;
  toolName: string;
  input: unknown;
}

export interface ConvertMessagesOptions {
  /** `RunAgentInput.resume`: the answers to the previous run's interrupts. */
  resume?: ResumeEntry[];
  /**
   * Names of the tools the client runs (`RunAgentInput.tools`). An unanswered
   * call to one of them is closed as abandoned.
   */
  clientToolNames?: Iterable<string>;
  /**
   * The approvals the server itself recorded when it paused (a Durable Object
   * keeps them). When given, a resume is honoured only for a call that
   * matches one of them, so a client cannot get a tool call run that the
   * model never made.
   */
  pendingApprovals?: PendingApproval[];
}

export interface ConvertedMessages {
  /** The conversation for `streamText({ messages })`. */
  messages: ModelMessage[];
  /**
   * The text of AG-UI `system` and `developer` messages, in order. AI SDK v7
   * rejects system messages inside `messages`, so they belong in the
   * instructions instead.
   */
  instructions: string[];
  /** Why the request cannot run (resume problems), as messages for RUN_ERROR. */
  resumeErrors: string[];
}

type AssistantModelMessage = Extract<ModelMessage, { role: "assistant" }>;
type ModelPart = Exclude<AssistantModelMessage["content"], string>[number];
type ToolPart = Extract<ModelMessage, { role: "tool" }>["content"][number];
type UserPart = Exclude<Extract<ModelMessage, { role: "user" }>["content"], string>[number];

/**
 * The approval interrupt for a server tool call that `needsApproval` paused.
 * The interrupt and the call share an id, so a resume entry names the call.
 *
 * The reason is `"tool_approval"`, not `"tool_call"`: clients such as
 * CopilotKit read `"tool_call"` as a call the client answers itself and
 * write the response into the history as the tool's result. Here the server
 * runs the tool and the response is only the decision.
 */
export function approvalInterrupt(toolCallId: string, toolName: string, input: unknown): Interrupt {
  return {
    id: toolCallId,
    reason: "tool_approval",
    message: `Approve call to ${toolName}?`,
    toolCallId,
    responseSchema: { ...APPROVAL_RESPONSE_SCHEMA },
    metadata: {
      tool_name: toolName,
      tool_input: input,
      "ag-ui:tool-execution": "server",
    },
  };
}

/** Converts AG-UI messages into AI SDK model messages. */
export function toModelMessages(messages: Message[]): ModelMessage[] {
  return convertMessages(messages).messages;
}

interface OpenCall {
  call: ToolCall;
  input: unknown;
  approval?: ApprovalMarker;
  owner: AssistantModelMessage;
}

/**
 * Converts an AG-UI conversation into AI SDK model messages, and settles the
 * tool calls the previous run left without a result.
 *
 * Resume is stateless. A call the AI SDK paused for approval stays in the
 * client's history without a result, marked in its `encryptedValue`. Its
 * resume entry becomes an AI SDK tool approval (a `tool-approval-request` on
 * the call plus a `tool-approval-response` at the end), so `streamText` runs
 * an approved tool, or reports a denied one, before it calls the model.
 *
 * Every other call without a result is closed with a result saying so: a
 * client tool the user moved on from, or a server tool cut off by a cancel or
 * an error. A request that leaves an approval unanswered, answers only some,
 * or names something that is not waiting for approval is refused
 * (`resumeErrors`), as AG-UI's interrupt rules require.
 */
export function convertMessages(
  messages: Message[],
  options: ConvertMessagesOptions = {},
): ConvertedMessages {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") answered.add(message.toolCallId);
  }

  const result: ModelMessage[] = [];
  const instructions: string[] = [];
  const toolNames = new Map<string, string>();
  const calls = new Map<string, OpenCall>();

  // The assistant turn being built: consecutive assistant and reasoning
  // messages (one per text block or step) merge into one model message, so
  // tool results follow the turn that holds their calls.
  const turn: { assistant: AssistantModelMessage | null; pendingReasoning: ModelPart[] } = {
    assistant: null,
    pendingReasoning: [],
  };
  const closeAssistant = () => {
    const { assistant } = turn;
    if (assistant && (assistant.content as ModelPart[]).length > 0) result.push(assistant);
    turn.assistant = null;
    turn.pendingReasoning = [];
  };
  const openAssistant = () => {
    if (!turn.assistant) {
      turn.assistant = { role: "assistant", content: [...turn.pendingReasoning] as ModelPart[] };
      turn.pendingReasoning = [];
    }
    return turn.assistant;
  };

  for (const message of messages) {
    switch (message.role) {
      case "system":
      case "developer": {
        const text = textOf(message.content);
        if (text) instructions.push(text);
        break;
      }

      case "user": {
        closeAssistant();
        result.push({ role: "user", content: userContent(message.content) });
        break;
      }

      case "reasoning": {
        const { providerMetadata } = decodeEnvelope(message.encryptedValue);
        const part = {
          type: "reasoning",
          text: message.content ?? "",
          ...(providerMetadata && { providerOptions: providerMetadata }),
        } as ModelPart;
        if (turn.assistant) (turn.assistant.content as ModelPart[]).push(part);
        else turn.pendingReasoning.push(part);
        break;
      }

      case "assistant": {
        const target = openAssistant();
        const content = target.content as ModelPart[];
        const text = textOf(message.content);
        if (text) {
          const { providerMetadata } = decodeEnvelope(message.encryptedValue);
          content.push({
            type: "text",
            text,
            ...(providerMetadata && { providerOptions: providerMetadata }),
          } as ModelPart);
        }
        for (const call of (message as AssistantMessage).toolCalls ?? []) {
          const input = parseArguments(call.function.arguments);
          const { providerMetadata, approval } = decodeEnvelope(call.encryptedValue);
          content.push({
            type: "tool-call",
            toolCallId: call.id,
            toolName: call.function.name,
            input,
            ...(providerMetadata && { providerOptions: providerMetadata }),
          } as ModelPart);
          toolNames.set(call.id, call.function.name);
          calls.set(call.id, { call, input, approval, owner: target });
        }
        break;
      }

      case "tool": {
        closeAssistant();
        const part = {
          type: "tool-result",
          toolCallId: message.toolCallId,
          toolName: toolNames.get(message.toolCallId) ?? "unknown",
          output: message.error
            ? { type: "error-text", value: message.error }
            : { type: "text", value: textOf(message.content) },
        } as ToolPart;
        appendToolParts(result, [part]);
        break;
      }

      default:
        // Activity messages carry UI state, nothing the model reads.
        break;
    }
  }
  closeAssistant();

  const open = [...calls.values()].filter(({ call }) => !answered.has(call.id));
  const resumeErrors = settleOpenCalls(result, open, calls, options);
  return { messages: result, instructions, resumeErrors };
}

/** Closes or resumes the calls without a result; returns why the request cannot run, if it cannot. */
function settleOpenCalls(
  result: ModelMessage[],
  open: OpenCall[],
  calls: Map<string, OpenCall>,
  options: ConvertMessagesOptions,
): string[] {
  const errors: string[] = [];
  const clientTools = new Set(options.clientToolNames ?? []);
  const trusted = options.pendingApprovals
    ? new Map(options.pendingApprovals.map((approval) => [approval.toolCallId, approval]))
    : undefined;

  const entries = new Map<string, ResumeEntry>();
  for (const entry of options.resume ?? []) {
    if (entries.has(entry.interruptId)) {
      errors.push(`Resume answers interrupt "${entry.interruptId}" more than once.`);
    }
    entries.set(entry.interruptId, entry);
  }
  for (const id of entries.keys()) {
    // A replayed resume for a call that already has its result is harmless
    // (AG-UI resumes must be idempotent); an id that names no call is not.
    if (!calls.has(id)) errors.push(`Resume names interrupt "${id}", which is not a tool call in this thread.`);
  }

  const approvals: ToolPart[] = [];
  const unanswered: string[] = [];
  const closures = new Map<AssistantModelMessage, ToolPart[]>();
  const close = (owner: AssistantModelMessage, call: ToolCall, text: string) => {
    const parts = closures.get(owner) ?? [];
    parts.push({
      type: "tool-result",
      toolCallId: call.id,
      toolName: call.function.name,
      output: { type: "text", value: text },
    } as ToolPart);
    closures.set(owner, parts);
  };

  for (const { call, input, approval, owner } of open) {
    const entry = entries.get(call.id);

    if (!approval) {
      if (entry) errors.push(`Resume names "${call.id}", which is not waiting for approval.`);
      close(owner, call, clientTools.has(call.function.name) ? ABANDONED : INTERRUPTED);
      continue;
    }

    if (!entry) {
      unanswered.push(call.id);
      continue;
    }

    if (trusted) {
      const recorded = trusted.get(call.id);
      if (
        !recorded ||
        recorded.approvalId !== approval.approvalId ||
        recorded.toolName !== call.function.name ||
        !jsonEqual(recorded.input, input)
      ) {
        errors.push(`Resume names "${call.id}", which does not match an approval this agent is waiting for.`);
        continue;
      }
    }

    // streamText reads approvals from the last message only, and runs the
    // tool after it: the paused turn has to be the conversation's last.
    const index = result.indexOf(owner);
    if (result.slice(index + 1).some((message) => message.role !== "tool")) {
      errors.push(`Cannot resume "${call.id}": the conversation went on after the call was paused.`);
      continue;
    }

    const decision = readDecision(entry);
    if ("error" in decision) {
      errors.push(decision.error);
      continue;
    }
    (owner.content as ModelPart[]).push({
      type: "tool-approval-request",
      approvalId: approval.approvalId,
      toolCallId: call.id,
      ...(approval.signature && { signature: approval.signature }),
    } as ModelPart);
    approvals.push({
      type: "tool-approval-response",
      approvalId: approval.approvalId,
      approved: decision.approved,
      ...(decision.reason && { reason: decision.reason }),
    } as ToolPart);
  }

  if (unanswered.length > 0) {
    errors.push(
      `The thread has approvals waiting for an answer, and the request's resume does not answer ${unanswered
        .map((id) => `"${id}"`)
        .join(", ")}.`,
    );
  }

  // Closed calls get their result right after the turn holding them.
  for (const [owner, parts] of closures) {
    const index = result.indexOf(owner);
    const next = result[index + 1];
    if (next?.role === "tool") (next.content as ToolPart[]).push(...parts);
    else result.splice(index + 1, 0, { role: "tool", content: parts });
  }
  if (approvals.length > 0) appendToolParts(result, approvals);
  return errors;
}

type Decision = { approved: boolean; reason?: string } | { error: string };

function readDecision(entry: ResumeEntry): Decision {
  if (entry.status === "cancelled") return { approved: false, reason: CANCELLED };
  const payload: unknown = entry.payload;
  if (typeof payload === "boolean") {
    return payload ? { approved: true } : { approved: false, reason: REJECTED };
  }
  if (isRecord(payload) && typeof payload.approved === "boolean") {
    if (payload.approved) return { approved: true };
    const reason = typeof payload.reason === "string" && payload.reason ? payload.reason : REJECTED;
    return { approved: false, reason };
  }
  return { error: `Resume for interrupt "${entry.interruptId}" needs a payload of { approved: boolean }.` };
}

function appendToolParts(result: ModelMessage[], parts: ToolPart[]) {
  const last = result[result.length - 1];
  if (last?.role === "tool") (last.content as ToolPart[]).push(...parts);
  else result.push({ role: "tool", content: parts });
}

function userContent(content: string | ContentPart[]): string | UserPart[] {
  if (typeof content === "string") return content;
  const parts: UserPart[] = [];
  for (const part of content) {
    const converted = userPart(part);
    if (converted) parts.push(converted);
  }
  return parts;
}

function userPart(part: ContentPart): UserPart | undefined {
  if (part.type === "text") return { type: "text", text: part.text };

  const source = part.source;
  const mediaType = source.mimeType;
  const filename =
    isRecord(part.metadata) && typeof part.metadata.filename === "string" ? part.metadata.filename : undefined;

  if (source.type === "file") {
    // A provider-side file id: AI SDK v6 has no portable way to reference it.
    return { type: "text", text: `[${part.type} file: ${source.value}]` };
  }

  const data = source.type === "url" ? toUrl(source.value) : source.value;
  if (data === undefined) return { type: "text", text: `[${part.type}: ${source.value}]` };

  if (part.type === "image") {
    return { type: "image", image: data, ...(mediaType && { mediaType }) } as UserPart;
  }
  return {
    type: "file",
    data,
    mediaType: mediaType ?? defaultMediaType(part.type),
    ...(filename && { filename }),
  } as UserPart;
}

function defaultMediaType(kind: ContentPart["type"]): string {
  switch (kind) {
    case "audio":
      return "audio/*";
    case "video":
      return "video/*";
    case "document":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function toUrl(value: string): URL | string | undefined {
  // Data URLs stay strings: AI SDK reads their base64 payload directly.
  if (value.startsWith("data:")) return value;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** The text of a message's content; media parts are dropped. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

function parseArguments(args: string | undefined): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}
