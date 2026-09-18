import {
  EventType as E,
  type BaseEvent,
  type Message,
  type RunAgentInput,
  type ToolMessage,
  type UserMessage,
} from "@ag-ui/core";
import { AbstractAgent, type AgentConfig } from "@ag-ui/client";
import type { CopilotSession, SessionConfig, SessionEvent, Tool } from "@github/copilot-sdk";
import { Observable } from "rxjs";
import { CopilotEventMapper } from "./mapper.js";

/** The slice of the native session this integration depends on. */
export type CopilotSessionPort = Pick<
  CopilotSession,
  "sessionId" | "send" | "abort" | "disconnect"
> & {
  rpc: { tools: Pick<CopilotSession["rpc"]["tools"], "handlePendingToolCall"> };
};

export interface CopilotClientPort {
  createSession(config: SessionConfig): Promise<CopilotSessionPort>;
}

export interface CopilotAgentConfig extends AgentConfig {
  client: CopilotClientPort;
  model?: string;
  instructions?: string;
  /** Server-side tools the model may call directly. */
  tools?: Tool[];
  sessionConfig?: Omit<SessionConfig, "onEvent" | "tools">;
  /** Wall-clock budget for a single run; on expiry the native work is abandoned. */
  runTimeoutMs?: number;
  /** Bounds the in-process pending-tool registry. */
  maxPendingTools?: number;
}

interface Thread {
  session?: CopilotSessionPort;
  mapper: CopilotEventMapper;
  /** AG-UI toolCallId -> native requestId of the suspended external tool call. */
  pending: Map<string, string>;
  sentUserIds: Set<string>;
  events: SessionEvent[];
  wake?: () => void;
  busy: boolean;
}

/** Native sessions are process-local; a restart drops suspended tool calls. */
const MAX_THREADS = 32;
/** Quiet period after a pending tool request before handing off to the browser. */
const HANDOFF_DELAY_MS = 50;

function byokProvider(): Pick<SessionConfig, "provider" | "model"> | undefined {
  const baseUrl = process.env.OPENAI_BASE_URL;
  if (!baseUrl) return undefined;
  return {
    provider: { type: "openai", baseUrl, apiKey: process.env.OPENAI_API_KEY },
    model: process.env.OPENAI_CHAT_MODEL_ID ?? "gpt-4o",
  };
}

/** Mirrors the sibling SDK integrations: state and context belong in the prompt preamble. */
function buildPrompt(input: RunAgentInput, userContent: string): string {
  const parts: string[] = [];
  if (input.context?.length) {
    parts.push("## Context from the application");
    for (const entry of input.context) parts.push(`- ${entry.description}: ${entry.value}`);
    parts.push("");
  }
  if (input.state && Object.keys(input.state as object).length > 0) {
    parts.push("## Current shared state");
    parts.push(`\`\`\`json\n${JSON.stringify(input.state, null, 2)}\n\`\`\``);
    parts.push("");
  }
  parts.push(userContent);
  return parts.join("\n");
}

function isToolMessage(message: Message): message is ToolMessage {
  return message.role === "tool";
}

/** This integration prompts with text; non-text parts are dropped, not silently mangled. */
function textOf(content: UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Serves one Copilot SDK session per AG-UI thread.
 *
 * Frontend tools are registered without a handler, so the runtime suspends the
 * call and reports it as `external_tool.requested`. The run then finishes, the
 * browser executes the tool, and the next `RunAgentInput` carries a `role: "tool"`
 * message that resolves the *original* RPC through `handlePendingToolCall` —
 * the result is never re-prompted as user text.
 */
export class CopilotAgent extends AbstractAgent {
  private readonly threads = new Map<string, Thread>();
  private readonly config: CopilotAgentConfig;

  constructor(config: CopilotAgentConfig) {
    super(config);
    this.config = config;
  }

  override clone(): CopilotAgent {
    return new CopilotAgent(this.config);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.threads.keys()].map((id) => this.dispose(id)));
  }

  private async dispose(threadId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    this.threads.delete(threadId);
    if (!thread?.session) return;
    await thread.session.abort().catch(() => {});
    await thread.session.disconnect().catch(() => {});
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const controller = new AbortController();
      void (async () => {
        try {
          for await (const event of this.stream(input, controller.signal)) subscriber.next(event);
          subscriber.complete();
        } catch (error) {
          subscriber.error(error);
        }
      })();
      return () => controller.abort();
    });
  }

  private async *stream(input: RunAgentInput, signal: AbortSignal): AsyncGenerator<BaseEvent> {
    const timeoutMs = this.config.runTimeoutMs ?? 120_000;
    const maxPending = this.config.maxPendingTools ?? 32;
    const deadline = Date.now() + timeoutMs;

    let thread = this.threads.get(input.threadId);
    if (!thread) {
      if (this.threads.size >= MAX_THREADS) {
        const oldest = this.threads.keys().next().value;
        if (oldest !== undefined) await this.dispose(oldest);
      }
      thread = {
        mapper: new CopilotEventMapper(),
        pending: new Map(),
        sentUserIds: new Set(),
        events: [],
        busy: false,
      };
      this.threads.set(input.threadId, thread);
    }
    if (thread.busy) throw new Error("Thread already has an active run");
    thread.busy = true;

    yield { type: E.RUN_STARTED, threadId: input.threadId, runId: input.runId };

    // Only results that resolve a call this process still holds are actionable;
    // CopilotKit replays the whole transcript on every run.
    const results = input.messages
      .filter(isToolMessage)
      .filter((message) => thread!.pending.has(message.toolCallId));
    const lastUser = [...input.messages]
      .reverse()
      .find((message): message is UserMessage => message.role === "user");
    const newUser =
      lastUser && !thread.sentUserIds.has(lastUser.id) ? textOf(lastUser.content) : undefined;

    let failure: string | undefined;
    try {
      if (!thread.session) {
        thread.session = await this.withDeadline(
          this.createSession(thread, input),
          deadline,
          "Session creation timed out",
        );
      }

      if (results.length) {
        await this.withDeadline(
          Promise.all(results.map((result) => this.resolvePending(thread!, result))),
          deadline,
          "Pending tool resolution timed out",
        );
      } else if (newUser) {
        thread.sentUserIds.add(lastUser!.id);
        await this.withDeadline(
          thread.session.send({ prompt: buildPrompt(input, newUser) }),
          deadline,
          "Prompt dispatch timed out",
        );
      } else {
        // Nothing new to do: a replayed transcript with no unresolved work.
        yield* thread.mapper.finish();
        yield { type: E.RUN_FINISHED, threadId: input.threadId, runId: input.runId };
        return;
      }

      while (true) {
        if (signal.aborted) throw new Error("Run cancelled");
        const event = await this.nextEvent(thread, deadline);
        if (!event) {
          // Quiet with suspended tool calls: hand off to the browser and end the run.
          if (thread.pending.size) break;
          throw new Error("Run timed out");
        }
        if (event.type === "session.error") throw new Error(event.data.message);
        if (event.type === "abort") throw new Error("Run cancelled");
        if (event.type === "external_tool.requested") {
          const { toolCallId, requestId, toolName } = event.data;
          if (!thread.pending.has(toolCallId) && thread.pending.size >= maxPending) {
            throw new Error("Pending frontend tool limit exceeded");
          }
          if (this.isFrontendTool(input, toolName)) thread.pending.set(toolCallId, requestId);
        }
        yield* thread.mapper.mapEvent(event);
        if (event.type === "session.idle" && !thread.pending.size) break;
      }

      yield* thread.mapper.finish();
      yield { type: E.RUN_FINISHED, threadId: input.threadId, runId: input.runId };
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      yield* thread.mapper.finish();
      yield { type: E.RUN_ERROR, message: failure, code: "COPILOT_SDK_ERROR" };
    } finally {
      thread.busy = false;
      // A failed run leaves the native session in an unknown state; drop it rather
      // than leaking the thread's session and its suspended RPCs.
      if (failure !== undefined) void this.dispose(input.threadId);
    }
  }

  private isFrontendTool(input: RunAgentInput, name: string): boolean {
    return input.tools.some((tool) => tool.name === name);
  }

  private async createSession(thread: Thread, input: RunAgentInput): Promise<CopilotSessionPort> {
    // Frontend tools are declared without a handler: that is what makes the
    // runtime suspend the call instead of executing it. The browser owns the
    // permission decision, so the runtime must not gate it.
    const frontendTools = input.tools.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
      skipPermission: true,
    }));
    const tools = [...(this.config.tools ?? []), ...frontendTools];
    return this.config.client.createSession({
      model: this.config.model ?? "gpt-5.4-mini",
      streaming: true,
      // Only the tools registered here; no built-ins. Required by `mode: "empty"`.
      availableTools: ["custom:*"],
      ...(this.config.instructions
        ? { systemMessage: { mode: "append", content: this.config.instructions } }
        : {}),
      ...byokProvider(),
      ...this.config.sessionConfig,
      tools,
      onEvent: (event: SessionEvent) => {
        thread.events.push(event);
        thread.wake?.();
      },
    } as SessionConfig);
  }

  private async resolvePending(thread: Thread, result: ToolMessage): Promise<void> {
    const requestId = thread.pending.get(result.toolCallId)!;
    thread.pending.delete(result.toolCallId);
    const response = await thread.session!.rpc.tools.handlePendingToolCall({
      requestId,
      result: result.error
        ? { textResultForLlm: result.content, resultType: "failure", error: result.error }
        : result.content,
    });
    if (!response.success) throw new Error("Native pending tool call could not be resolved");
  }

  /**
   * Returns the next native event, `undefined` once the stream goes quiet while
   * tool calls are suspended, and throws once the run deadline passes.
   */
  private async nextEvent(thread: Thread, deadline: number): Promise<SessionEvent | undefined> {
    while (!thread.events.length) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      const wait = thread.pending.size ? Math.min(HANDOFF_DELAY_MS, remaining) : remaining;
      const quiet = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          thread.wake = undefined;
          resolve(true);
        }, wait);
        thread.wake = () => {
          clearTimeout(timer);
          thread.wake = undefined;
          resolve(false);
        };
      });
      if (quiet && thread.pending.size) return undefined;
      if (quiet && Date.now() >= deadline) return undefined;
    }
    return thread.events.shift();
  }

  /** Abandons the native promise on expiry instead of awaiting a stuck RPC. */
  private withDeadline<T>(work: Promise<T>, deadline: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), Math.max(0, deadline - Date.now()));
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}
