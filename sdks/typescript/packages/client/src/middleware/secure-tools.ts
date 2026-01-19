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
  type CustomEvent,
  type Tool,
  type Message,
} from "@ag-ui/core";
import type { Observable } from "rxjs";
import { from } from "rxjs";
import { concatMap, mergeMap } from "rxjs/operators";

/** Marker in tool results to identify blocked tool calls */
const BLOCKED_TOOL_MARKER = "TOOL_BLOCKED_BY_SECURITY_POLICY";

/**
 * System instruction injected to ensure the LLM always attempts tool calls,
 * even if it has seen them blocked before. This is critical for:
 * 1. Consistent user experience (blocked message shown every time)
 * 2. Reliable security auditing (all tool call attempts are logged)
 * 3. Preserving full conversation context
 */
const ALWAYS_ATTEMPT_TOOLS_INSTRUCTION = `IMPORTANT SECURITY INSTRUCTION: When a user requests functionality that matches an available tool, you MUST always attempt to call that tool, even if you have seen it blocked or fail in previous messages. Do not assume any tool is unavailable based on past attempts. The security system needs to intercept every tool call attempt to properly log and report blocked tools. Never respond with plain text when a tool call would be appropriate - always make the tool call attempt so the system can handle it properly.`;

/**
 * Name of the custom event emitted when a tool call is blocked.
 * Frontend applications can subscribe to this event to track security deviations.
 */
export const SECURITY_DEVIATION_EVENT = "security_deviation";

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
 * Payload for the security deviation custom event.
 * This is a frontend-friendly subset of ToolDeviation that's streamed to the client.
 */
export interface SecurityDeviationEventPayload {
  /** Unique identifier for this deviation */
  id: string;
  /** Name of the tool that was blocked */
  toolName: string;
  /** ID of the blocked tool call */
  toolCallId: string;
  /** Why the tool was blocked */
  reason: DeviationReason;
  /** Human-readable explanation */
  message: string;
  /** 
   * Formatted message for display in the UI.
   * This is generated by the `blockedToolMessage` config option if provided.
   * Frontend should display this in the chat instead of constructing its own message.
   */
  displayMessage?: string;
  /** Timestamp of the deviation */
  timestamp: number;
  /** Thread ID where the deviation occurred */
  threadId: string;
  /** Run ID where the deviation occurred */
  runId: string;
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

  /**
   * Function to generate a visible message shown to users when a tool call is blocked.
   * If provided, a text message will be emitted to the chat informing the user.
   * If not provided, no user-visible message is shown (only server-side logging via onDeviation).
   *
   * The `reason` parameter will be one of:
   * - `NOT_IN_ALLOWLIST` - Tool not in the allowed tools list
   * - `SPEC_MISMATCH_DESCRIPTION` - Tool description doesn't match
   * - `SPEC_MISMATCH_PARAMETERS` - Tool parameters don't match
   * - `IS_TOOL_ALLOWED_REJECTED` - Rejected by isToolAllowed callback
   * - `UNDECLARED_TOOL` - Tool not declared in agent config
   * - `CUSTOM` - Custom rejection reason
   *
   * @example
   * ```ts
   * // Simple message
   * blockedToolMessage: (toolName) =>
   *   `🔒 The tool "${toolName}" is not available.`
   *
   * // Include reason
   * blockedToolMessage: (toolName, reason) =>
   *   `Security: "${toolName}" was blocked (${reason})`
   * ```
   */
  blockedToolMessage?: (toolName: string, reason: string) => string;

  /**
   * If true (default), injects a system instruction that tells the LLM to
   * ALWAYS attempt tool calls when the user requests tool functionality,
   * even if the tool was blocked in previous messages.
   *
   * This ensures:
   * 1. Consistent user experience (blocked message shown every time)
   * 2. Reliable security auditing (all tool call attempts are logged)
   * 3. Full conversation context is preserved
   *
   * Set to false if you want the LLM to naturally learn from blocked attempts
   * and potentially stop trying to use blocked tools.
   *
   * @default true
   *
   * @example
   * ```ts
   * // Disable the instruction (LLM may learn to avoid blocked tools)
   * injectToolAttemptInstruction: false
   * ```
   */
  injectToolAttemptInstruction?: boolean;
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
 * The actual schema must contain at least all properties defined in expected.
 *
 * This allows the actual tool to have additional properties beyond what the
 * spec requires, which is useful when you want to validate that certain
 * properties exist without requiring an exact match.
 */
function isSchemaCompatible(
  expected: Record<string, unknown>,
  actual: unknown,
): boolean {
  if (actual === undefined || actual === null) {
    // If no schema provided, it's potentially unsafe
    return false;
  }

  if (typeof actual !== "object") {
    return false;
  }

  const actualObj = actual as Record<string, unknown>;

  // Check that the base type matches
  if (expected.type !== actualObj.type) {
    return false;
  }

  // For object types, check that expected properties are present in actual
  if (expected.type === "object") {
    const expectedProps = expected.properties as Record<string, unknown> | undefined;
    const actualProps = actualObj.properties as Record<string, unknown> | undefined;

    if (expectedProps) {
      if (!actualProps) {
        return false;
      }

      // Every property in expected must exist in actual with matching type
      for (const [key, expectedProp] of Object.entries(expectedProps)) {
        const actualProp = actualProps[key];
        if (!actualProp) {
          return false; // Expected property missing
        }

        // Recursively check property compatibility
        if (
          typeof expectedProp === "object" &&
          expectedProp !== null &&
          !isSchemaCompatible(expectedProp as Record<string, unknown>, actualProp)
        ) {
          return false;
        }
      }
    }

    // Check required fields - all expected required must be in actual required
    const expectedRequired = expected.required as string[] | undefined;
    const actualRequired = actualObj.required as string[] | undefined;

    if (expectedRequired && expectedRequired.length > 0) {
      if (!actualRequired) {
        return false;
      }
      for (const reqField of expectedRequired) {
        if (!actualRequired.includes(reqField)) {
          return false;
        }
      }
    }
  }

  return true;
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
/** Info about a blocked tool call for message generation */
interface BlockedToolInfo {
  toolName: string;
  reason: DeviationReason;
  message?: string;
}

export class SecureToolsMiddleware extends Middleware {
  private blockedToolCalls = new Map<string, BlockedToolInfo>();
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
    this.blockedToolCalls.clear();
    this.toolCallArgsBuffer.clear();

    // Inject system instruction to ensure LLM always attempts tool calls
    // This is enabled by default (injectToolAttemptInstruction defaults to true)
    const shouldInjectInstruction = this.config.injectToolAttemptInstruction !== false;
    const processedInput = shouldInjectInstruction
      ? this.injectToolAttemptInstruction(input)
      : input;

    // Build security context
    const context: AgentSecurityContext = {
      input: processedInput,
      declaredTools: processedInput.tools,
      threadId: processedInput.threadId,
      runId: processedInput.runId,
      metadata: this.config.metadata,
    };

    return this.runNext(processedInput, next).pipe(
      // Process each event, validating tool calls
      // processEvent returns an array of events (may include synthetic results for blocked tools)
      concatMap((event) => from(this.processEvent(event, context))),
      // Flatten the array of events into individual events
      mergeMap((events) => from(events)),
    );
  }

  /**
   * Inject a system instruction that tells the LLM to always attempt tool calls,
   * even if it has seen them blocked before. This ensures consistent behavior
   * and reliable security logging.
   */
  private injectToolAttemptInstruction(input: RunAgentInput): RunAgentInput {
    // Check if we already have this instruction (avoid duplicates)
    const hasInstruction = input.messages.some(
      (msg) =>
        msg.role === "system" &&
        (msg as { content?: string }).content?.includes("IMPORTANT SECURITY INSTRUCTION"),
    );

    if (hasInstruction) {
      return input;
    }

    // Create system message with the instruction
    const systemMessage: Message = {
      id: `security-instruction-${Date.now()}`,
      role: "system",
      content: ALWAYS_ATTEMPT_TOOLS_INSTRUCTION,
    };

    return {
      ...input,
      messages: [systemMessage, ...input.messages],
    };
  }

  /**
   * Process a single event, validating tool calls.
   * Returns an array of events to emit (may include synthetic results for blocked tools).
   * 
   * When a tool call is blocked:
   * - We still pass through TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END events
   * - After TOOL_CALL_END, we emit a synthetic TOOL_CALL_RESULT with an error message
   * 
   * This ensures the conversation history remains balanced (every function call
   * has a corresponding function response), which is required by LLM APIs like
   * Google's Gemini that validate function call/response parity.
   */
  private async processEvent(
    event: BaseEvent,
    context: AgentSecurityContext,
  ): Promise<BaseEvent[]> {
    // Handle TOOL_CALL_START events - validate and track blocked calls
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
        // Tool is blocked - track it but still pass through the event
        // so that the conversation history includes the tool call.
        // We'll emit a synthetic TOOL_CALL_RESULT after TOOL_CALL_END.
        // Already added to blockedToolCallIds in isToolCallAllowed
      }

      // Always pass through TOOL_CALL_START to maintain conversation history
      return [event];
    }

    // Handle TOOL_CALL_ARGS events - always pass through
    if (event.type === EventType.TOOL_CALL_ARGS) {
      const toolCallArgsEvent = event as ToolCallArgsEvent;
      
      // Accumulate args (needed for logging/debugging, even for blocked tools)
      const currentArgs = this.toolCallArgsBuffer.get(toolCallArgsEvent.toolCallId) ?? "";
      this.toolCallArgsBuffer.set(toolCallArgsEvent.toolCallId, currentArgs + toolCallArgsEvent.delta);
      
      // Always pass through to maintain conversation history
      return [event];
    }

    // Handle TOOL_CALL_END events
    if (event.type === EventType.TOOL_CALL_END) {
      const toolCallEndEvent = event as ToolCallEndEvent;
      const toolCallId = toolCallEndEvent.toolCallId;
      const blockedInfo = this.blockedToolCalls.get(toolCallId);
      
      if (blockedInfo) {
        const { toolName, reason, message: deviationMessage } = blockedInfo;
        
        // For blocked tools, emit TOOL_CALL_END followed by a synthetic TOOL_CALL_RESULT
        // This ensures the conversation history is balanced
        const syntheticResult: ToolCallResultEvent = {
          type: EventType.TOOL_CALL_RESULT,
          messageId: `blocked-result-${toolCallId}`,
          toolCallId,
          content: JSON.stringify({
            error: BLOCKED_TOOL_MARKER,
            message: "This tool call was blocked by the security middleware. The tool is not in the allowed tools list or was rejected by the security policy.",
          }),
          role: "tool",
        };
        
        // Generate display message if blockedToolMessage formatter is provided
        const displayMessage = this.config.blockedToolMessage 
          ? this.config.blockedToolMessage(toolName, reason)
          : undefined;
        
        // Emit a CUSTOM event so the frontend can track security deviations
        // The displayMessage is included so the frontend can show it in the UI
        const deviationEvent: CustomEvent = {
          type: EventType.CUSTOM,
          name: SECURITY_DEVIATION_EVENT,
          value: {
            id: `deviation-${toolCallId}`,
            toolName,
            toolCallId,
            reason,
            message: deviationMessage ?? `Tool "${toolName}" was blocked by security policy`,
            displayMessage,
            timestamp: Date.now(),
            threadId: context.threadId,
            runId: context.runId,
          } satisfies SecurityDeviationEventPayload,
        };
        
        // Clean up tracking state for blocked tool
        this.blockedToolCalls.delete(toolCallId);
        this.toolCallArgsBuffer.delete(toolCallId);
        
        // NOTE: We intentionally do NOT emit TEXT_MESSAGE events here.
        // Emitting assistant text messages inline with tool call events causes
        // the conversation history to include both a tool result AND a text message
        // in the same assistant turn, which confuses some LLM backends (e.g., ADK/Gemini)
        // and causes subsequent requests to fail silently.
        //
        // Instead, the blocked message is included in the CUSTOM deviation event payload.
        // The frontend should listen for this CUSTOM event and display the message
        // in the UI locally (without adding it to the conversation history).
        
        return [event, syntheticResult, deviationEvent];
      }

      return [event];
    }

    // Handle TOOL_CALL_RESULT events
    if (event.type === EventType.TOOL_CALL_RESULT) {
      const toolCallResultEvent = event as ToolCallResultEvent;
      const toolCallId = toolCallResultEvent.toolCallId;
      
      // If this tool was blocked, we've already emitted a synthetic result
      // after TOOL_CALL_END. Skip this external result to avoid duplicates.
      if (this.blockedToolCalls.has(toolCallId)) {
        // Clean up (though it should already be cleaned up after TOOL_CALL_END)
        this.blockedToolCalls.delete(toolCallId);
        this.toolCallArgsBuffer.delete(toolCallId);
        return [];
      }

      // Clean up tracking state
      this.toolCallArgsBuffer.delete(toolCallId);

      return [event];
    }

    // Allow all other events through
    return [event];
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

        // Block the tool call and store info for message generation
        this.blockedToolCalls.set(toolCall.toolCallId, {
          toolName: toolCall.toolCallName,
          reason: validationResult.reason ?? "CUSTOM",
          message: deviation.message,
        });
        return false;
      }
    }

    // Step 2: Run custom isToolAllowed callback if provided
    if (isToolAllowed) {
      const callbackResult = await isToolAllowed(toolCall, context);

      if (!callbackResult) {
        const deviationMessage = `Tool "${toolCall.toolCallName}" was rejected by isToolAllowed callback`;
        
        // Create deviation report for callback rejection
        const deviation: ToolDeviation = {
          toolCall,
          reason: "IS_TOOL_ALLOWED_REJECTED",
          message: deviationMessage,
          context,
          timestamp: Date.now(),
        };

        // Handle deviation
        if (onDeviation) {
          await onDeviation(deviation);
        } else {
          defaultOnDeviation(deviation, logger);
        }

        // Block the tool call and store info for message generation
        this.blockedToolCalls.set(toolCall.toolCallId, {
          toolName: toolCall.toolCallName,
          reason: "IS_TOOL_ALLOWED_REJECTED",
          message: deviationMessage,
        });
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
