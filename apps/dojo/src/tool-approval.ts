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

// The batch a click should resume, built from the agent's pending interrupts
// at click time (not from a render-time snapshot). Returns undefined when the
// clicked interrupt is no longer pending, so a click on a card whose interrupt
// was already resolved sends nothing.
export function batchAtClick(
  pending: readonly PendingApproval[],
  skipped: ReadonlySet<string>,
  id: string,
): { id: string; answerable: boolean }[] | undefined {
  const batch = pending.flatMap((entry) =>
    entry.id === undefined || skipped.has(entry.id)
      ? []
      : [{ id: entry.id, answerable: !entry.unsupported }],
  );
  return batch.some((entry) => entry.id === id) ? batch : undefined;
}

// Whether a response schema accepts `{ approved: boolean }` as the answer, so
// the card can offer both Approve and Reject. This is an allowlist, not a
// search for forbidden keywords: the schema is accepted only if it uses
// nothing but the keywords below, which makes both `{ approved: true }` and
// `{ approved: false }` valid by construction. Anything else (`const`, `enum`,
// `allOf`, `anyOf`, `oneOf`, `not`, `if`, `$ref`, `minProperties`, ...) at the
// root or on `approved` is treated as unsupported rather than guessed at.
// CAO's own schema passes, with or without `editedArgs`
// (run_plane.py:159-177 at the pinned commit).
const ROOT_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "title",
  "description",
]);
const APPROVED_KEYWORDS = new Set(["type", "title", "description"]);

const onlyKeywords = (value: object, allowed: Set<string>) =>
  Object.keys(value).every((key) => allowed.has(key));

export function acceptsApproved(schema: unknown): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    return false;
  if (!onlyKeywords(schema, ROOT_KEYWORDS)) return false;
  const { type, properties, required } = schema as {
    type?: unknown;
    properties?: unknown;
    required?: unknown;
  };
  if (type !== undefined && type !== "object") return false;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  )
    return false;
  const approved = (properties as Record<string, unknown>).approved;
  if (!approved || typeof approved !== "object" || Array.isArray(approved))
    return false;
  if (!onlyKeywords(approved, APPROVED_KEYWORDS)) return false;
  if ((approved as { type?: unknown }).type !== "boolean") return false;
  // Only `approved` may be required: the page sends nothing else.
  return (
    required === undefined ||
    (Array.isArray(required) && required.every((key) => key === "approved"))
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
    // The run id this attempt asks for. CopilotKitCoreRunAgentParams.runId
    // forwards it to the AG-UI agent, so this attempt's RUN_FINISHED can be
    // told apart from any other run on the same agent.
    runId: string;
  }): Promise<unknown>;
}

export interface ResumeAgent {
  agentId?: string;
  // The agent's own event subscription, used to read RUN_FINISHED.result of
  // the resume run (CopilotKit's runAgent does not hand it back for an
  // interrupt outcome).
  subscribe(subscriber: {
    onRunFinishedEvent?: (params: {
      event: { result?: unknown; runId?: string };
      outcome?: string;
    }) => void | Promise<void>;
  }): { unsubscribe(): void };
}

// An answer CAO skipped: the run plane lists it in RUN_FINISHED
// `result.skippedResume` with reason "expired" (the interrupt timed out, no
// keystroke was sent) or "unknown" (it no longer holds the id, for example
// because it evicted it). Already resolved ids are skipped quietly and are
// not listed.
export interface SkippedResume {
  interruptId: string;
  reason: string;
}

export function readSkippedResume(result: unknown): SkippedResume[] {
  const list = (result as { skippedResume?: unknown } | null | undefined)
    ?.skippedResume;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) =>
    entry &&
    typeof entry.interruptId === "string" &&
    typeof entry.reason === "string"
      ? [{ interruptId: entry.interruptId, reason: entry.reason }]
      : [],
  );
}

export type Answers = Record<string, { status: "resolved"; payload: unknown }>;

export type Delivery =
  | {
      ok: true;
      skipped?: SkippedResume[];
      // One message per answer CAO skipped; those cards are removed.
      notices?: { id: string; message: string }[];
    }
  | { ok: false; message: string };

// What the page says about an answer CAO skipped. `priorSend` is whether this
// answer had already been sent in an earlier attempt.
export function skippedNotice(reason: string, priorSend: boolean): string {
  if (reason === "unknown" && priorSend)
    return "Not confirmed: this request is no longer held by the agent, so your earlier answer may already have been applied. It will not be sent again.";
  if (reason === "unknown")
    return "Not delivered: the server no longer knows this request. It will not be sent again.";
  // CAO's expire() can mark an interrupt expired while its delivery worker is
  // still running, and that worker then commits the decision, so after an
  // earlier send "expired" does not prove the answer was not applied.
  if (priorSend)
    return "Not confirmed: this request expired, so your earlier answer may already have been applied. It will not be sent again.";
  return "Not delivered: this request expired before your answer reached the agent. It will not be sent again.";
}

// Sends one resume run that answers every interrupt in `interrupts`. It counts
// as delivered only if this attempt's own run (matched by the runId it asked
// for) finishes without a run error for
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
  const runId = crypto.randomUUID();
  let skipped: SkippedResume[] = [];
  let finished = false;
  const finishWatch = agent.subscribe({
    onRunFinishedEvent: ({ event, outcome }) => {
      // A cancelled run did not carry the answer to the agent.
      if (outcome === "cancelled") return;
      // Only this attempt's own run confirms delivery: another run on the same
      // agent can finish while this one is pending.
      if (event.runId !== runId) return;
      finished = true;
      skipped = readSkippedResume(event.result);
    },
  });
  const subscription = host.subscribe({
    onError: ({ error, context }) => {
      if (context?.agentId === undefined || context.agentId === agent.agentId)
        errors.push(error);
    },
  });
  try {
    await host.runAgent({
      agent,
      runId,
      resume: buildResumeArray(
        interrupts as Parameters<typeof buildResumeArray>[0],
        answers,
      ),
    });
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  } finally {
    subscription.unsubscribe();
    finishWatch.unsubscribe();
  }
  // No error is not enough: when the user clicks Stop, the client's abort path
  // (@copilotkit/core withAbortErrorHandling, which turns an AbortError into an
  // empty stream) lets runAgent resolve with neither RUN_FINISHED nor an
  // error. Only this attempt's own RUN_FINISHED confirms delivery.
  if (errors.length === 0 && !finished)
    return {
      ok: false,
      message:
        "the run ended before it finished, so delivery is unconfirmed (was it stopped?)",
    };
  return errors.length === 0
    ? { ok: true, ...(skipped.length > 0 ? { skipped } : {}) }
    : { ok: false, message: errors[0].message };
}

// Builds the library's answers record with no prototype, so an interrupt id
// such as `__proto__` becomes an own key instead of setting the prototype.
function toAnswers(answers: ReadonlyMap<string, boolean>): Answers {
  const record: Answers = Object.create(null);
  for (const [id, approved] of answers)
    record[id] = { status: "resolved", payload: { approved } };
  return record;
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
//
// An id CAO no longer holds does not block the batch: its run plane skips a
// resume entry for an unknown or already resolved interrupt with a warning and
// carries on with the rest. The client refuses a run that leaves a pending
// interrupt out, so an id stays in the retry until the agent's pending list
// (the `open` argument) drops it, which happens once a run reports the
// interrupts still pending. Ids the agent no longer lists are not resent.
export class ApprovalSession {
  // A Map, so ids such as `constructor` or `__proto__` are ordinary keys.
  private answers = new Map<string, boolean>();
  private sent = new Map<string, boolean>();
  // Interrupts CAO skipped (expired, or no longer held). They are never
  // answered or sent again, and no card is shown for them.
  private gone = new Set<string>();

  constructor(
    private readonly host: ResumeHost,
    private readonly agent: ResumeAgent,
  ) {}

  // The answers already sent (delivered or not) for the open interrupts.
  sentAnswers(): ReadonlyMap<string, boolean> {
    return new Map(this.sent);
  }

  // Ids CAO skipped, so the page can leave their cards out.
  skippedIds(): ReadonlySet<string> {
    return new Set(this.gone);
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
    open = open.filter((interrupt) => !this.gone.has(interrupt.id));
    if (this.gone.has(id)) return "waiting";
    const openIds = new Set(open.map((interrupt) => interrupt.id));
    for (const known of [...this.answers.keys()])
      if (!openIds.has(known)) this.answers.delete(known);
    for (const known of [...this.sent.keys()])
      if (!openIds.has(known)) this.sent.delete(known);
    const already = this.sent.get(id);
    if (already !== undefined && already !== approved) return "locked";
    this.answers.set(id, approved);
    if (!open.every((interrupt) => this.answers.has(interrupt.id)))
      return "waiting";
    const priorSend = new Set(this.sent.keys());
    for (const interrupt of open)
      this.sent.set(interrupt.id, this.answers.get(interrupt.id) as boolean);
    const delivery = await sendResume(
      this.host,
      this.agent,
      open,
      toAnswers(this.answers),
    );
    if (delivery.ok) {
      this.answers.clear();
      this.sent.clear();
      const notices = (delivery.skipped ?? []).map((entry) => {
        this.gone.add(entry.interruptId);
        return {
          id: entry.interruptId,
          message: skippedNotice(
            entry.reason,
            priorSend.has(entry.interruptId),
          ),
        };
      });
      if (notices.length > 0) return { ...delivery, notices };
    }
    return delivery;
  }
}
