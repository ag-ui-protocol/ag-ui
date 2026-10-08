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
export const DEFAULT_RESUME_SENTINEL_MAP = "__agui_resume_map__";

export function buildLgCommandResumeFromAgui(
  entries: readonly ResumeEntry[],
): unknown {
  if (entries.length === 1) {
    const e = entries[0];
    if (e.status === "resolved") return e.payload;
    return {
      [DEFAULT_RESUME_SENTINEL_CANCELLED]: true,
      interrupt_id: e.interruptId,
    };
  }
  return {
    [DEFAULT_RESUME_SENTINEL_MAP]: Object.fromEntries(
      entries.map((e) => [
        e.interruptId,
        { status: e.status, payload: e.payload ?? null },
      ]),
    ),
  };
}
