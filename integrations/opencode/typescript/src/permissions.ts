import { BridgeError } from "./errors";
import type { Interrupt, ResumeEntry } from "@ag-ui/core";
import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";
import type { OpenCodeTransport } from "./transport";

export type PendingInterrupt = {
  id: string;
  expiresAt: string;
} & (
  | { kind: "permission"; request: PermissionRequest }
  | { kind: "question"; request: QuestionRequest }
);
export function toInterrupt(pending: PendingInterrupt): Interrupt {
  return {
    id: pending.id,
    reason: pending.kind,
    expiresAt: pending.expiresAt,
    message:
      pending.kind === "permission"
        ? `Allow ${pending.request.permission}?`
        : "OpenCode needs your answer",
    toolCallId: pending.request.tool?.callID,
    metadata:
      pending.kind === "permission"
        ? { patterns: pending.request.patterns }
        : { questions: pending.request.questions },
    responseSchema:
      pending.kind === "permission"
        ? {
            type: "object",
            properties: { reply: { enum: ["once", "always", "reject"] } },
            required: ["reply"],
            additionalProperties: false,
          }
        : {
            type: "object",
            properties: {
              answers: {
                type: "array",
                items: { type: "array", items: { type: "string" } },
              },
            },
            required: ["answers"],
            additionalProperties: false,
          },
  };
}
export async function answerInterrupt(
  transport: OpenCodeTransport,
  pending: PendingInterrupt,
  entry: ResumeEntry,
  sessionID: string,
  signal: AbortSignal,
  beforeReply: () => Promise<void>,
) {
  if (entry.interruptId !== pending.id)
    throw new BridgeError("Unknown or already answered interrupt");
  if (Date.parse(pending.expiresAt) <= Date.now())
    throw new BridgeError("Interrupt expired");
  const payload = entry.payload as Record<string, unknown> | undefined;
  if (pending.kind === "permission") {
    const reply = entry.status === "cancelled" ? "reject" : payload?.reply;
    if (reply !== "once" && reply !== "always" && reply !== "reject")
      throw new BridgeError("Permission reply must be once, always, or reject");
    const requests = await transport.permissions(signal);
    if (
      !requests.some(
        (r) => r.id === pending.request.id && r.sessionID === sessionID,
      )
    )
      throw new BridgeError(
        "Permission is stale or belongs to another session",
      );
    await beforeReply();
    await transport.replyPermission(pending.request.id, reply, signal);
    return reply === "reject";
  } else {
    const answers = entry.status === "cancelled" ? undefined : payload?.answers;
    if (entry.status !== "cancelled") {
      if (
        !Array.isArray(answers) ||
        answers.length !== pending.request.questions.length ||
        !answers.every(
          (a: unknown) =>
            Array.isArray(a) &&
            a.length > 0 &&
            a.every((x) => typeof x === "string"),
        )
      )
        throw new BridgeError(
          "One nonempty answer array is required per question",
        );
      for (const [i, q] of pending.request.questions.entries()) {
        if (!q.multiple && answers[i].length !== 1)
          throw new BridgeError("Question accepts only one answer");
        if (
          q.custom === false &&
          answers[i].some((a: string) => !q.options.some((o) => o.label === a))
        )
          throw new BridgeError("Unknown question option");
      }
    }
    const requests = await transport.questions(signal);
    if (
      !requests.some(
        (r) => r.id === pending.request.id && r.sessionID === sessionID,
      )
    )
      throw new BridgeError("Question is stale or belongs to another session");
    await beforeReply();
    await transport.replyQuestion(
      pending.request.id,
      answers as string[][] | undefined,
      signal,
    );
    return entry.status === "cancelled";
  }
}
