import { buildAguiToolMessage } from "./utils";

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
  /** Unresolved batch/child calls retained for diagnosis, never independently replayed. */
  unsupportedPendingTools?: (SDKDeferredToolUse & {
    parentToolUseId?: string;
  })[];
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

class UnmatchedToolResult extends Error {
  constructor() {
    super("No saved SDK deferral matches this frontend result.");
  }
}

/** Convert trusted native transcript results using the same projection as live events. */
export function historicalToolResults(
  messages: { message: unknown }[],
): ToolMessage[] {
  const results: ToolMessage[] = [];
  for (const { message } of messages) {
    if (
      !message ||
      typeof message !== "object" ||
      !("content" in message) ||
      !Array.isArray(message.content)
    )
      continue;
    const content: unknown[] = message.content;
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "tool_result" &&
        "tool_use_id" in block &&
        typeof block.tool_use_id === "string"
      )
        results.push(
          buildAguiToolMessage(
            block.tool_use_id,
            "content" in block ? block.content : undefined,
            "is_error" in block && block.is_error === true,
          ),
        );
    }
  }
  return results;
}

export class RecoveryRun {
  static async restore(
    binding: SessionBinding | undefined,
    input: RunAgentInput,
    deferTools: string[],
    loadHistory: () => Promise<ToolMessage[]>,
  ): Promise<RecoveryRun> {
    try {
      return new RecoveryRun(binding, input, deferTools);
    } catch (error) {
      if (!(error instanceof UnmatchedToolResult) || !binding) throw error;
      // History is host-loaded from this binding's original SDK session, never
      // inferred from client message order, tool names, or forwarded props.
      return new RecoveryRun(binding, input, deferTools, await loadHistory());
    }
  }

  private deferredTools = new Map<string, SDKDeferredToolUse>();
  private childTools = new Map<
    string,
    SDKDeferredToolUse & { parentToolUseId: string }
  >();
  observeChildTool(tool: SDKDeferredToolUse, parentToolUseId: string) {
    this.childTools.set(tool.id, structuredClone({ ...tool, parentToolUseId }));
  }
  checkpointDeferred(sessionId: string, profile: string): boolean {
    if (this.deferredTools.size < 2) return false;
    if (!sessionId)
      throw new Error("Deferred batch is missing its original session UUID.");
    this.observe(sessionId, profile);
    this.binding!.unsupportedPendingTools = structuredClone([
      ...this.deferredTools.values(),
    ]);
    return true;
  }
  assertSupported() {
    if (
      this.binding?.unsupportedPendingTools?.some(
        (tool) => tool.parentToolUseId,
      )
    )
      throw new Error(
        "Claude SDK child tool calls remain unresolved. Original child identities are retained for diagnosis; child deferral recovery is unsupported.",
      );
    if ((this.binding?.unsupportedPendingTools?.length ?? 0) > 1)
      throw new Error(
        "Claude SDK cannot resume multiple pending tool calls. The original pending batch is retained; SDK batch recovery is unsupported.",
      );
  }

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
    historicalResults: ToolMessage[] = [],
  ) {
    this.assertSupported();
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
        // TOOL_CALL_RESULT has no error field. Middleware carries the marker
        // in metadata so ordinary client reduction and cold restore retain it.
        const marker = results[0].metadata?.["ag-ui:tool-result"];
        const middlewareError =
          marker &&
          typeof marker === "object" &&
          "error" in marker &&
          typeof marker.error === "string"
            ? marker.error
            : undefined;
        this.frontendResult = {
          content: results[0].content,
          error: results[0].error ?? middlewareError,
        };
        this.decision = { behavior: "allow" };
      }
    }
    const responses = input.resume ?? [];
    if (
      responses.length &&
      (this.frontendResult !== undefined ||
        input.messages.some(
          (message) =>
            message.role === "tool" && message.toolCallId === pending?.id,
        ))
    )
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
    // Only a result proved to exist in native storage can be ignored as
    // history. Check every trailing result, not just the last one.
    for (let i = input.messages.length - 1; i >= 0; i--) {
      const message = input.messages[i];
      if (message.role !== "tool") break;
      if (
        input.messages.filter(
          (m) => m.role === "tool" && m.toolCallId === message.toolCallId,
        ).length > 1
      )
        throw new Error("Multiple results for one deferred tool call.");
      if (
        this.frontendResult !== undefined &&
        message.toolCallId === pending?.id
      )
        continue;
      const saved = historicalResults.filter(
        (result) => result.toolCallId === message.toolCallId,
      );
      // Client reduction can retain an error only in result-event metadata.
      // An explicit error remains authoritative; never coerce the marker.
      const marker: unknown = message.metadata?.["ag-ui:tool-result"];
      const metadataError =
        marker &&
        typeof marker === "object" &&
        "error" in marker &&
        typeof marker.error === "string"
          ? marker.error
          : undefined;
      const error = message.error ?? metadataError;
      if (
        message.toolCallId === pending?.id ||
        saved.length !== 1 ||
        !sameJson(saved[0].content, message.content) ||
        saved[0].error !== error
      )
        throw new UnmatchedToolResult();
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
      if (this.frontendNames.has(input.tool_name)) {
        if (
          !input.tool_input ||
          typeof input.tool_input !== "object" ||
          Array.isArray(input.tool_input)
        )
          throw new Error("Deferred tool input must be an object.");
        this.deferredTools.set(
          input.tool_use_id,
          structuredClone({
            id: input.tool_use_id,
            name: input.tool_name,
            input: { ...input.tool_input },
          }),
        );
      }
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
  observeToolResult(
    toolUseId: string,
    parentToolUseId?: string | null,
  ): boolean {
    const child = this.childTools.get(toolUseId);
    if (child && child.parentToolUseId !== parentToolUseId) return false;
    this.childTools.delete(toolUseId);
    // A correlated child result can complete the last outstanding call in a batch.
    const observed = this.deferredTools.delete(toolUseId) || child !== undefined;
    const changed = this.observePendingToolResult(toolUseId);
    if (
      observed &&
      this.deferredTools.size === 0 &&
      this.childTools.size === 0 &&
      this.binding?.unsupportedPendingTools
    ) {
      delete this.binding.unsupportedPendingTools;
      return true;
    }
    return changed;
  }
  private observePendingToolResult(toolUseId: string): boolean {
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
      this.deferredTools.set(pending.id, structuredClone(pending));
    } else if (!result.is_error && this.binding.pending) {
      if (this.frontendResult !== undefined && !this.delivered)
        throw new Error(
          "SDK did not deliver the submitted frontend result to the original tool.",
        );
      if (!this.consumed)
        throw new Error("SDK did not replay the saved deferred tool call.");
      delete this.binding.pending;
    }
    if (this.deferredTools.size > 1 || this.childTools.size) {
      this.binding.unsupportedPendingTools = [
        ...new Map([...this.deferredTools, ...this.childTools]).values(),
      ];
      // Child identities are diagnostic, never parent-session resume targets.
      if (this.binding.pending && this.childTools.has(this.binding.pending.id))
        delete this.binding.pending;
    } else if (!result.is_error) delete this.binding.unsupportedPendingTools;
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

/** Read-only diagnostic for legacy bindings that retained only the SDK's last call. */
export function unresolvedToolUses(
  messages: { message: unknown }[],
): SDKDeferredToolUse[] {
  const pending = new Map<string, SDKDeferredToolUse>();
  for (const { message } of messages) {
    if (
      !message ||
      typeof message !== "object" ||
      !("content" in message) ||
      !Array.isArray(message.content)
    )
      continue;
    for (const block of message.content) {
      if (
        block?.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string" &&
        block.input &&
        typeof block.input === "object"
      )
        pending.set(
          block.id,
          structuredClone({
            id: block.id,
            name: block.name,
            input: block.input,
          }),
        );
      else if (block?.type === "tool_result") pending.delete(block.tool_use_id);
    }
  }
  return [...pending.values()];
}
