import type {
  ActivityMessage,
  Message,
  MessagesSnapshotEvent,
  ToolCall,
  ToolMessage,
} from "@ag-ui/client";
import {
  assembleOps,
  BASIC_CATALOG_ID,
  validateA2UIComponents,
} from "@ag-ui/a2ui-toolkit";
import {
  getOperationSurfaceId,
  tryParseA2UIOperations,
  A2UI_OPERATIONS_KEY,
} from "./schema";
import type { A2UIMiddlewareConfig } from "./types";
import { resolveA2UIToolNames } from "./tools";

import { A2UIActivityType, A2UI_HISTORY_METADATA } from "./activity";
export { A2UI_HISTORY_METADATA } from "./activity";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function catalog(
  result: ToolMessage,
  args: Record<string, unknown>,
): string | undefined {
  const metadata = result.metadata?.[A2UI_HISTORY_METADATA];
  if (
    record(metadata) &&
    typeof metadata.catalogId === "string" &&
    metadata.catalogId
  )
    return metadata.catalogId;
  // Explicit legacy arguments are durable. Today's default is never a historical fallback.
  if (typeof args.catalogId === "string" && args.catalogId)
    return args.catalogId === "basic" ? BASIC_CATALOG_ID : args.catalogId;
  return record(metadata) && typeof metadata.fallbackCatalogId === "string"
    ? metadata.fallbackCatalogId
    : undefined;
}

function activity(
  id: string,
  content: Record<string, unknown>,
  toolCallId = id,
): ActivityMessage {
  return {
    id: `a2ui-surface-${id}`,
    role: "activity",
    activityType: A2UIActivityType,
    content,
    metadata: { [A2UI_HISTORY_METADATA]: { toolCallId } },
  };
}

/**
 * Derive presentation from durable direct calls and independent result envelopes.
 * Never settle or execute tools. Legacy nested calls have no durable parent link.
 * Activity scope is extended for transcript-only or scoped snapshots. Full
 * snapshots retain authority over all activities, including removals.
 */
export function projectA2UIHistory(
  event: MessagesSnapshotEvent,
  config: A2UIMiddlewareConfig = {},
): MessagesSnapshotEvent {
  const calls = new Map<string, ToolCall>();
  const results = new Map<string, ToolMessage>();
  for (const message of event.messages) {
    if (message.role === "assistant")
      for (const call of message.toolCalls ?? []) calls.set(call.id, call);
    if (message.role === "tool") results.set(message.toolCallId, message);
  }
  const names = resolveA2UIToolNames(config);
  const projected = new Map<string, ActivityMessage[]>();
  for (const [callId, call] of calls) {
    const result = results.get(callId);
    const isRender =
      names.has(call.function.name) ||
      record(result?.metadata?.[A2UI_HISTORY_METADATA]);
    if (result?.error && isRender) {
      projected.set(callId, [
        activity(callId, { status: "failed", error: result.error }),
      ]);
      continue;
    }
    const value = result ? parse(result.content) : undefined;
    if (record(value) && value.code === "a2ui_recovery_exhausted") {
      projected.set(callId, [
        activity(callId, {
          status: "failed",
          error: String(value.error ?? "A2UI generation failed"),
          attempts: value.attempts ?? [],
          maxAttempts: Array.isArray(value.attempts)
            ? value.attempts.length || 3
            : 3,
        }),
      ]);
      continue;
    }
    let operations =
      result && !result.error
        ? tryParseA2UIOperations(result.content)?.operations
        : undefined;
    if (!operations && isRender) {
      if (!result) {
        projected.set(callId, [activity(callId, { status: "building" })]);
        continue;
      }
      const args = parse(call.function.arguments);
      if (
        !record(args) ||
        typeof args.surfaceId !== "string" ||
        !Array.isArray(args.components)
      )
        continue;
      const catalogId = catalog(result, args);
      if (!catalogId) {
        // A restored surface must use the catalog it was painted with. Today's
        // configured default is not a record of that, so the card fails closed.
        projected.set(callId, [
          activity(callId, {
            status: "failed",
            error: "A2UI history has no durable catalogId",
          }),
        ]);
        continue;
      }
      const components = args.components.filter(record);
      const validation = validateA2UIComponents({
        components,
        validateBindings: false,
      });
      if (!validation.valid) {
        projected.set(callId, [
          activity(callId, {
            status: "failed",
            error: "Invalid A2UI components",
          }),
        ]);
        continue;
      }
      operations = assembleOps({
        intent: "create",
        surfaceId: args.surfaceId,
        catalogId,
        components,
        ...(record(args.data) ? { data: args.data } : {}),
      });
    }
    if (!operations?.length) continue;
    const bySurface = new Map<string, Array<Record<string, unknown>>>();
    for (const operation of operations) {
      const surfaceId = getOperationSurfaceId(operation) ?? "default";
      const group = bySurface.get(surfaceId) ?? [];
      group.push(operation);
      bySurface.set(surfaceId, group);
    }
    projected.set(
      callId,
      [...bySurface].map(([surfaceId, operations]) =>
        activity(
          bySurface.size === 1 ? callId : `${surfaceId}-${callId}`,
          { [A2UI_OPERATIONS_KEY]: operations },
          callId,
        ),
      ),
    );
  }
  const messages: Message[] = [];
  for (const message of event.messages) {
    if (
      message.role === "activity" &&
      message.activityType === A2UIActivityType
    )
      continue;
    messages.push(message);
    if (message.role === "assistant")
      for (const call of message.toolCalls ?? [])
        messages.push(...(projected.get(call.id) ?? []));
  }
  // Keep older client peers importable. Scoped reconciliation is supported by
  // clients that understand this package-owned metadata convention.
  const prior = event.metadata?.["@ag-ui/client"];
  const priorRecord = record(prior) ? prior : {};
  const scope = priorRecord.authoritativeActivityTypes;
  const priorTypes = Array.isArray(scope) && scope.every((type) => typeof type === "string")
    ? scope
    : undefined;
  // An unscoped snapshot containing activity already owns the complete set.
  // Keep that authority even if projection removes its last activity message.
  const ownsAll = scope === null ||
    (priorTypes === undefined && event.messages.some((message) => message.role === "activity"));
  return {
    ...event,
    messages,
    metadata: {
      ...event.metadata,
      "@ag-ui/client": {
        ...priorRecord,
        authoritativeActivityTypes: ownsAll ? null : [
          ...new Set([...(priorTypes ?? []), A2UIActivityType]),
        ],
      },
    },
  };
}
