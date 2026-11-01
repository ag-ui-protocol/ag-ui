import type {
  Interrupt,
  Metadata,
  ResumeEntry,
  RunFinishedEvent,
  RunFinishedOutcome,
} from "@ag-ui/core";

export function getRunOutcome(event: RunFinishedEvent): RunFinishedOutcome | undefined {
  return event.outcome;
}

export function isInterruptExpired(interrupt: Interrupt, now: Date = new Date()): boolean {
  if (interrupt.expiresAt === undefined) return false;
  return new Date(interrupt.expiresAt) <= now;
}

/**
 * How long an interrupt that arrives without an `expiresAt` stays
 * answerable. Producers may omit the expiry, and an interrupt with no
 * expiry never expires — so every later run on its thread fails the
 * resume-coverage check, permanently (#2525). When the client records
 * such an interrupt it stamps this bounded default expiry instead; once
 * the window passes, the interrupt is expired and can be cancelled to
 * release the thread, like any other expired interrupt.
 */
export const DEFAULT_INTERRUPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Maximum number of pending interrupts the client tracks per thread.
 * Interrupts beyond the cap in a single outcome are not tracked, so a
 * producer cannot grow the tracked list without bound (#2525).
 */
export const MAX_PENDING_INTERRUPTS = 100;

type ResumeResponse =
  | { status: "resolved"; payload?: unknown; metadata?: Metadata }
  | { status: "cancelled"; metadata?: Metadata };

export function buildResumeArray(
  interrupts: Interrupt[],
  responses: Record<string, ResumeResponse>,
): ResumeEntry[] {
  const openIds = new Set(interrupts.map((i) => i.id));
  const responseIds = new Set(Object.keys(responses));

  const missing = [...openIds].filter((id) => !responseIds.has(id));
  if (missing.length > 0) {
    throw new Error(`buildResumeArray: missing responses for open interrupts: ${missing.join(", ")}`);
  }

  const unknown = [...responseIds].filter((id) => !openIds.has(id));
  if (unknown.length > 0) {
    throw new Error(`buildResumeArray: responses reference unknown interrupt ids: ${unknown.join(", ")}`);
  }

  return interrupts.map((i) => {
    const r = responses[i.id];
    const entry: ResumeEntry = { interruptId: i.id, status: r.status };
    if (r.status === "resolved" && r.payload !== undefined) entry.payload = r.payload;
    if (r.metadata !== undefined) entry.metadata = r.metadata;
    return entry;
  });
}
