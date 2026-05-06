import type { StandardSchemaV1 } from "@standard-schema/spec";
import { EventType } from "./events";

/**
 * Result of a single validation. Mirrors a subset of Standard Schema's result
 * shape so users can compose `AgentValidator` from any Standard-Schema-compliant
 * library.
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
 * The validator surface that AG-UI runtime code (HTTP transport, protobuf
 * decoder) uses to verify untrusted payloads. Implementations can be backed by
 * zod, valibot, arktype, effect/schema, or hand-written checks.
 *
 * For the default zod-backed implementation, import `zodValidator` from
 * `@ag-ui/core/schemas` (which has zod as an optional peer dependency).
 */
export interface AgentValidator {
  validateEvent(
    input: unknown,
  ): ValidationResult<{ type: EventType; [k: string]: unknown }>;
}

/**
 * Adapt a Standard Schema (zod 3.24+, zod 4, valibot, arktype, ...) to a
 * synchronous validation function. Throws if the schema is async — AG-UI's
 * runtime path is synchronous.
 */
export const fromStandardSchema =
  <T>(schema: StandardSchemaV1<unknown, T>) =>
  (input: unknown): ValidationResult<T> => {
    const out = schema["~standard"].validate(input);
    if (out instanceof Promise) {
      throw new Error("AgentValidator does not support async validators");
    }
    if ("issues" in out && out.issues && out.issues.length > 0) {
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
