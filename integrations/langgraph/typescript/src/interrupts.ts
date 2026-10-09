import type { Interrupt as LangGraphInterrupt } from "@langchain/langgraph-sdk";
import type { Interrupt as AGUIInterrupt, ResumeEntry } from "@ag-ui/core";

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function langGraphInterruptToAGUI(
  lg: LangGraphInterrupt,
): AGUIInterrupt {
  const raw = lg.value;
  const dict = isPlainObject(raw) ? raw : null;

  if (!lg.id) {
    throw new Error(
      "LangGraph Interrupt is missing `id`. The id is required to match a " +
        "resume answer back to the originating step; synthesising an id here " +
        "would silently misroute multi-interrupt resumes. Upgrade to " +
        "@langchain/langgraph-sdk that always populates Interrupt.id.",
    );
  }
  const id = lg.id;
  const reason = (dict?.reason as string | undefined) ?? "langgraph:interrupt";

  const message =
    typeof raw === "string" ? raw : (dict?.message as string | undefined);
  const toolCallId =
    (dict?.toolCallId as string | undefined) ??
    (dict?.tool_call_id as string | undefined);
  const responseSchema =
    (dict?.responseSchema as Record<string, unknown> | undefined) ??
    (dict?.response_schema as Record<string, unknown> | undefined);
  const expiresAt =
    (dict?.expiresAt as string | undefined) ??
    (dict?.expires_at as string | undefined);

  const metadata: Record<string, unknown> = {
    langgraph: {
      raw,
      ns: (lg as { ns?: string[] }).ns,
      resumable: (lg as { resumable?: boolean }).resumable,
      when: (lg as { when?: string }).when,
    },
  };

  return {
    id,
    reason,
    ...(message !== undefined ? { message } : {}),
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    ...(responseSchema !== undefined ? { responseSchema } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    metadata,
  };
}

export function langGraphInterruptsToAGUI(
  list: readonly LangGraphInterrupt[],
): AGUIInterrupt[] {
  return list.map(langGraphInterruptToAGUI);
}

export const DEFAULT_RESUME_SENTINEL_CANCELLED = "__agui_cancelled__";
/** @deprecated Native resume commands now map interrupt IDs directly to answers. */
export const DEFAULT_RESUME_SENTINEL_MAP = "__agui_resume_map__";

/** Check checkpoint state rather than relying on a client's in-memory pending list. */
export function validateAguiResume(
  entries: readonly ResumeEntry[],
  openInterrupts: readonly AGUIInterrupt[],
): void {
  const openIds = new Set(openInterrupts.map((interrupt) => interrupt.id));
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.interruptId)) {
      throw new Error(`Duplicate resume interrupt ID: ${entry.interruptId}`);
    }
    if (!openIds.has(entry.interruptId)) {
      throw new Error(
        `Resume interrupt ID is not open in the checkpoint: ${entry.interruptId}`,
      );
    }
    seen.add(entry.interruptId);
  }
}

export function buildLgCommandResumeFromAgui(
  entries: readonly ResumeEntry[],
): Record<string, unknown> {
  // Native LangGraph maps interrupt IDs directly to answers, even when only
  // one of several parallel interrupts is being answered.
  return Object.fromEntries(
    entries.map((entry) => [
      entry.interruptId,
      entry.status === "resolved"
        ? (entry.payload ?? null)
        : {
            [DEFAULT_RESUME_SENTINEL_CANCELLED]: true,
            interrupt_id: entry.interruptId,
          },
    ]),
  );
}
