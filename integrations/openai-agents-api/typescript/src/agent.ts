import { createHash } from "node:crypto";
import { AbstractAgent, type AgentConfig } from "@ag-ui/client";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import OpenAI from "openai";
import { Observable } from "rxjs";
import { Run } from "./run";
import { InMemorySessionStore } from "./sessions";
import type {
  AgentToolParam,
  BackendTool,
  OpenAIAgentsAgentConfig,
  SessionStore,
} from "./types";

/**
 * Connects AG-UI to the OpenAI Agents API.
 *
 * Each AG-UI thread maps to one Agents API session. A run sends the thread's
 * new input to the session (user messages, frontend tool results, interrupt
 * answers) and streams the session's events back as AG-UI events.
 *
 * - Frontend tools (`RunAgentInput.tools`) are installed as function tools. When
 *   the agent calls one, the run ends and the session stays parked until the
 *   client sends the result on its next run.
 * - Backend tools (`backendTools`) run on this server; their results go back to
 *   the agent and to the UI.
 * - Backend tools can pause for the user (`context.interrupt()` or
 *   `requiresApproval`), which ends the run with an interrupt outcome. The
 *   answer arrives in `RunAgentInput.resume`.
 * - Context entries and state are sent to the agent with each user message.
 */
export class OpenAIAgentsAgent extends AbstractAgent {
  private config: OpenAIAgentsAgentConfig;
  private client: OpenAI;
  private store: SessionStore;
  private backendTools: Map<string, BackendTool>;
  private storeKeyPrefix: string;
  private savedAgentTools: Promise<AgentToolParam[] | undefined> | undefined;
  private currentRun: AbortController | undefined;

  /** Runs are serialized per thread across every agent sharing a store. */
  private static locks = new WeakMap<
    SessionStore,
    Map<string, Promise<void>>
  >();

  constructor(config: OpenAIAgentsAgentConfig & AgentConfig) {
    const {
      agentId,
      description,
      threadId,
      initialMessages,
      initialState,
      debug,
      maxEnforcedEntries,
      ...own
    } = config;
    super({
      agentId,
      description,
      threadId,
      initialMessages,
      initialState,
      debug,
      maxEnforcedEntries,
    });
    if (!own.savedAgentId && !own.agent?.model) {
      throw new Error(
        "OpenAIAgentsAgent needs `agent.model` (inline agent) or `savedAgentId` (saved agent).",
      );
    }
    const { client, sessionStore, ...settings } = own;
    this.config = settings;
    this.client = client ?? new OpenAI();
    this.store = sessionStore ?? new InMemorySessionStore();
    this.backendTools = new Map(
      (own.backendTools ?? []).map((tool) => [tool.name, tool]),
    );
    this.storeKeyPrefix =
      own.savedAgentId ??
      createHash("sha256")
        .update(
          JSON.stringify({
            agent: own.agent,
            environment: own.environment,
            tools: [...this.backendTools.keys()],
          }),
        )
        .digest("hex")
        .slice(0, 16);
  }

  /**
   * Shares the client, store and backend tools with the original, so per-request
   * clones see the same thread ↔ session mappings.
   */
  public clone(): OpenAIAgentsAgent {
    const cloned = super.clone() as OpenAIAgentsAgent;
    cloned.config = this.config;
    cloned.client = this.client;
    cloned.store = this.store;
    cloned.backendTools = this.backendTools;
    cloned.storeKeyPrefix = this.storeKeyPrefix;
    cloned.savedAgentTools = this.savedAgentTools;
    cloned.currentRun = undefined;
    return cloned;
  }

  public abortRun(): void {
    this.currentRun?.abort();
  }

  public run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const abort = new AbortController();
      this.currentRun = abort;
      let done = false;
      const storeKey = `${this.storeKeyPrefix}:${input.threadId}`;

      const execute = async () => {
        const release = await this.lock(storeKey);
        try {
          if (abort.signal.aborted) return;
          const run = new Run(
            {
              client: this.client,
              config: this.config,
              store: this.store,
              storeKey,
              backendTools: this.backendTools,
              savedAgentTools: () => this.loadSavedAgentTools(),
              reportError: (error, context) => this.reportError(error, context),
            },
            input,
            (event) => subscriber.next(event),
            abort.signal,
          );
          await run.execute();
        } finally {
          release();
        }
      };

      execute().then(
        () => {
          done = true;
          subscriber.complete();
        },
        (error) => {
          done = true;
          subscriber.error(error);
        },
      );

      return () => {
        // Unsubscribing before the run ended (client disconnect, stop button)
        // cancels the turn; the run's own cleanup sends the cancel.
        if (!done) abort.abort();
        if (this.currentRun === abort) this.currentRun = undefined;
      };
    });
  }

  private async lock(key: string): Promise<() => void> {
    let locks = OpenAIAgentsAgent.locks.get(this.store);
    if (!locks) OpenAIAgentsAgent.locks.set(this.store, (locks = new Map()));
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => current);
    locks.set(key, tail);
    await previous;
    return () => {
      release();
      if (locks!.get(key) === tail) locks!.delete(key);
    };
  }

  private loadSavedAgentTools(): Promise<AgentToolParam[] | undefined> {
    const savedAgentId = this.config.savedAgentId;
    if (!savedAgentId) return Promise.resolve(undefined);
    this.savedAgentTools ??= this.client.beta.agents
      .retrieve(savedAgentId)
      .then(
        (saved) => (saved.tools ?? []) as unknown as AgentToolParam[],
        (error) => {
          this.savedAgentTools = undefined;
          throw error;
        },
      );
    return this.savedAgentTools;
  }

  private reportError(error: unknown, context: string): void {
    const hook = this.config.onError;
    if (!hook) {
      console.error(`[openai-agents-api] ${context}:`, error);
      return;
    }
    try {
      hook(error, context);
    } catch {
      // A failing hook must not fail the run.
    }
  }
}
