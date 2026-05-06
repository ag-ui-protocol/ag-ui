import type { StandardSchemaV1 } from "@standard-schema/spec";
import { EventType } from "./events";

/**
 * Result of a single validation. Mirrors a subset of Standard Schema's result shape
 * so users can compose `AgentValidator` from any Standard-Schema-compliant library.
 */
export type ValidationResult<T> =
  | { success: true; value: T }
  | {
      success: false;
      issues: ReadonlyArray<{
        path?: ReadonlyArray<string | number>;
        message: string;
      }>;
    };

/**
 * The validator surface that AG-UI runtime code (HTTP transport, protobuf decoder)
 * uses to verify untrusted payloads.
 *
 * Implementations can be backed by zod, valibot, arktype, effect/schema, or
 * hand-written checks.
 */
export interface AgentValidator {
  validateEvent(
    input: unknown,
  ): ValidationResult<{ type: EventType; [k: string]: unknown }>;
}

/**
 * Adapt a Standard Schema to a synchronous `(input) => ValidationResult` function.
 * Throws if the schema is async (AG-UI's runtime path is synchronous).
 */
export const fromStandardSchema =
  <T>(schema: StandardSchemaV1<unknown, T>) =>
  (input: unknown): ValidationResult<T> => {
    const out = schema["~standard"].validate(input);
    if (out instanceof Promise) {
      throw new Error("AgentValidator does not support async validators");
    }
    if ("issues" in out && out.issues) {
      return {
        success: false,
        issues: out.issues.map((i) => ({
          path: i.path?.map((segment) => {
            // segment is PropertyKey | PathSegment ({ key: PropertyKey })
            if (typeof segment === "object" && segment !== null && "key" in segment) {
              return String((segment as { key: unknown }).key);
            }
            return String(segment);
          }),
          message: i.message,
        })),
      };
    }
    return { success: true, value: (out as { value: T }).value };
  };

const KNOWN_EVENT_TYPES = new Set<string>(Object.values(EventType));

/**
 * Minimal hand-written validator. Verifies the value is an object with a recognized
 * `type` field, and applies the field defaults that older zod schemas used to coerce.
 *
 * This is the default validator used by `proto` and `client/transform/http` so they
 * remain functional without any third-party schema library.
 */
export const defaultEventValidator: AgentValidator = {
  validateEvent(
    input: unknown,
  ): ValidationResult<{ type: EventType; [k: string]: unknown }> {
    if (input === null || typeof input !== "object") {
      return {
        success: false,
        issues: [{ message: "Event must be a non-null object" }],
      };
    }
    const candidate = input as Record<string, unknown>;
    const t = candidate.type;
    if (typeof t !== "string" || !KNOWN_EVENT_TYPES.has(t)) {
      return {
        success: false,
        issues: [
          { path: ["type"], message: `Unknown event type: ${String(t)}` },
        ],
      };
    }
    const value: Record<string, unknown> = { ...candidate, type: t as EventType };
    applyEventDefaults(value);
    return {
      success: true,
      value: value as { type: EventType; [k: string]: unknown },
    };
  },
};

const applyEventDefaults = (event: Record<string, unknown>): void => {
  switch (event.type) {
    case EventType.TEXT_MESSAGE_START:
      if (event.role === undefined) event.role = "assistant";
      break;
    case EventType.ACTIVITY_SNAPSHOT:
      if (event.replace === undefined) event.replace = true;
      break;
    case EventType.RUN_FINISHED:
      if (event.outcome === null) event.outcome = undefined;
      break;
  }
};
