/** Session bindings are host-owned metadata, separate from SDK transcript storage. */
import type {
  HookCallback,
  Options,
  SDKDeferredToolUse,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  RunAgentInput,
  ToolMessage,
  RunFinishedOutcome,
} from "@ag-ui/core";

export interface SessionBinding {
  sessionId: string;
  profile: string;
  pending?: SDKDeferredToolUse;
  frontendTools?: RunAgentInput["tools"];
}
export interface SessionBindingStore {
  load(threadId: string): Promise<SessionBinding | undefined>;
  save(threadId: string, binding: SessionBinding): Promise<void>;
}
export interface SessionRecoveryConfig {
  store: SessionBindingStore;
  /** Resolve trusted execution configuration; never accept this from forwardedProps. */
  resolveProfile(profile: string): Promise<Options>;
  profile: string;
  /** Native tools whose single calls require a durable decision. */
  deferTools?: string[];
}

export class RecoveryRun {
  private decision?: {
    behavior: "allow" | "deny";
    message?: string;
    updatedInput?: Record<string, unknown>;
  };
  private consumed = false;
  private frontendResult?: {
    content: ToolMessage["content"];
    error?: ToolMessage["error"];
  };
  readonly tools: RunAgentInput["tools"];
  private delivered = false;
  private failure?: string;
  private frontendNames: Set<string>;
  constructor(
    public binding: SessionBinding | undefined,
    input: RunAgentInput,
    deferTools: string[] = [],
  ) {
    this.tools = structuredClone(
      binding?.pending && binding.frontendTools
        ? binding.frontendTools
        : input.tools,
    );
    this.frontendNames = new Set([
      ...this.tools.map((tool) => `mcp__ag_ui__${tool.name}`),
      ...deferTools,
    ]);
    const pending = binding?.pending;
    if (pending?.name.startsWith("mcp__ag_ui__")) {
      const results = input.messages.filter(
        (message) =>
          message.role === "tool" && message.toolCallId === pending.id,
      );
      if (results.length > 1)
        throw new Error("Multiple results for one deferred tool call.");
      if (results.length === 1 && results[0].role === "tool") {
        this.frontendResult = {
          content: results[0].content,
          error: results[0].error,
        };
        this.decision = { behavior: "allow" };
      }
    }
    if (
      input.messages[input.messages.length - 1]?.role === "tool" &&
      this.frontendResult === undefined
    )
      throw new Error("No saved SDK deferral matches this frontend result.");
    const responses = input.resume ?? [];
    if (responses.length && this.frontendResult !== undefined)
      throw new Error(
        "Submit either a native decision or a frontend result, not both.",
      );
    if (responses.length > 1)
      throw new Error(
        "Claude SDK durable deferral supports one tool call at a time.",
      );
    if (responses.length) {
      const response = responses[0];
      if (!binding?.pending || response.interruptId !== binding.pending.id) {
        throw new Error(
          "No saved SDK deferral matches this approval; historical callbacks cannot be recovered.",
        );
      }
      const payload =
        response.status === "cancelled"
          ? { behavior: "deny", message: "Cancelled by user" }
          : response.payload;
      if (!payload || !["allow", "deny"].includes(payload.behavior))
        throw new Error("Approval payload requires behavior: allow or deny.");
      this.decision = payload;
    }
  }
  readonly resolveFrontendResult = (
    name: string,
    args: Record<string, unknown>,
  ) => {
    const pending = this.binding?.pending;
    if (
      !this.consumed ||
      this.delivered ||
      this.frontendResult === undefined ||
      pending?.name !== `mcp__ag_ui__${name}` ||
      !sameJson(args, pending.input)
    )
      throw new Error(
        "Frontend tool invocation has no matching resumed result.",
      );
    this.delivered = true;
    return this.frontendResult;
  };
  get resuming() {
    return !!this.decision;
  }
  get outcome(): RunFinishedOutcome | undefined {
    const pending = this.binding?.pending;
    if (!pending) return undefined;
    return pending.name.startsWith("mcp__ag_ui__")
      ? { type: "success", pendingToolCallIds: [pending.id] }
      : { type: "interrupt", interrupts: this.interrupts };
  }
  get interrupts() {
    const pending = this.binding?.pending;
    return pending
      ? [
          {
            id: pending.id,
            toolCallId: pending.id,
            reason: "tool_approval",
            metadata: {
              source: "claude-sdk-deferred",
              toolName: pending.name,
              input: pending.input,
            },
          },
        ]
      : [];
  }
  get awaitingDecision() {
    return !!this.binding?.pending && !this.decision;
  }
  readonly hook: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const pending = this.binding?.pending;
    if (!pending || this.consumed) {
      return this.frontendNames.has(input.tool_name)
        ? {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "defer",
            },
          }
        : {};
    }
    if (
      input.tool_use_id !== pending.id ||
      input.tool_name !== pending.name ||
      !sameJson(input.tool_input, pending.input)
    ) {
      this.failure = "Resumed tool does not match the saved SDK deferral.";
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: this.failure,
        },
      };
    }
    if (!this.decision)
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "defer",
        },
      };
    this.consumed = true;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: this.decision.behavior,
        ...(this.decision.message
          ? { permissionDecisionReason: this.decision.message }
          : {}),
        ...(this.decision.updatedInput
          ? { updatedInput: this.decision.updatedInput }
          : {}),
      },
    };
  };
  observeToolResult(toolUseId: string): boolean {
    if (this.binding?.pending?.id !== toolUseId) return false;
    if (!this.consumed)
      throw new Error(
        "SDK resolved the saved call without applying its approval hook.",
      );
    if (this.frontendResult !== undefined && !this.delivered)
      throw new Error("SDK omitted the submitted frontend result.");
    delete this.binding.pending;
    return true;
  }
  observe(
    sessionId: string,
    profile: string,
    result?: {
      stop_reason?: string | null;
      deferred_tool_use?: SDKDeferredToolUse;
      is_error?: boolean;
    },
  ) {
    if (this.failure) throw new Error(this.failure);
    if (this.binding && sessionId !== this.binding.sessionId)
      throw new Error("SDK changed the original session UUID during resume.");
    this.binding ??= { sessionId, profile };
    if (this.tools.length || this.binding.frontendTools)
      this.binding.frontendTools = structuredClone(this.tools);
    if (!result) return;
    if (result.stop_reason === "tool_deferred_unavailable")
      throw new Error(
        "Deferred tool is unavailable. Restore the original tool/MCP configuration before resuming.",
      );
    if (result.stop_reason === "tool_deferred") {
      const pending = result.deferred_tool_use;
      if (
        !pending?.id ||
        !pending.name ||
        !pending.input ||
        typeof pending.input !== "object"
      )
        throw new Error(
          "SDK deferral is missing its original tool identity/input.",
        );
      this.binding.pending = pending;
    } else if (!result.is_error && this.binding.pending) {
      if (this.frontendResult !== undefined && !this.delivered)
        throw new Error(
          "SDK did not deliver the submitted frontend result to the original tool.",
        );
      if (!this.consumed)
        throw new Error("SDK did not replay the saved deferred tool call.");
      delete this.binding.pending;
    }
  }
}
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a),
    bk = Object.keys(b);
  return (
    ak.length === bk.length &&
    ak.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(b, k) &&
        sameJson(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
    )
  );
}
