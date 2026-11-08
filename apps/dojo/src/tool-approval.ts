import { buildResumeArray } from "@ag-ui/client";

// Approval details shared by the Tool Approval page and its test.
export interface ApprovalRequest {
  toolName?: string;
  args?: { amount?: number; description?: string };
  cao?: CaoApproval;
}

// A CLI Agent Orchestrator interrupt is a real CLI's prompt in a tmux
// terminal. CAO puts only metadata on the wire, never the prompt text, so the
// card names the terminal to look at rather than what it asks.
export interface CaoApproval {
  provider: string;
  terminalId: string;
}

// Approval details as the bridge sends them, before the type check.
interface ApprovalPayload extends ApprovalRequest {
  type?: unknown;
}

// The @ag-ui/mastra bridge publishes a pending approval as a standard
// interrupt: `event.value` is the Interrupt, with the details under
// `metadata.mastra`. Returns null for any other interrupt so this hook ignores
// it.
export function readApprovalRequest(value: unknown): ApprovalRequest | null {
  if (!value || typeof value !== "object") return null;
  const request = (value as { metadata?: { mastra?: ApprovalPayload } })
    .metadata?.mastra;
  if (request?.type === "mastra_tool_approval")
    return { toolName: request.toolName, args: request.args };
  return readCaoApproval(value);
}

// A CAO interrupt carries `metadata.provider` and `metadata.terminalId`; those
// keys are what identify it (Mastra's interrupts carry `metadata.mastra`
// instead, and are handled above). The regex only rejects a malformed reason;
// CAO's are `namespace:name`, e.g. `claude-code:permission_request`. CAO
// resumes with `{ approved }`, the same payload Mastra takes.
const CAO_REASON = /^[a-z0-9-]+:[a-z0-9_]+$/;

function readCaoApproval(value: object): ApprovalRequest | null {
  const { reason, metadata } = value as {
    reason?: unknown;
    metadata?: { provider?: unknown; terminalId?: unknown };
  };
  if (
    typeof reason !== "string" ||
    !CAO_REASON.test(reason) ||
    typeof metadata?.provider !== "string" ||
    typeof metadata.terminalId !== "string"
  )
    return null;
  return {
    toolName: reason,
    cao: { provider: metadata.provider, terminalId: metadata.terminalId },
  };
}

// An open interrupt as the page sees it: the id CopilotKit resumes it by, and
// the approval details read from it. `generic` marks an interrupt the page does
// not recognise as an approval; it still gets a card so the batch can be
// answered, because a resume must address every open interrupt.
export interface PendingApproval {
  id: string | undefined;
  request: ApprovalRequest;
  generic?: boolean;
  // The page cannot answer this interrupt: its response schema does not accept
  // `{ approved: boolean }`, or it has none and is not a recognised approval.
  unsupported?: boolean;
  // The interrupt's response schema as text, for an unsupported card.
  schema?: string;
}

// Whether a response schema accepts `{ approved: boolean }` as the answer: an
// object schema with a boolean `approved` property and no other required field.
// CAO's interrupts always do (run_plane.py:159-177 at the pinned commit).
export function acceptsApproved(schema: unknown): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    return false;
  const { type, properties, required } = schema as {
    type?: unknown;
    properties?: Record<string, { type?: unknown } | undefined>;
    required?: unknown;
  };
  if (type !== undefined && type !== "object") return false;
  if (properties?.approved?.type !== "boolean") return false;
  return (
    !Array.isArray(required) || required.every((key) => key === "approved")
  );
}

type OpenInterrupt = {
  id?: string;
  reason?: unknown;
  type?: unknown;
  responseSchema?: unknown;
};

function describeSchema(schema: unknown): string | undefined {
  if (schema === undefined) return undefined;
  try {
    return JSON.stringify(schema, null, 2);
  } catch {
    return String(schema);
  }
}

// One entry per open interrupt. CAO reports every terminal that is waiting,
// and CopilotKit resumes the run only once each interrupt has an answer, so
// the page needs a card for each. Recognised approvals keep their own card;
// any other interrupt gets a generic one naming its id and reason. The page
// sends `{ approved }` only to an interrupt whose response schema accepts it
// (a recognised approval with no schema counts); anything else is marked
// `unsupported`, because sending it that payload would be wrong. Without
// standard interrupts (`interrupts` empty) the legacy `event.value` is the only
// one, with no id, and is shown only if it is an approval.
export function collectApprovals(
  eventValue: unknown,
  interrupts: readonly OpenInterrupt[] | undefined,
): PendingApproval[] {
  if (!interrupts || interrupts.length === 0) {
    const request = readApprovalRequest(eventValue);
    return request ? [{ id: undefined, request }] : [];
  }
  return interrupts.map((interrupt) => {
    const request = readApprovalRequest(interrupt);
    const hasSchema = interrupt.responseSchema !== undefined;
    if (request) {
      if (!hasSchema || acceptsApproved(interrupt.responseSchema))
        return { id: interrupt.id, request };
    } else if (acceptsApproved(interrupt.responseSchema)) {
      const kind = [interrupt.reason, interrupt.type].find(
        (value): value is string => typeof value === "string" && value !== "",
      );
      return {
        id: interrupt.id,
        generic: true,
        request: { toolName: kind ?? "interrupt" },
      };
    }
    const kind = [interrupt.reason, interrupt.type].find(
      (value): value is string => typeof value === "string" && value !== "",
    );
    return {
      id: interrupt.id,
      generic: true,
      unsupported: true,
      schema: describeSchema(interrupt.responseSchema),
      request: { toolName: request?.toolName ?? kind ?? "interrupt" },
    };
  });
}

// What the page needs from CopilotKit to send an answer and see whether the
// run failed. CopilotKitCore.runAgent catches a run failure, reports it to
// subscribers' `onError` (code `agent_run_failed`), and returns normally, so
// the returned promise says nothing about delivery.
export interface ResumeHost {
  subscribe(subscriber: {
    onError?: (event: {
      error: Error;
      code?: string;
      context?: { agentId?: string };
    }) => void | Promise<void>;
  }): { unsubscribe(): void };
  runAgent(params: {
    agent: ResumeAgent;
    resume: ReturnType<typeof buildResumeArray>;
  }): Promise<unknown>;
}

export interface ResumeAgent {
  agentId?: string;
}

export type Answers = Record<string, { status: "resolved"; payload: unknown }>;

export type Delivery = { ok: true } | { ok: false; message: string };

// Sends one resume run that answers every interrupt in `interrupts`. It counts
// as delivered only if this attempt's run finishes without a run error for
// this agent. The error listener is created for this attempt and removed when
// it ends, so an earlier failure cannot affect a later attempt. If the run
// fails the agent keeps the interrupts pending, so calling this again resumes
// the same interrupt ids.
export async function sendResume(
  host: ResumeHost,
  agent: ResumeAgent,
  interrupts: readonly { id: string }[],
  answers: Answers,
): Promise<Delivery> {
  const errors: Error[] = [];
  const subscription = host.subscribe({
    onError: ({ error, context }) => {
      if (context?.agentId === undefined || context.agentId === agent.agentId)
        errors.push(error);
    },
  });
  try {
    await host.runAgent({
      agent,
      resume: buildResumeArray(
        interrupts as Parameters<typeof buildResumeArray>[0],
        answers,
      ),
    });
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  } finally {
    subscription.unsubscribe();
  }
  return errors.length === 0
    ? { ok: true }
    : { ok: false, message: errors[0].message };
}

// Holds the answers given so far for the open interrupts. CAO can report
// several terminals at once and the library resumes only when each has an
// answer, so earlier answers wait here until the last one arrives.
//
// Once a batch has been sent its answers are locked, whether or not the send
// succeeded: CAO may have applied some of them before the failure, and on a
// retry it skips interrupts it has already resolved. Changing a sent answer
// would then be silently ignored for those interrupts, so a retry resends
// exactly the same answers, and only interrupts never sent can still change.
export class ApprovalSession {
  private answers: Answers = {};
  private sent = new Map<string, boolean>();

  constructor(
    private readonly host: ResumeHost,
    private readonly agent: ResumeAgent,
  ) {}

  // The answers already sent (delivered or not) for the open interrupts.
  sentAnswers(): ReadonlyMap<string, boolean> {
    return new Map(this.sent);
  }

  // Records one answer. Returns "waiting" while other open interrupts are
  // unanswered, "blocked" if an open interrupt is one this page cannot
  // answer, "locked" if this interrupt was already sent with the other
  // answer, otherwise sends the resume run. A failed send keeps every answer,
  // so the next call for the same interrupt and answer retries the same batch.
  async answer(
    open: readonly { id: string; answerable?: boolean }[],
    id: string,
    approved: boolean,
  ): Promise<Delivery | "waiting" | "locked" | "blocked"> {
    // A batch with an interrupt this page cannot answer can never be sent from
    // here, and `{ approved }` must not be sent to it, so nothing is recorded.
    if (open.some((interrupt) => interrupt.answerable === false))
      return "blocked";
    // Drop answers for interrupts no longer open, so a stale one cannot make
    // buildResumeArray reject the batch.
    const openIds = new Set(open.map((interrupt) => interrupt.id));
    for (const known of Object.keys(this.answers))
      if (!openIds.has(known)) delete this.answers[known];
    for (const known of [...this.sent.keys()])
      if (!openIds.has(known)) this.sent.delete(known);
    const already = this.sent.get(id);
    if (already !== undefined && already !== approved) return "locked";
    this.answers[id] = { status: "resolved", payload: { approved } };
    if (!open.every((interrupt) => interrupt.id in this.answers))
      return "waiting";
    for (const interrupt of open)
      this.sent.set(
        interrupt.id,
        (this.answers[interrupt.id].payload as { approved: boolean }).approved,
      );
    const delivery = await sendResume(
      this.host,
      this.agent,
      open,
      this.answers,
    );
    if (delivery.ok) {
      this.answers = {};
      this.sent.clear();
    }
    return delivery;
  }
}
