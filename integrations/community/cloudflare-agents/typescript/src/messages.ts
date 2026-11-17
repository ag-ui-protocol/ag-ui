import type {
  AssistantMessage,
  ContentPart,
  Interrupt,
  Message,
  ResumeEntry,
  ToolCall,
} from "@ag-ui/client";
import type { ModelMessage } from "ai";
import { warn } from "./input";
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
  /**
   * Resume entries the request carries that answer nothing this agent is
   * waiting for. AG-UI has the run go on without them, with a warning.
   */
  resumeWarnings: string[];
  /** The paused tool calls this request resumes (approved or denied), in order. */
  resumed: string[];
  /**
   * Recorded approvals the request rejects or cancels without carrying their
   * calls open (a client that no longer has them, or has results for them).
   * The record can forget them.
   */
  abandoned: string[];
  /**
   * The reason given for each call this request denies, by tool call id. The
   * AI SDK tells the model in this run; the denied call's result in the
   * history carries it from then on.
   */
  denials: Map<string, string>;
}

type AssistantModelMessage = Extract<ModelMessage, { role: "assistant" }>;
type ModelPart = Exclude<AssistantModelMessage["content"], string>[number];
type ToolPart = Extract<ModelMessage, { role: "tool" }>["content"][number];
type UserPart = Exclude<Extract<ModelMessage, { role: "user" }>["content"], string>[number];

/**
 * The approval interrupt for a server tool call the AI SDK paused for approval.
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
 * an error. With `pendingApprovals` (the server's own record), that record
 * decides which calls are still waiting for an answer; without it, the
 * marker does.
 *
 * A request that leaves a waiting approval unanswered, leaves out the call of
 * an approval the server recorded or sends a result for it, answers one in a
 * way that cannot be honoured, or resumes a call the conversation has moved
 * past is refused (`resumeErrors`): AG-UI forbids an agent to drop an
 * approval nobody answered. A recorded approval whose call the request no
 * longer carries, or carries with a result, can still be rejected or
 * cancelled (`abandoned`). A resume entry for something that is not waiting
 * is ignored (`resumeWarnings`), as AG-UI asks.
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
  const settled = settleOpenCalls(result, open, calls, options);
  return {
    messages: result,
    instructions,
    resumeErrors: settled.errors,
    resumeWarnings: settled.warnings,
    resumed: settled.resumed,
    abandoned: settled.abandoned,
    denials: settled.denials,
  };
}

interface Settlement {
  errors: string[];
  warnings: string[];
  resumed: string[];
  abandoned: string[];
  denials: Map<string, string>;
}

/** Closes or resumes the calls without a result, and says why the request cannot run, if it cannot. */
function settleOpenCalls(
  result: ModelMessage[],
  open: OpenCall[],
  calls: Map<string, OpenCall>,
  options: ConvertMessagesOptions,
): Settlement {
  const errors: string[] = [];
  const warnings: string[] = [];
  const resumed: string[] = [];
  const denials = new Map<string, string>();
  const clientTools = new Set(options.clientToolNames ?? []);
  const recorded = options.pendingApprovals
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
    // (AG-UI resumes must be idempotent); one that names no call answers nothing.
    if (!calls.has(id) && !recorded?.has(id)) {
      warnings.push(`Ignored the resume for "${id}": no such interrupt in this thread.`);
    }
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
    const record = recorded?.get(call.id);
    // Whether this call is an approval still waiting for an answer: the
    // server's record says so when there is one, the call's marker otherwise.
    // A marker the record does not know is left over from a run that ended
    // before it could ask (or was never this agent's).
    const waiting = recorded ? record !== undefined : approval !== undefined;

    if (!waiting) {
      if (entry) warnings.push(`Ignored the resume for "${call.id}": that call is not waiting for approval.`);
      close(owner, call, clientTools.has(call.function.name) ? ABANDONED : INTERRUPTED);
      continue;
    }

    if (!entry) {
      unanswered.push(call.id);
      continue;
    }

    if (!approval) {
      errors.push(`Cannot resume "${call.id}": the request lost the call's approval marker (its encryptedValue).`);
      continue;
    }
    if (
      record &&
      (record.approvalId !== approval.approvalId ||
        record.toolName !== call.function.name ||
        !jsonEqual(record.input, input))
    ) {
      errors.push(`Resume names "${call.id}", which does not match the approval this agent is waiting for.`);
      continue;
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
    if (!decision.approved && decision.reason) denials.set(call.id, decision.reason);
    resumed.push(call.id);
    approvals.push({
      type: "tool-approval-response",
      approvalId: approval.approvalId,
      approved: decision.approved,
      ...(decision.reason && { reason: decision.reason }),
    } as ToolPart);
  }

  if (unanswered.length > 0) {
    errors.push(
      `The thread has approvals waiting for an answer, and the request's resume does not answer ${quoted(unanswered)}.`,
    );
  }

  // A recorded approval is still waiting when the request leaves its call out,
  // or sends a result for it (the tool never ran): neither abandons it. A
  // client in that state can still reject or cancel it, but cannot approve it.
  const settled = new Set(open.map(({ call }) => call.id));
  const abandoned: string[] = [];
  const missing: string[] = [];
  const resulted: string[] = [];
  for (const id of recorded?.keys() ?? []) {
    if (settled.has(id)) continue;
    const entry = entries.get(id);
    const decision = entry && readDecision(entry);
    if (decision && !("error" in decision) && !decision.approved) abandoned.push(id);
    else if (calls.has(id)) resulted.push(id);
    else missing.push(id);
  }
  if (missing.length > 0) {
    errors.push(
      `The thread has approvals waiting for an answer, and the request's history leaves out their calls: ` +
        `${quoted(missing)}. Send the conversation with the calls, or cancel the approvals.`,
    );
  }
  if (resulted.length > 0) {
    errors.push(
      `The thread has approvals waiting for an answer, and the request's history has results for their calls: ` +
        `${quoted(resulted)}. Send the conversation without those results, or cancel the approvals.`,
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
  return { errors, warnings, resumed, abandoned, denials };
}

function quoted(ids: string[]): string {
  return ids.map((id) => `"${id}"`).join(", ");
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
    // A provider's file handle is opaque (AG-UI forbids reading it) and the AI
    // SDK has no portable way to hand one on: the part is skipped, and the
    // model is told something was attached, so it can say it cannot see it.
    const kind = /^[aeiou]/.test(part.type) ? `An ${part.type}` : `A ${part.type}`;
    warn(`Skipped ${kind.toLowerCase()} attached as a provider file: this agent cannot pass file handles to the model.`);
    return { type: "text", text: `[${kind} was attached as a provider file this agent cannot read.]` };
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
