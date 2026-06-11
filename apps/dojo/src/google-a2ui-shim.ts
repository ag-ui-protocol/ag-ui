/**
 * GoogleA2uiShim — disposable proof-point glue (NOT a product middleware).
 *
 * Bridges the Google A2UI Agent SDK build to the unmodified CopilotKit A2UI
 * middleware. Google's `send_a2ui_json_to_client` tool returns its validated payload
 * as `{"validated_a2ui_json": [<A2UI v0.9 messages>]}`. Each message is already shaped
 * like an `a2ui_operations` op (`{"version":"v0.9","createSurface|updateComponents|
 * updateDataModel":{...}}`), so this shim simply rewrites the TOOL_CALL_RESULT content
 * into the `{"a2ui_operations":[...]}` envelope that `@ag-ui/a2ui-middleware` already
 * recognizes and paints — without touching the published middleware package.
 *
 * Placement: `agent.use(new A2UIMiddleware({...}), new GoogleA2uiShim())`. Per the
 * client's `reduceRight` chaining, the LAST `.use()` arg is innermost (closest to the
 * agent), so this shim transforms the raw tool result BEFORE the A2UI middleware sees
 * it. The `{"error":...}` failure shape is passed through unchanged (no surface paints;
 * recovery, if any, is model-driven — Google's SDK has no bounded retry loop).
 */
import type { AbstractAgent } from "@ag-ui/client";
import { Middleware } from "@ag-ui/client";
import { EventType, type BaseEvent, type RunAgentInput, type ToolCallResultEvent } from "@ag-ui/core";
import { map, type Observable } from "rxjs";

const GOOGLE_VALIDATED_KEY = "validated_a2ui_json";

export class GoogleA2uiShim extends Middleware {
  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    return this.runNext(input, next).pipe(
      map((event) => {
        if (event.type !== EventType.TOOL_CALL_RESULT) return event;
        const result = event as ToolCallResultEvent;
        const ops = extractValidatedOps(result.content);
        if (!ops) return event; // not a Google A2UI result (or an {"error":...}) — pass through
        return { ...result, content: JSON.stringify({ a2ui_operations: ops }) };
      }),
    );
  }
}

/**
 * If `content` is (or wraps) `{"validated_a2ui_json": [...]}`, return the message array
 * normalized to A2UI operations; otherwise null. Tolerates double-encoding (a JSON
 * string whose value is itself the JSON object) the same way the middleware does.
 */
function extractValidatedOps(content: unknown): Array<Record<string, unknown>> | null {
  let value: unknown = content;
  for (let i = 0; i < 2 && typeof value === "string"; i++) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const validated = (value as Record<string, unknown>)[GOOGLE_VALIDATED_KEY];
  if (!Array.isArray(validated)) return null;
  // Messages already carry `version` + the op key; ensure each is a plain object.
  return validated.filter((m): m is Record<string, unknown> => !!m && typeof m === "object");
}
