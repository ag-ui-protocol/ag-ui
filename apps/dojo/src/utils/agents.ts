import type { AbstractAgent } from "@ag-ui/client";

/**
 * Helper to map feature keys to agent instances using a builder function.
 * Reduces repetition when all agents follow the same pattern with different parameters.
 * 
 * The builder function receives the value type from the mapping.
 * This allows flexible parameter types - strings, objects, arrays, or any consistent shape.
 * 
 * Uses `const` type parameter to preserve exact literal keys from the mapping.
 */
export function mapAgents<const T extends Record<string, unknown>>(
  builder: (params: T[keyof T]) => AbstractAgent,
  mapping: T
): { [K in keyof T]: AbstractAgent } {
  return Object.fromEntries(
    Object.entries(mapping).map(([key, params]) => [key, builder(params as T[keyof T])])
  ) as { [K in keyof T]: AbstractAgent };
}
