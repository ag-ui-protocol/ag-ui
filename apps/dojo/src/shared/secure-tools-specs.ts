/**
 * Shared Tool Specifications for Secure Tools Demo
 *
 * This file defines the tool specifications that are shared between:
 * 1. Client-side (useFrontendTool) - for type-safe handlers and rendering
 * 2. Server-side (secureToolsMiddleware) - for validation and security
 *
 * Using createSecureToolHooks ensures:
 * - Single source of truth (no duplication)
 * - Compile-time type safety for handlers
 * - Automatic middleware configuration
 *
 * NOTE: This demo uses the v1.x CopilotKit API which uses Parameter[] format.
 * For apps using v2.x (@copilotkitnext), you can use Zod schemas directly.
 */
import { z } from "zod";
import { createSecureToolHooks, type ToolSpec } from "@ag-ui/client";
import type { Parameter } from "@copilotkit/shared";

// =============================================================================
// TOOL SPECIFICATIONS (Used by middleware and for type safety)
// =============================================================================

/**
 * Tool specifications with Zod schemas for type inference.
 * These are used by the middleware for validation.
 */
export const secureToolSpecs = {
  change_background: {
    name: "change_background" as const,
    description:
      "Change the background color of the chat. Can be anything that the CSS background attribute accepts.",
    parameters: z.object({
      background: z.string().describe("The background color or gradient."),
    }),
  },
  // Note: "say_hello" is intentionally NOT defined here to demonstrate blocking
} as const;

/**
 * Secure tool hooks created from the shared specs.
 */
export const {
  getMiddlewareConfig,
  getToolSpec,
  toolSpecs,
} = createSecureToolHooks(secureToolSpecs);

// =============================================================================
// V1.X COPILOTKIT COMPATIBILITY LAYER
// =============================================================================

/**
 * For v1.x CopilotKit, we need to use Parameter[] format.
 * These definitions are derived from the same source of truth as the middleware specs.
 */
export const v1xToolParameters = {
  change_background: [
    {
      name: "background",
      type: "string",
      description: "The background color or gradient.",
      required: true,
    },
  ] as Parameter[],
} as const;

/**
 * Get a complete v1.x tool definition with injected values from the shared specs.
 * This ensures consistency between client and middleware.
 */
export function getV1xToolConfig<K extends keyof typeof secureToolSpecs>(
  toolName: K,
): {
  name: K;
  description: string;
  parameters: Parameter[];
} {
  const spec = getToolSpec(toolName);
  const parameters = v1xToolParameters[toolName as keyof typeof v1xToolParameters] ?? [];

  return {
    name: toolName,
    description: spec.description,
    parameters,
  };
}

// =============================================================================
// TYPE EXPORTS
// =============================================================================

/**
 * Type-safe tool names from the specs.
 */
export type SecureToolName = keyof typeof secureToolSpecs;

/**
 * Infer the arguments type for a specific tool.
 */
export type SecureToolArgs<K extends SecureToolName> = z.infer<
  (typeof secureToolSpecs)[K]["parameters"]
>;
