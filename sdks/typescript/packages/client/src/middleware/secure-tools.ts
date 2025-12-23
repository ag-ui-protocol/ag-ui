import { Middleware } from "./middleware";
import type { AbstractAgent } from "@/agent";
import {
  EventType,
  type RunAgentInput,
  type BaseEvent,
  type ToolCallStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type Tool,
} from "@ag-ui/core";
import type { Observable } from "rxjs";
import { from } from "rxjs";
import { concatMap, filter } from "rxjs/operators";

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Sentinel value to explicitly skip validation for a field.
 *
 * Use this when you want to allow any value for a field without validation.
 * This must be an explicit choice - omitting a field or using `undefined`
 * means the actual tool must also have that field undefined/empty.
 *
 * @example
 * ```ts
 * // In middleware configuration (server-side)
 * allowedTools: [
 *   {
 *     name: "my_tool",
 *     description: SKIP_VALIDATION,  // Allow any description
 *     parameters: { ... },           // But validate parameters exactly
 *   }
 * ]
 * ```
 */
export const SKIP_VALIDATION = Symbol.for("ag-ui.secure-tools.skip-validation");

/**
 * Type for the SKIP_VALIDATION sentinel value.
 */
export type SkipValidation = typeof SKIP_VALIDATION;

/**
 * EXPERIMENTAL: Sentinel string value for client-side tool definitions.
 *
 * Use this in `useFrontendTool` to indicate that the field's value should
 * come from the middleware's `allowedTools` configuration instead of being
 * defined on the client.
 *
 * This eliminates duplication - define the description/parameters once in
 * the middleware, and the client just provides the handler.
 *
 * ⚠️ This API is experimental and may change before stabilization.
 *
 * @example
 * ```tsx
 * // Client-side (React component)
 * useFrontendTool({
 *   name: "change_background",
 *   description: DEFINED_IN_MIDDLEWARE_EXPERIMENTAL,  // Get from server middleware
 *   parameters: DEFINED_IN_MIDDLEWARE_EXPERIMENTAL,   // Get from server middleware
 *   handler: (args) => setBackground(args.color),
 * });
 *
 * // Server-side (middleware configuration)
 * secureToolsMiddleware({
 *   allowedTools: [{
 *     name: "change_background",
 *     description: "Change the background color",  // Source of truth
 *     parameters: { type: "object", properties: { color: { type: "string" } } },
 *   }]
 * })
 * ```
 */
export const DEFINED_IN_MIDDLEWARE_EXPERIMENTAL = "__AG_UI_DEFINED_IN_MIDDLEWARE__";

/**
 * Type for the DEFINED_IN_MIDDLEWARE_EXPERIMENTAL sentinel value.
 * @internal - Not exported; use `typeof DEFINED_IN_MIDDLEWARE_EXPERIMENTAL` if needed.
 */
type DefinedInMiddleware = typeof DEFINED_IN_MIDDLEWARE_EXPERIMENTAL;

// =============================================================================
// TYPES - Core type definitions for the security middleware
// =============================================================================

/**
 * Tool specification for security validation.
 *
 * All fields are required to ensure explicit security configuration.
 * Each field can be:
 * - A concrete value → actual tool must match exactly
 * - `undefined` → actual tool must also have this field undefined/empty
 * - `SKIP_VALIDATION` → don't validate this field (explicit opt-out)
 *
 * @example
 * ```ts
 * // Exact match on all fields
 * { name: "foo", description: "Does X", parameters: { type: "object", ... } }
 *
 * // Match name exactly, description must be undefined, skip parameter validation
 * { name: "foo", description: undefined, parameters: SKIP_VALIDATION }
 *
 * // Match name exactly, skip description validation, parameters must be undefined
 * { name: "foo", description: SKIP_VALIDATION, parameters: undefined }
 * ```
 */
export interface ToolSpec {
  /**
   * Unique tool identifier - must match exactly (required).
   */
  name: string;

  /**
   * Tool description validation.
   * - `string` → actual tool's description must match exactly
   * - `undefined` → actual tool's description must be undefined or empty string
   * - `SKIP_VALIDATION` → don't validate description (any value allowed)
   */
  description: string | undefined | SkipValidation;

  /**
   * JSON Schema for tool parameters validation.
   * - `Record<string, unknown>` → actual tool's parameters must match exactly
   * - `undefined` → actual tool's parameters must be undefined or empty
   * - `SKIP_VALIDATION` → don't validate parameters (any schema allowed)
   */
  parameters: Record<string, unknown> | undefined | SkipValidation;
}

/**
 * Information about an incoming tool call being validated.
 * Aggregated from TOOL_CALL_START and TOOL_CALL_ARGS events.
 */
export interface ToolCallInfo {
  /** Unique identifier for this tool call instance */
  toolCallId: string;
  /** Name of the tool being called */
  toolCallName: string;
  /** Parent message ID if available */
  parentMessageId?: string;
  /** Parsed arguments (accumulated from TOOL_CALL_ARGS events) */
  parsedArgs: Record<string, unknown> | null;
  /** Raw accumulated arguments string */
  rawArgs: string;
}

/**
 * Context provided to security callbacks for decision-making.
 * Designed to be extensible for future enhancements.
 */
export interface AgentSecurityContext {
  /** The full input to the agent run */
  input: RunAgentInput;
  /** Tools declared in the agent input */
  declaredTools: Tool[];
  /** The thread ID for this conversation */
  threadId: string;
  /** The run ID for this execution */
  runId: string;
  /** Optional: Custom metadata passed through configuration */
  metadata?: Record<string, unknown>;
}

/**
 * Reasons why a tool call may be rejected.
 */
export type DeviationReason =
  | "NOT_IN_ALLOWLIST"
  | "SPEC_MISMATCH_DESCRIPTION"
  | "SPEC_MISMATCH_PARAMETERS"
  | "IS_TOOL_ALLOWED_REJECTED"
  | "UNDECLARED_TOOL"
  | "CUSTOM";

/**
 * Full deviation report when a tool call is blocked.
 */
export interface ToolDeviation {
  /** The tool call that was rejected */
  toolCall: ToolCallInfo;
  /** Why it was rejected */
  reason: DeviationReason;
  /** Human-readable explanation */
  message: string;
  /** The expected tool spec if a mismatch occurred */
  expectedSpec?: ToolSpec;
  /** The actual spec that was found (from declared tools) */
  actualSpec?: Tool;
  /** Security context at time of deviation */
  context: AgentSecurityContext;
  /** Timestamp of the deviation */
  timestamp: number;
}

/**
 * Result of tool validation check.
 */
export interface ToolValidationResult {
  allowed: boolean;
  reason?: DeviationReason;
  message?: string;
  expectedSpec?: ToolSpec;
  actualSpec?: Tool;
}

// =============================================================================
// CONFIGURATION - Middleware configuration options
// =============================================================================

/**
 * Callback signature for custom tool validation logic.
 * Return true to allow, false to reject.
 */
export type IsToolAllowedCallback = (
  toolCall: ToolCallInfo,
  context: AgentSecurityContext,
) => boolean | Promise<boolean>;

/**
 * Callback signature for deviation handling.
 */
export type OnDeviationCallback = (
  deviation: ToolDeviation,
) => void | Promise<void>;

/**
 * Configuration options for the secure tools middleware.
 */
export interface SecureToolsConfig {
  /**
   * List of allowed tool specifications.
   *
   * All fields are required for explicit security configuration:
   * - `name`: Must match exactly (required)
   * - `description`: Concrete value (match exactly), `undefined` (must be empty), or `SKIP_VALIDATION`
   * - `parameters`: Concrete value (match exactly), `undefined` (must be empty), or `SKIP_VALIDATION`
   *
   * @example
   * ```ts
   * allowedTools: [
   *   // Full validation - all fields must match exactly
   *   { name: "foo", description: "Does X", parameters: { type: "object", ... } },
   *
   *   // Skip description/parameter validation (allow any values)
   *   { name: "bar", description: SKIP_VALIDATION, parameters: SKIP_VALIDATION },
   *
   *   // Require tool to have NO description and NO parameters
   *   { name: "baz", description: undefined, parameters: undefined },
   * ]
   * ```
   */
  allowedTools?: ToolSpec[];

  /**
   * Custom callback for additional validation logic.
   * Called after allowedTools check (if both are provided).
   * Return true to allow the tool call, false to reject.
   *
   * Use cases:
   * - Per-user/per-tenant restrictions
   * - Time-based access controls
   * - Rate limiting
   * - Dynamic policy evaluation
   */
  isToolAllowed?: IsToolAllowedCallback;

  /**
   * Callback invoked when a tool call is blocked.
   * If not provided, uses default console.warn logging.
   *
   * Use cases:
   * - Custom audit logging
   * - Telemetry/metrics
   * - Admin alerts
   * - Security incident tracking
   */
  onDeviation?: OnDeviationCallback;

  /**
   * If true, requires exact parameter schema match.
   * If false, uses structural compatibility check (actual must be at least as restrictive).
   * Default: true (exact match for maximum security)
   *
   * Note: This only applies when parameters is a concrete value (not `undefined` or `SKIP_VALIDATION`).
   */
  strictParameterMatch?: boolean;

  /**
   * Custom metadata to pass through to security context.
   * Useful for per-request security policies.
   */
  metadata?: Record<string, unknown>;

  /**
   * Custom logger instance. If not provided, uses console.
   */
  logger?: {
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
  };
}

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

/**
 * Deep equality check for JSON Schema parameter objects.
 * Used for strict parameter validation.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return a === b;

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;

  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);

  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (!bKeys.includes(key)) return false;
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }

  return true;
}

/**
 * Check if a JSON Schema is structurally compatible (non-strict mode).
 * The actual schema must be at least as restrictive as expected.
 */
function isSchemaCompatible(
  expected: Record<string, unknown>,
  actual: unknown,
): boolean {
  if (actual === undefined || actual === null) {
    // If no schema provided, it's potentially unsafe
    return false;
  }

  // For now, use deep equality. In the future, this could be enhanced
  // to support schema compatibility checking (e.g., expected is subset of actual)
  return deepEqual(expected, actual);
}

/**
 * Find a matching tool spec from the allowed list.
 */
function findMatchingAllowedSpec(
  toolName: string,
  allowedTools: ToolSpec[],
): ToolSpec | undefined {
  return allowedTools.find((spec) => spec.name === toolName);
}

/**
 * Find a declared tool from the agent input.
 */
function findDeclaredTool(
  toolName: string,
  declaredTools: Tool[],
): Tool | undefined {
  return declaredTools.find((tool) => tool.name === toolName);
}

/**
 * Check if a value is empty (undefined, null, or empty string).
 */
function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/**
 * Check if an object is empty (undefined, null, or empty object).
 */
function isEmptyObject(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object") return false;
  return Object.keys(value as Record<string, unknown>).length === 0;
}

/**
 * Check if a value is the DEFINED_IN_MIDDLEWARE_EXPERIMENTAL sentinel.
 */
function isDefinedInMiddleware(value: unknown): boolean {
  return value === DEFINED_IN_MIDDLEWARE_EXPERIMENTAL;
}

/**
 * Transform a tool by replacing DEFINED_IN_MIDDLEWARE placeholders with values
 * from the matching ToolSpec in allowedTools.
 *
 * Returns the original tool if no transformation is needed, or a new tool
 * with the placeholders replaced.
 */
function transformTool(
  tool: Tool,
  allowedTools: ToolSpec[],
  logger?: SecureToolsConfig["logger"],
): Tool {
  const hasPlaceholderDescription = isDefinedInMiddleware(tool.description);
  const hasPlaceholderParameters = isDefinedInMiddleware(tool.parameters);

  // If no placeholders, return the original tool
  if (!hasPlaceholderDescription && !hasPlaceholderParameters) {
    return tool;
  }

  // Find matching spec in allowedTools
  const matchingSpec = findMatchingAllowedSpec(tool.name, allowedTools);

  if (!matchingSpec) {
    const log = logger ?? console;
    log.warn(
      `[SecureTools] Tool "${tool.name}" uses DEFINED_IN_MIDDLEWARE but no matching spec found in allowedTools. ` +
      `The placeholder values will be passed through unchanged.`
    );
    return tool;
  }

  // Build the transformed tool
  const transformedTool: Tool = { ...tool };

  if (hasPlaceholderDescription) {
    if (matchingSpec.description === SKIP_VALIDATION) {
      // SKIP_VALIDATION in spec means "allow any" - can't provide a value
      const log = logger ?? console;
      log.warn(
        `[SecureTools] Tool "${tool.name}" uses DEFINED_IN_MIDDLEWARE for description, ` +
        `but the spec uses SKIP_VALIDATION. Cannot substitute a value. ` +
        `Either provide a concrete description in the spec, or define it on the client.`
      );
    } else if (matchingSpec.description === undefined) {
      // Spec says description should be empty
      transformedTool.description = "";
    } else {
      // Use the concrete description from the spec
      transformedTool.description = matchingSpec.description;
    }
  }

  if (hasPlaceholderParameters) {
    if (matchingSpec.parameters === SKIP_VALIDATION) {
      // SKIP_VALIDATION in spec means "allow any" - can't provide a value
      const log = logger ?? console;
      log.warn(
        `[SecureTools] Tool "${tool.name}" uses DEFINED_IN_MIDDLEWARE for parameters, ` +
        `but the spec uses SKIP_VALIDATION. Cannot substitute a value. ` +
        `Either provide concrete parameters in the spec, or define them on the client.`
      );
    } else if (matchingSpec.parameters === undefined) {
      // Spec says parameters should be empty
      transformedTool.parameters = {};
    } else {
      // Use the concrete parameters from the spec
      transformedTool.parameters = matchingSpec.parameters;
    }
  }

  return transformedTool;
}

/**
 * Transform all tools in the input, replacing DEFINED_IN_MIDDLEWARE placeholders
 * with values from allowedTools.
 */
function transformTools(
  tools: Tool[],
  allowedTools: ToolSpec[],
  logger?: SecureToolsConfig["logger"],
): Tool[] {
  return tools.map((tool) => transformTool(tool, allowedTools, logger));
}

/**
 * Validate a tool call against the allowed specs and declared tools.
 *
 * Validation behavior for each field:
 * - Concrete value → actual tool must match exactly
 * - `undefined` → actual tool must also have this field undefined/empty
 * - `SKIP_VALIDATION` → don't validate this field (any value allowed)
 */
function validateToolCall(
  toolCall: ToolCallInfo,
  config: SecureToolsConfig,
  context: AgentSecurityContext,
): ToolValidationResult {
  const { allowedTools = [], strictParameterMatch = true } = config;

  // If no allowedTools configured, allow all (but this defeats the purpose)
  if (allowedTools.length === 0) {
    return { allowed: true };
  }

  // Step 1: Check if tool name is in the allowed list
  const allowedSpec = findMatchingAllowedSpec(toolCall.toolCallName, allowedTools);
  if (!allowedSpec) {
    return {
      allowed: false,
      reason: "NOT_IN_ALLOWLIST",
      message: `Tool "${toolCall.toolCallName}" is not in the allowed tools list`,
    };
  }

  // Step 2: Find the declared tool from the agent input
  const declaredTool = findDeclaredTool(toolCall.toolCallName, context.declaredTools);
  if (!declaredTool) {
    return {
      allowed: false,
      reason: "UNDECLARED_TOOL",
      message: `Tool "${toolCall.toolCallName}" is in allowed list but not declared in agent input`,
      expectedSpec: allowedSpec,
    };
  }

  // Step 3: Validate description
  // - SKIP_VALIDATION → don't check
  // - undefined → actual must be undefined/empty
  // - string → actual must match exactly
  if (allowedSpec.description !== SKIP_VALIDATION) {
    if (allowedSpec.description === undefined) {
      // Spec says description should be undefined/empty
      if (!isEmpty(declaredTool.description)) {
        return {
          allowed: false,
          reason: "SPEC_MISMATCH_DESCRIPTION",
          message: `Tool "${toolCall.toolCallName}" has a description but spec requires it to be empty. Actual: "${declaredTool.description}"`,
          expectedSpec: allowedSpec,
          actualSpec: declaredTool,
        };
      }
    } else {
      // Spec has a concrete description - must match exactly
      if (declaredTool.description !== allowedSpec.description) {
        return {
          allowed: false,
          reason: "SPEC_MISMATCH_DESCRIPTION",
          message: `Tool "${toolCall.toolCallName}" description mismatch. Expected: "${allowedSpec.description}", Actual: "${declaredTool.description}"`,
          expectedSpec: allowedSpec,
          actualSpec: declaredTool,
        };
      }
    }
  }

  // Step 4: Validate parameters schema
  // - SKIP_VALIDATION → don't check
  // - undefined → actual must be undefined/empty
  // - object → actual must match exactly (or be compatible in non-strict mode)
  if (allowedSpec.parameters !== SKIP_VALIDATION) {
    if (allowedSpec.parameters === undefined) {
      // Spec says parameters should be undefined/empty
      if (!isEmptyObject(declaredTool.parameters)) {
        return {
          allowed: false,
          reason: "SPEC_MISMATCH_PARAMETERS",
          message: `Tool "${toolCall.toolCallName}" has parameters but spec requires it to be empty`,
          expectedSpec: allowedSpec,
          actualSpec: declaredTool,
        };
      }
    } else {
      // Spec has concrete parameters - must match
      const parametersMatch = strictParameterMatch
        ? deepEqual(allowedSpec.parameters, declaredTool.parameters)
        : isSchemaCompatible(allowedSpec.parameters, declaredTool.parameters);

      if (!parametersMatch) {
        return {
          allowed: false,
          reason: "SPEC_MISMATCH_PARAMETERS",
          message: `Tool "${toolCall.toolCallName}" parameters schema does not match the allowed specification`,
          expectedSpec: allowedSpec,
          actualSpec: declaredTool,
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * Default deviation handler - logs to console.
 */
function defaultOnDeviation(
  deviation: ToolDeviation,
  logger: SecureToolsConfig["logger"],
): void {
  const log = logger ?? console;
  log.warn(
    `[SecureTools] Tool call blocked: ${deviation.toolCall.toolCallName}`,
    {
      reason: deviation.reason,
      message: deviation.message,
      toolCallId: deviation.toolCall.toolCallId,
      timestamp: new Date(deviation.timestamp).toISOString(),
    },
  );
}

// =============================================================================
// MIDDLEWARE IMPLEMENTATION
// =============================================================================

/**
 * Secure Tools Middleware
 *
 * A security-focused middleware that validates tool calls against full
 * specifications, not just names. This prevents tool spoofing attacks
 * where a malicious tool uses the same name but different behavior.
 *
 * Key features:
 * - Full spec validation (name + description + parameters)
 * - Callback-based custom policies (isToolAllowed)
 * - Deviation logging and custom handlers (onDeviation)
 * - Express-like middleware pattern
 */
export class SecureToolsMiddleware extends Middleware {
  private blockedToolCallIds = new Set<string>();
  private toolCallArgsBuffer = new Map<string, string>();
  private readonly config: SecureToolsConfig;

  constructor(config: SecureToolsConfig) {
    super();
    this.config = config;
    
    // Validate configuration
    if (!config.allowedTools && !config.isToolAllowed) {
      throw new Error(
        "SecureToolsMiddleware requires either allowedTools or isToolAllowed to be specified",
      );
    }
  }

  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    // Reset state for new run
    this.blockedToolCallIds.clear();
    this.toolCallArgsBuffer.clear();

    const { allowedTools = [], logger } = this.config;

    // Step 1: Transform tools - replace DEFINED_IN_MIDDLEWARE placeholders
    // with values from allowedTools before the agent sees them
    const transformedTools = transformTools(input.tools, allowedTools, logger);
    const transformedInput: RunAgentInput = {
      ...input,
      tools: transformedTools,
    };

    // Build security context with transformed tools
    const context: AgentSecurityContext = {
      input: transformedInput,
      declaredTools: transformedTools,
      threadId: input.threadId,
      runId: input.runId,
      metadata: this.config.metadata,
    };

    // Step 2: Pass transformed input to agent, then validate response events
    return this.runNext(transformedInput, next).pipe(
      // Process each event, validating tool calls and filtering blocked ones
      concatMap((event) => from(this.processEvent(event, context))),
      // Filter out null events (blocked tool calls)
      filter((event): event is BaseEvent => event !== null),
    );
  }

  /**
   * Process a single event, validating tool calls and returning null if blocked.
   */
  private async processEvent(
    event: BaseEvent,
    context: AgentSecurityContext,
  ): Promise<BaseEvent | null> {
    // Handle TOOL_CALL_START events - validate and potentially block
    if (event.type === EventType.TOOL_CALL_START) {
      const toolCallStartEvent = event as ToolCallStartEvent;
      const toolCallId = toolCallStartEvent.toolCallId;

      // Initialize args buffer
      this.toolCallArgsBuffer.set(toolCallId, "");

      // Build tool call info for validation
      const toolCall: ToolCallInfo = {
        toolCallId,
        toolCallName: toolCallStartEvent.toolCallName,
        parentMessageId: toolCallStartEvent.parentMessageId,
        parsedArgs: null,
        rawArgs: "",
      };

      // Validate the tool call (this handles blocking and deviation reporting)
      const allowed = await this.isToolCallAllowed(toolCall, context);

      if (!allowed) {
        // Already added to blockedToolCallIds in isToolCallAllowed
        return null;
      }

      return event;
    }

    // Handle TOOL_CALL_ARGS events
    if (event.type === EventType.TOOL_CALL_ARGS) {
      const toolCallArgsEvent = event as ToolCallArgsEvent;
      
      if (this.blockedToolCallIds.has(toolCallArgsEvent.toolCallId)) {
        return null;
      }

      // Accumulate args
      const currentArgs = this.toolCallArgsBuffer.get(toolCallArgsEvent.toolCallId) ?? "";
      this.toolCallArgsBuffer.set(toolCallArgsEvent.toolCallId, currentArgs + toolCallArgsEvent.delta);
      return event;
    }

    // Handle TOOL_CALL_END events
    if (event.type === EventType.TOOL_CALL_END) {
      const toolCallEndEvent = event as ToolCallEndEvent;
      
      if (this.blockedToolCallIds.has(toolCallEndEvent.toolCallId)) {
        return null;
      }

      return event;
    }

    // Handle TOOL_CALL_RESULT events
    if (event.type === EventType.TOOL_CALL_RESULT) {
      const toolCallResultEvent = event as ToolCallResultEvent;
      const isBlocked = this.blockedToolCallIds.has(toolCallResultEvent.toolCallId);

      // Clean up tracking state
      this.blockedToolCallIds.delete(toolCallResultEvent.toolCallId);
      this.toolCallArgsBuffer.delete(toolCallResultEvent.toolCallId);

      if (isBlocked) {
        return null;
      }

      return event;
    }

    // Allow all other events through
    return event;
  }

  /**
   * Combined check: allowedTools validation + isToolAllowed callback.
   * This is the core security logic.
   */
  public async isToolCallAllowed(
    toolCall: ToolCallInfo,
    context: AgentSecurityContext,
  ): Promise<boolean> {
    const { allowedTools, isToolAllowed, onDeviation, logger } = this.config;

    // Step 1: Validate against allowedTools if specified
    if (allowedTools && allowedTools.length > 0) {
      const validationResult = validateToolCall(toolCall, this.config, context);

      if (!validationResult.allowed) {
        // Create deviation report
        // Note: reason and message are always defined when allowed is false
        const deviation: ToolDeviation = {
          toolCall,
          reason: validationResult.reason ?? "CUSTOM",
          message: validationResult.message ?? "Tool call was not allowed",
          expectedSpec: validationResult.expectedSpec,
          actualSpec: validationResult.actualSpec,
          context,
          timestamp: Date.now(),
        };

        // Handle deviation
        if (onDeviation) {
          await onDeviation(deviation);
        } else {
          defaultOnDeviation(deviation, logger);
        }

        // Block the tool call
        this.blockedToolCallIds.add(toolCall.toolCallId);
        return false;
      }
    }

    // Step 2: Run custom isToolAllowed callback if provided
    if (isToolAllowed) {
      const callbackResult = await isToolAllowed(toolCall, context);

      if (!callbackResult) {
        // Create deviation report for callback rejection
        const deviation: ToolDeviation = {
          toolCall,
          reason: "IS_TOOL_ALLOWED_REJECTED",
          message: `Tool "${toolCall.toolCallName}" was rejected by isToolAllowed callback`,
          context,
          timestamp: Date.now(),
        };

        // Handle deviation
        if (onDeviation) {
          await onDeviation(deviation);
        } else {
          defaultOnDeviation(deviation, logger);
        }

        // Block the tool call
        this.blockedToolCallIds.add(toolCall.toolCallId);
        return false;
      }
    }

    return true;
  }
}

// =============================================================================
// FACTORY FUNCTION - Express-style middleware creation
// =============================================================================

/**
 * Create a secure tools middleware instance.
 *
 * @example Simple path - allowlist only
 * ```ts
 * agent.use(secureToolsMiddleware({
 *   allowedTools: [
 *     {
 *       name: "getWeather",
 *       description: "Get current weather for a city",
 *       parameters: {
 *         type: "object",
 *         properties: { city: { type: "string" } },
 *         required: ["city"],
 *       },
 *     },
 *   ],
 * }));
 * ```
 *
 * @example Advanced path - custom validation
 * ```ts
 * agent.use(secureToolsMiddleware({
 *   allowedTools: [...],
 *   isToolAllowed: (toolCall, context) => {
 *     // Custom per-user restrictions
 *     const userId = context.metadata?.userId;
 *     return hasToolAccess(userId, toolCall.toolCallName);
 *   },
 *   onDeviation: (deviation) => {
 *     // Send to audit log / telemetry
 *     auditLogger.log("tool_blocked", deviation);
 *   },
 * }));
 * ```
 */
export function secureToolsMiddleware(config: SecureToolsConfig): SecureToolsMiddleware {
  return new SecureToolsMiddleware(config);
}

// =============================================================================
// HELPER EXPORTS - For advanced use cases
// =============================================================================

/**
 * Standalone function to check if a tool call would be allowed.
 * Useful for pre-validation or UI display.
 */
export function checkToolCallAllowed(
  toolCall: ToolCallInfo,
  config: SecureToolsConfig,
  context: AgentSecurityContext,
): ToolValidationResult {
  return validateToolCall(toolCall, config, context);
}

/**
 * Create a ToolSpec from an existing Tool definition.
 * Convenience function for migrating from simple tool definitions.
 *
 * By default, creates a spec that requires exact matches for all fields.
 * Use `SKIP_VALIDATION` for fields you want to skip.
 *
 * @param tool - The tool definition to convert
 * @param options - Control validation behavior for each field
 *
 * @example
 * ```ts
 * // Exact match on all fields
 * createToolSpec(myTool)
 *
 * // Skip description validation
 * createToolSpec(myTool, { description: "skip" })
 *
 * // Skip all optional fields
 * createToolSpec(myTool, { description: "skip", parameters: "skip" })
 * ```
 */
export function createToolSpec(
  tool: Tool,
  options?: {
    description?: "exact" | "skip";
    parameters?: "exact" | "skip";
  },
): ToolSpec {
  const { description = "exact", parameters = "exact" } = options ?? {};

  return {
    name: tool.name,
    description: description === "skip" ? SKIP_VALIDATION : tool.description,
    parameters: parameters === "skip" ? SKIP_VALIDATION : (tool.parameters as Record<string, unknown>),
  };
}

/**
 * Create multiple ToolSpecs from an array of Tools.
 *
 * @param tools - Array of tool definitions to convert
 * @param options - Control validation behavior for each field (applies to all tools)
 */
export function createToolSpecs(
  tools: Tool[],
  options?: {
    description?: "exact" | "skip";
    parameters?: "exact" | "skip";
  },
): ToolSpec[] {
  return tools.map((tool) => createToolSpec(tool, options));
}
