import type { AbstractAgent } from "@ag-ui/client";
import type { Mutable } from "../types/utils";

/**
 * Helper to map feature keys to agent instances using a builder function.
 * Reduces repetition when all agents follow the same pattern with different parameters.
 * 
 * The builder function receives the value type from the mapping (`Mutable<T[keyof T]>`).
 * This allows flexible parameter types - strings, objects, arrays, or any consistent shape.
 * 
 * Uses `const` type parameter to preserve exact literal keys from the mapping.
 * The `Mutable` type removes `readonly` from values (added by `const T`) for ergonomics.
 * The return type `{ -readonly [K in keyof T]: AbstractAgent }` removes the readonly
 * modifier added by `const T` to match the expected AgentsMap type.
 */
export function mapAgents<const T extends Record<string, unknown>>(
  builder: (params: Mutable<T[keyof T]>) => AbstractAgent,
  mapping: T
): { -readonly [K in keyof T]: AbstractAgent } {
  return Object.fromEntries(
    Object.entries(mapping).map(([key, params]) => [key, builder(params as Mutable<T[keyof T]>)])
  ) as { -readonly [K in keyof T]: AbstractAgent };
}
