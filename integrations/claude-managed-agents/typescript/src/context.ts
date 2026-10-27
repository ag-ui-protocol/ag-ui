import type { RunAgentInput } from "@ag-ui/client";
import type { BetaManagedAgentsEventParams } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { SessionRecord } from "./types";
export class ContextDeliveryError extends Error {
  readonly code = "context_delivery_unsupported";
}

const HEADER =
  "AG-UI runtime context snapshot. Replace all earlier AG-UI runtime context snapshots with this complete list; an empty list clears them.\n";

/** Attach to the first request that can resume inference, never a synthetic user turn. */
export function attachContext(
  events: BetaManagedAgentsEventParams[],
  context: RunAgentInput["context"],
  record: SessionRecord,
) {
  const snapshot = JSON.stringify(
    (context ?? []).map(({ description, value }) => ({ description, value })),
  );
  if (
    !events.length ||
    snapshot === record.runtimeContext ||
    (snapshot === "[]" && record.runtimeContext === undefined)
  )
    return undefined;
  if (record.sessionThreadId)
    throw new ContextDeliveryError(
      "Runtime context cannot be injected into a native child thread.",
    );
  const results = events.filter(
    (event) => event.type !== "user.message" && event.type !== "system.message",
  );
  const companion = results.length ? results.at(-1)! : events.at(-1)!;
  if (
    !["user.message", "user.custom_tool_result", "user.tool_result"].includes(
      companion.type,
    )
  )
    throw new ContextDeliveryError(
      "Changed runtime context requires a user message or tool result; an approval alone cannot carry system context.",
    );
  const next = events[events.indexOf(companion) + 1];
  if (next?.type === "system.message")
    next.content.push({ type: "text", text: HEADER + snapshot });
  else
    events.splice(events.indexOf(companion) + 1, 0, {
      type: "system.message",
      content: [{ type: "text", text: HEADER + snapshot }],
    });
  return { snapshot, withResults: results.length > 0 };
}

/** A system event must stay with its preceding companion when batches are split. */
export function splitOutbound(events: BetaManagedAgentsEventParams[]) {
  const results: BetaManagedAgentsEventParams[] = [];
  const followUps: BetaManagedAgentsEventParams[] = [];
  let batch = followUps;
  for (const event of events) {
    if (event.type !== "system.message")
      batch = event.type === "user.message" ? followUps : results;
    batch.push(event);
  }
  return { results, followUps };
}

/** Recover our latest complete snapshot, including on native imports with no local record. */
export function restoreContext(content: unknown, record: SessionRecord): void {
  if (record.sessionThreadId || !Array.isArray(content)) return;
  const blocks = content.filter(
    (block) =>
      block?.type === "text" &&
      typeof block.text === "string" &&
      block.text.startsWith(HEADER),
  );
  if (blocks.length !== 1) return;
  const text = blocks[0].text as string;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(HEADER.length));
  } catch {
    return;
  } // Unrelated/malformed native system text is not an adapter snapshot.
  if (!Array.isArray(parsed)) return;
  const entries: { description: string; value: string }[] = [];
  for (const entry of parsed) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.description !== "string" ||
      typeof entry.value !== "string"
    )
      return;
    entries.push({ description: entry.description, value: entry.value });
  }
  record.runtimeContext = JSON.stringify(entries);
}
