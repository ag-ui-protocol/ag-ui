/**
 * Secure Tools Configuration
 *
 * This file defines the tool specifications and exports everything needed
 * for both client-side hooks and server-side middleware.
 *
 * Import from here in both:
 * - Server: agents.ts for middleware setup
 * - Client: React components for useFrontendTool
 */
import { z } from "zod";
import { createSecureToolHooks, secureToolsMiddleware } from "@ag-ui/client";
import type { AbstractAgent } from "@ag-ui/client";
import type { Parameter } from "@copilotkit/shared";

// =============================================================================
// TOOL SPECIFICATIONS
// =============================================================================

/**
 * Define all your secure tool specs here.
 * This is the single source of truth for tool definitions.
 */
const toolSpecs = {
  change_background: {
    name: "change_background" as const,
    description:
      "Change the background color of the chat. Can be anything that the CSS background attribute accepts.",
    parameters: z.object({
      background: z.string().describe("The background color or gradient."),
    }),
  },
  // Add more tools here as needed
  // Note: Tools NOT listed here will be blocked by the middleware
} as const;

// =============================================================================
// EXPORTS FOR CLIENT AND SERVER
// =============================================================================

/**
 * Secure tool hooks - use these in your React components.
 */
const {
  createFrontendToolConfig,
  getMiddlewareConfig,
  getToolSpec,
  toolSpecs: specs,
} = createSecureToolHooks(toolSpecs);

// Re-export for client use
export { createFrontendToolConfig, getToolSpec };
export { specs as toolSpecs };

/**
 * Type-safe tool names
 */
export type SecureToolName = keyof typeof toolSpecs;

/**
 * Infer the arguments type for a specific tool.
 */
export type SecureToolArgs<K extends SecureToolName> = z.infer<
  (typeof toolSpecs)[K]["parameters"]
>;

// =============================================================================
// V1.X COPILOTKIT COMPATIBILITY LAYER
// =============================================================================

/**
 * For v1.x CopilotKit (which uses Parameter[] format instead of Zod).
 * These are derived from the same source of truth as the middleware specs.
 */
const v1xToolParameters: Record<SecureToolName, Parameter[]> = {
  change_background: [
    {
      name: "background",
      type: "string",
      description: "The background color or gradient.",
      required: true,
    },
  ],
};

/**
 * Get a complete v1.x tool definition with injected values from the shared specs.
 * Use this with CopilotKit v1.x's useFrontendTool hook.
 *
 * @example
 * ```tsx
 * import { getV1xToolConfig, SecureToolArgs } from "@/lib/secure-tools";
 *
 * const config = getV1xToolConfig("change_background");
 * useFrontendTool({
 *   ...config,
 *   handler: (args) => {
 *     const { background } = args as SecureToolArgs<"change_background">;
 *     setBackground(background);
 *   },
 * });
 * ```
 */
export function getV1xToolConfig<K extends SecureToolName>(
  toolName: K,
): {
  name: K;
  description: string;
  parameters: Parameter[];
} {
  const spec = getToolSpec(toolName);
  const parameters = v1xToolParameters[toolName] ?? [];

  return {
    name: toolName,
    description: spec.description,
    parameters,
  };
}

// =============================================================================
// MIDDLEWARE HELPER (for server-side use)
// =============================================================================

/**
 * Wrap an agent with SecureToolsMiddleware.
 * Use this in your agents.ts or wherever you configure agents.
 *
 * @example
 * ```ts
 * import { wrapWithSecureTools } from "@/lib/secure-tools";
 *
 * const agent = wrapWithSecureTools(new HttpAgent({ url: "..." }));
 * ```
 */
export function wrapWithSecureTools<T extends AbstractAgent>(
  agent: T,
  options?: {
    /** Custom validation callback - runs AFTER allowedTools check */
    isToolAllowed?: Parameters<typeof secureToolsMiddleware>[0]["isToolAllowed"];
    /** Custom deviation handler */
    onDeviation?: Parameters<typeof secureToolsMiddleware>[0]["onDeviation"];
  },
): T {
  agent.use(
    secureToolsMiddleware({
      ...getMiddlewareConfig(),
      isToolAllowed: options?.isToolAllowed,
      onDeviation: options?.onDeviation ?? ((deviation) => {
        console.warn(
          `\n🚨 [SecureTools] TOOL CALL BLOCKED 🚨`,
          `\n   Tool: ${deviation.toolCall.toolCallName}`,
          `\n   Reason: ${deviation.reason}`,
          `\n   Message: ${deviation.message}`,
          `\n   Thread: ${deviation.context.threadId}`,
          `\n   Timestamp: ${new Date(deviation.timestamp).toISOString()}`
        );
      }),
    })
  );
  return agent;
}

