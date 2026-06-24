import { Observable, ReplaySubject } from "rxjs";
import type { BaseEvent } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import type { MastraMemory } from "@mastra/core/memory";

// ---------------------------------------------------------------------------
// Types for Mastra DB messages returned by memory.recall()
// ---------------------------------------------------------------------------

interface MastraMessageContent {
  format?: number;
  parts?: Array<Record<string, unknown>>;
  content?: string;
  toolInvocations?: Array<Record<string, unknown>>;
}

interface MastraMsg {
  id: string;
  role: "user" | "assistant" | "system";
  content: MastraMessageContent | string;
  createdAt: Date;
}

// AG-UI message types
interface AGUIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface AGUIUserMessage {
  id: string;
  role: "user";
  content: string;
}

interface AGUIAssistantMessage {
  id: string;
  role: "assistant";
  content?: string;
  toolCalls?: AGUIToolCall[];
}

interface AGUIToolMessage {
  id: string;
  role: "tool";
  toolCallId: string;
  content: string;
}

type AGUIMessage = AGUIUserMessage | AGUIAssistantMessage | AGUIToolMessage;

// ---------------------------------------------------------------------------
// Tool invocation shape stored in Mastra V2 parts
// ---------------------------------------------------------------------------

interface MastraToolInvocation {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  state?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(content: MastraMessageContent | string): string {
  if (typeof content === "string") return content;

  if (content.parts?.length) {
    const texts = content.parts
      .filter(
        (p): p is { type: "text"; text: string } =>
          (p as { type?: string }).type === "text" &&
          typeof (p as { text?: unknown }).text === "string",
      )
      .map((p) => p.text);
    if (texts.length > 0) return texts.join("");
  }

  if (typeof content.content === "string") return content.content;
  return "";
}

function extractToolInvocations(
  content: MastraMessageContent | string,
): MastraToolInvocation[] {
  if (typeof content === "string") return [];

  if (content.parts?.length) {
    return content.parts
      .filter((p) => (p as { type?: string }).type === "tool-invocation")
      .map((p) => {
        const inv =
          (p as { toolInvocation?: MastraToolInvocation }).toolInvocation ??
          (p as unknown as MastraToolInvocation);
        return {
          toolCallId: inv.toolCallId ?? crypto.randomUUID(),
          toolName: inv.toolName ?? "unknown",
          args: inv.args ?? {},
          result: inv.result,
          state: inv.state,
        };
      });
  }

  if (content.toolInvocations?.length) {
    return content.toolInvocations.map((inv) => {
      const t = inv as unknown as MastraToolInvocation;
      return {
        toolCallId: t.toolCallId ?? crypto.randomUUID(),
        toolName: t.toolName ?? "unknown",
        args: t.args ?? {},
        result: t.result,
        state: t.state,
      };
    });
  }

  return [];
}

// ---------------------------------------------------------------------------
// Convert Mastra messages → AG-UI messages (preserving original order)
// ---------------------------------------------------------------------------

function convertMastraMessagesToAGUI(messages: MastraMsg[]): AGUIMessage[] {
  const result: AGUIMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      const text = extractText(msg.content);
      if (text) {
        result.push({ id: msg.id, role: "user", content: text });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const text = extractText(msg.content);
      const invocations = extractToolInvocations(msg.content).filter(
        (inv) => inv.state === "result",
      );

      if (invocations.length > 0) {
        const toolCalls: AGUIToolCall[] = invocations.map((inv) => ({
          id: inv.toolCallId,
          type: "function" as const,
          function: {
            name: inv.toolName,
            arguments: JSON.stringify(inv.args),
          },
        }));

        result.push({
          id: msg.id,
          role: "assistant",
          content: text || "",
          toolCalls,
        });

        for (const inv of invocations) {
          const resultContent =
            inv.result !== undefined
              ? typeof inv.result === "string"
                ? inv.result
                : JSON.stringify(inv.result)
              : "{}";

          result.push({
            id: crypto.randomUUID(),
            role: "tool",
            toolCallId: inv.toolCallId,
            content: resultContent,
          });
        }
      } else if (text) {
        result.push({ id: msg.id, role: "assistant", content: text });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Build history replay events
// ---------------------------------------------------------------------------

function buildHistoryEvents(
  threadId: string,
  aguiMessages: AGUIMessage[],
): BaseEvent[] {
  const runId = crypto.randomUUID();

  return [
    {
      type: EventType.RUN_STARTED,
      threadId,
      runId,
    } as BaseEvent,
    {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: aguiMessages,
    } as BaseEvent,
    {
      type: EventType.RUN_FINISHED,
      threadId,
      runId,
    } as BaseEvent,
  ];
}

// ---------------------------------------------------------------------------
// In-memory event store (per-thread)
// ---------------------------------------------------------------------------

interface ThreadStore {
  events: BaseEvent[];
  running: boolean;
}

// ---------------------------------------------------------------------------
// MastraMemoryAgentRunner
// ---------------------------------------------------------------------------

// Track hydrated threads globally to survive HMR re-evaluations in dev mode
const _hydratedThreads: Set<string> =
  ((globalThis as any).__mastraHydratedThreads ??= new Set<string>());

/**
 * An AgentRunner that preloads thread history from Mastra memory.
 *
 * On the first `run()` for a given thread, it loads historical messages from
 * Mastra's persistent memory and emits them as a MESSAGES_SNAPSHOT event
 * before the actual agent run begins. This ensures the client UI displays
 * the full conversation history without requiring a custom runner.
 *
 * On `connect()`, if the in-memory event store is empty (e.g. after a server
 * restart), it falls back to loading history from Mastra memory.
 *
 * @example
 * ```ts
 * import { MastraMemoryAgentRunner } from "@ag-ui/mastra/copilotkit";
 *
 * const runner = new MastraMemoryAgentRunner(memory);
 * const runtime = new CopilotRuntime({ agents, runner });
 * ```
 */
export class MastraMemoryAgentRunner {
  private memory: MastraMemory;
  private threads = new Map<string, ThreadStore>();

  constructor(memory: MastraMemory) {
    this.memory = memory;
  }

  private getOrCreateThread(threadId: string): ThreadStore {
    let store = this.threads.get(threadId);
    if (!store) {
      store = { events: [], running: false };
      this.threads.set(threadId, store);
    }
    return store;
  }

  run(request: {
    threadId: string;
    agent: any;
    input: any;
  }): Observable<BaseEvent> {
    const { threadId, agent, input } = request;
    const store = this.getOrCreateThread(threadId);
    store.running = true;

    const agentObs: Observable<BaseEvent> = agent.run(input);

    // If already hydrated, run directly and record events
    if (_hydratedThreads.has(threadId)) {
      return new Observable<BaseEvent>((subscriber) => {
        agentObs.subscribe({
          next: (event: BaseEvent) => {
            store.events.push(event);
            subscriber.next(event);
          },
          error: (err: unknown) => {
            store.running = false;
            subscriber.error(err);
          },
          complete: () => {
            store.running = false;
            subscriber.complete();
          },
        });
      });
    }

    // First run on this thread — hydrate from memory first
    _hydratedThreads.add(threadId);

    const subject = new ReplaySubject<BaseEvent>(Infinity);

    this.loadHistoryEvents(threadId)
      .then((historicalEvents) => {
        for (const event of historicalEvents) {
          store.events.push(event);
          subject.next(event);
        }
        agentObs.subscribe({
          next: (event: BaseEvent) => {
            store.events.push(event);
            subject.next(event);
          },
          error: (err: unknown) => {
            store.running = false;
            subject.error(err);
          },
          complete: () => {
            store.running = false;
            subject.complete();
          },
        });
      })
      .catch((err) => {
        console.error(
          "[MastraMemoryAgentRunner] Failed to hydrate, continuing without history:",
          err,
        );
        agentObs.subscribe({
          next: (event: BaseEvent) => {
            store.events.push(event);
            subject.next(event);
          },
          error: (err: unknown) => {
            store.running = false;
            subject.error(err);
          },
          complete: () => {
            store.running = false;
            subject.complete();
          },
        });
      });

    return subject.asObservable();
  }

  connect(request: { threadId: string }): Observable<BaseEvent> {
    const store = this.threads.get(request.threadId);
    const storedEvents = store?.events ?? [];

    // If we have stored events, replay them
    if (storedEvents.length > 0) {
      return new Observable<BaseEvent>((subscriber) => {
        for (const event of storedEvents) {
          subscriber.next(event);
        }
        subscriber.complete();
      });
    }

    // No stored events — fall back to Mastra memory
    const subject = new ReplaySubject<BaseEvent>(Infinity);

    _hydratedThreads.add(request.threadId);
    this.loadHistoryEvents(request.threadId)
      .then((events) => {
        const threadStore = this.getOrCreateThread(request.threadId);
        for (const event of events) {
          threadStore.events.push(event);
          subject.next(event);
        }
        subject.complete();
      })
      .catch((err) => {
        console.error(
          "[MastraMemoryAgentRunner] connect() failed to load from memory:",
          err,
        );
        subject.complete();
      });

    return subject.asObservable();
  }

  async isRunning(request: { threadId: string }): Promise<boolean> {
    return this.threads.get(request.threadId)?.running ?? false;
  }

  async stop(request: { threadId: string }): Promise<boolean> {
    const store = this.threads.get(request.threadId);
    if (store) {
      store.running = false;
      return true;
    }
    return false;
  }

  private async loadHistoryEvents(threadId: string): Promise<BaseEvent[]> {
    try {
      const result = await this.memory.recall({
        threadId,
        perPage: false,
      });

      const messages = (result?.messages ?? []) as unknown as MastraMsg[];
      if (messages.length === 0) return [];

      const aguiMessages = convertMastraMessagesToAGUI(messages);
      if (aguiMessages.length === 0) return [];

      return buildHistoryEvents(threadId, aguiMessages);
    } catch (err) {
      console.error(
        "[MastraMemoryAgentRunner] Error loading thread history:",
        err,
      );
      return [];
    }
  }
}
