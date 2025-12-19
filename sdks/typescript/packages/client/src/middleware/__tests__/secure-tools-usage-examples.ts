/**
 * Usage Examples for SecureToolsMiddleware
 *
 * This file demonstrates various ways to use the secure tools middleware
 * for agent tool security. These examples are for documentation purposes
 * and show real-world usage patterns.
 */

import { HttpAgent } from "@/agent";
import {
  secureToolsMiddleware,
  createToolSpecs,
  type ToolSpec,
  type ToolDeviation,
  type AgentSecurityContext,
  type ToolCallInfo,
} from "@/middleware/secure-tools";
import type { Tool } from "@ag-ui/core";

// =============================================================================
// EXAMPLE 1: Simple Allowlist (Most Common Use Case)
// =============================================================================

/**
 * The simplest and most common usage: define a list of allowed tools with
 * their full specifications. Only tools matching these specs exactly will
 * be allowed to execute.
 */
export function simpleAllowlistExample() {
  const agent = new HttpAgent({ url: "https://api.example.com/agent" });

  // Define allowed tools with full specifications
  const allowedTools: ToolSpec[] = [
    {
      name: "getWeather",
      description: "Get current weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
    {
      name: "searchDocuments",
      description: "Search internal documents",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
    },
  ];

  // Apply the middleware - any tool not matching these specs will be blocked
  agent.use(
    secureToolsMiddleware({
      allowedTools,
    }),
  );

  return agent;
}

// =============================================================================
// EXAMPLE 2: Converting from Existing Tools
// =============================================================================

/**
 * If you already have Tool definitions from your agent configuration,
 * you can convert them to ToolSpecs for the middleware.
 */
export function convertExistingToolsExample() {
  const agent = new HttpAgent({ url: "https://api.example.com/agent" });

  // Existing tool definitions from your configuration
  const existingTools: Tool[] = [
    {
      name: "calculator",
      description: "Perform arithmetic operations",
      parameters: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["add", "subtract", "multiply", "divide"] },
          a: { type: "number" },
          b: { type: "number" },
        },
        required: ["operation", "a", "b"],
      },
    },
    {
      name: "translator",
      description: "Translate text between languages",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
        },
        required: ["text", "to"],
      },
    },
  ];

  // Convert and apply
  agent.use(
    secureToolsMiddleware({
      allowedTools: createToolSpecs(existingTools),
    }),
  );

  return agent;
}

// =============================================================================
// EXAMPLE 3: Custom Validation Callback
// =============================================================================

/**
 * For more complex security policies, use the isToolAllowed callback.
 * This enables per-user, per-tenant, time-based, or other dynamic policies.
 */
export function customValidationExample() {
  const agent = new HttpAgent({ url: "https://api.example.com/agent" });

  // Mock user/tenant context (would come from your auth system)
  const currentUser = {
    id: "user-123",
    role: "analyst",
    permissions: ["read", "search"],
    tenantId: "tenant-456",
  };

  // Define tool permissions by role
  const toolPermissions: Record<string, string[]> = {
    admin: ["*"], // Admin can use all tools
    analyst: ["searchDocuments", "getWeather", "calculator"],
    viewer: ["searchDocuments"],
  };

  agent.use(
    secureToolsMiddleware({
      isToolAllowed: (toolCall: ToolCallInfo, _context: AgentSecurityContext) => {
        const allowedForRole = toolPermissions[currentUser.role] ?? [];

        // Check if user's role allows this tool
        if (allowedForRole.includes("*")) {
          return true;
        }

        return allowedForRole.includes(toolCall.toolCallName);
      },
    }),
  );

  return agent;
}

// =============================================================================
// EXAMPLE 4: Combined Allowlist + Custom Rules
// =============================================================================

/**
 * Combine allowedTools (for spec validation) with isToolAllowed (for
 * additional policy checks). Both must pass for a tool to be allowed.
 */
export function combinedSecurityExample() {
  const agent = new HttpAgent({ url: "https://api.example.com/agent" });

  // Define allowed tools
  const allowedTools: ToolSpec[] = [
    {
      name: "sensitiveDataAccess",
      description: "Access sensitive customer data",
      parameters: {
        type: "object",
        properties: {
          customerId: { type: "string" },
          dataType: { type: "string" },
        },
        required: ["customerId", "dataType"],
      },
    },
    {
      name: "publicDataAccess",
      description: "Access public data",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
  ];

  agent.use(
    secureToolsMiddleware({
      // First: tool must match one of these specs
      allowedTools,

      // Second: additional policy checks
      isToolAllowed: (toolCall: ToolCallInfo, context: AgentSecurityContext) => {
        // Example: time-based restriction for sensitive tools
        if (toolCall.toolCallName === "sensitiveDataAccess") {
          const hour = new Date().getHours();
          // Only allow during business hours (9 AM - 5 PM)
          if (hour < 9 || hour > 17) {
            return false;
          }
        }

        // Example: rate limiting check
        const userId = context.metadata?.userId as string | undefined;
        if (userId) {
          // Would check against a rate limiter here
          // return !rateLimiter.isExceeded(userId, toolCall.toolCallName);
        }

        return true;
      },

      // Pass metadata for use in callbacks
      metadata: {
        userId: "user-123",
        tenantId: "tenant-456",
      },
    }),
  );

  return agent;
}

// =============================================================================
// EXAMPLE 5: Custom Deviation Handling (Audit Logging)
// =============================================================================

/**
 * For enterprise deployments, you often need custom logging/alerting
 * when tool calls are blocked. Use onDeviation for this.
 */
export function auditLoggingExample() {
  const agent = new HttpAgent({ url: "https://api.example.com/agent" });

  // Mock audit logger (would be your actual logging system)
  const auditLogger = {
    log: (event: string, data: Record<string, unknown>) => {
      console.log(`[AUDIT] ${event}:`, JSON.stringify(data, null, 2));
    },
  };

  // Mock alerting service
  const alertService = {
    sendAlert: async (severity: string, message: string, details: Record<string, unknown>) => {
      console.log(`[ALERT ${severity}] ${message}`, details);
    },
  };

  const allowedTools: ToolSpec[] = [
    {
      name: "safeOperation",
      description: "A safe operation",
      parameters: { type: "object", properties: {} },
    },
  ];

  agent.use(
    secureToolsMiddleware({
      allowedTools,
      metadata: {
        userId: "user-123",
        sessionId: "session-abc",
        requestId: "req-xyz",
      },
      onDeviation: async (deviation: ToolDeviation) => {
        // Log to audit trail
        auditLogger.log("TOOL_BLOCKED", {
          timestamp: new Date(deviation.timestamp).toISOString(),
          userId: deviation.context.metadata?.userId,
          sessionId: deviation.context.metadata?.sessionId,
          toolName: deviation.toolCall.toolCallName,
          reason: deviation.reason,
          message: deviation.message,
          threadId: deviation.context.threadId,
          runId: deviation.context.runId,
        });

        // High-severity alert for certain deviation types
        if (
          deviation.reason === "SPEC_MISMATCH_PARAMETERS" ||
          deviation.reason === "UNDECLARED_TOOL"
        ) {
          await alertService.sendAlert(
            "HIGH",
            `Potential tool spoofing detected: ${deviation.toolCall.toolCallName}`,
            {
              deviation,
            },
          );
        }
      },
    }),
  );

  return agent;
}

// =============================================================================
// EXAMPLE 6: Strict Mode (Maximum Security)
// =============================================================================

/**
 * For maximum security, enable strict matching which also validates
 * tool descriptions match exactly (prevents description-based attacks).
 */
export function strictModeExample() {
  const agent = new HttpAgent({ url: "https://api.example.com/agent" });

  const allowedTools: ToolSpec[] = [
    {
      name: "criticalOperation",
      description: "Performs a critical operation that must not be spoofed",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string" },
          target: { type: "string" },
        },
        required: ["action", "target"],
      },
    },
  ];

  agent.use(
    secureToolsMiddleware({
      allowedTools,
      // Require exact description match (default is false)
      strictDescriptionMatch: true,
      // Require exact parameter schema match (this is already the default)
      strictParameterMatch: true,
    }),
  );

  return agent;
}

// =============================================================================
// EXAMPLE 7: Custom Logger Integration
// =============================================================================

/**
 * Integrate with your application's existing logger (e.g., Winston, Pino).
 */
export function customLoggerExample() {
  const agent = new HttpAgent({ url: "https://api.example.com/agent" });

  // Example: Pino-style logger
  const logger = {
    warn: (message: string, ...args: unknown[]) => {
      console.log(`[WARN] ${message}`, ...args);
    },
    error: (message: string, ...args: unknown[]) => {
      console.error(`[ERROR] ${message}`, ...args);
    },
    info: (message: string, ...args: unknown[]) => {
      console.info(`[INFO] ${message}`, ...args);
    },
  };

  const allowedTools: ToolSpec[] = [
    {
      name: "example",
      description: "An example tool",
      parameters: { type: "object", properties: {} },
    },
  ];

  agent.use(
    secureToolsMiddleware({
      allowedTools,
      // Use your custom logger for default deviation logging
      logger,
    }),
  );

  return agent;
}

// =============================================================================
// EXAMPLE 8: Multi-Tenant Security
// =============================================================================

/**
 * Per-tenant tool restrictions for SaaS applications.
 */
export function multiTenantExample() {
  // Tenant-specific tool permissions (would come from your database)
  const tenantToolPermissions: Record<string, string[]> = {
    "tenant-enterprise": ["*"], // Enterprise tier gets all tools
    "tenant-business": ["searchDocuments", "getWeather", "calculator"],
    "tenant-free": ["getWeather"], // Free tier limited to basic tools
  };

  function createAgentForTenant(tenantId: string) {
    const agent = new HttpAgent({ url: "https://api.example.com/agent" });

    agent.use(
      secureToolsMiddleware({
        metadata: { tenantId },
        isToolAllowed: (toolCall: ToolCallInfo, context: AgentSecurityContext) => {
          const tid = context.metadata?.tenantId as string;
          const permissions = tenantToolPermissions[tid] ?? [];

          if (permissions.includes("*")) {
            return true;
          }

          return permissions.includes(toolCall.toolCallName);
        },
        onDeviation: (deviation) => {
          console.log(
            `[Tenant: ${deviation.context.metadata?.tenantId}] Blocked tool: ${deviation.toolCall.toolCallName}`,
          );
        },
      }),
    );

    return agent;
  }

  return createAgentForTenant;
}
