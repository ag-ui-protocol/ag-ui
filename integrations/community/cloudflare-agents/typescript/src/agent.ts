import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { eventStreamResponse, isAGUIRequest, parseRunAgentInput } from "./http";
import type { PendingApproval } from "./messages";
import { ABORT_FRAME, EVENT_FRAME, RUN_FRAME, parseFrame, type EventFrame } from "./protocol";
import { runAGUI, type AGUIRun, type ApprovalStore, type StateStore } from "./run";
import type { StreamTextLike } from "./translate";

/** A WebSocket connection as the Agents SDK hands it to `onMessage`. */
export interface AGUIConnection {
  readonly id: string;
  send(message: string): void;
}

/**
 * What `withAGUI` needs from the class it extends. The Agents SDK's `Agent`
 * (and `AIChatAgent`, and any subclass of either) fits.
 */
export interface AgentLike<State = unknown> {
  readonly state: State;
  setState(state: State): void;
  onRequest(request: Request): Response | Promise<Response>;
  onMessage(connection: any, message: any): void | Promise<void>;
  onClose?(connection: any, code: number, reason: string, wasClean: boolean): void | Promise<void>;
}

type AgentClass = abstract new (...args: any[]) => AgentLike<any>;

/** The Durable Object storage calls this module uses (`this.ctx.storage`). */
interface KeyValueStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

const SYNCED_STATE_KEY = "ag-ui:synced-state";
const PENDING_APPROVALS_KEY = "ag-ui:pending-approvals";

interface SocketRun {
  connectionId: string;
  controller: AbortController;
}

interface Internals {
  stateListeners: Set<(state: unknown) => void>;
  socketRuns: Map<string, SocketRun>;
  /** Stands in for Durable Object storage when the agent has none (tests). */
  memory: Map<string, unknown>;
}

const internalsByAgent = new WeakMap<object, Internals>();

function internals(agent: object): Internals {
  let found = internalsByAgent.get(agent);
  if (!found) {
    found = { stateListeners: new Set(), socketRuns: new Map(), memory: new Map() };
    internalsByAgent.set(agent, found);
  }
  return found;
}

/**
 * Makes a Cloudflare Agents SDK agent speak AG-UI. Each AG-UI thread is one
 * agent instance (one Durable Object), and the agent's `state` is the
 * thread's shared state: the client's edits are saved into it, every
 * `this.setState()` during a run reaches the client as a STATE_SNAPSHOT, and
 * a client that comes back to the thread gets it.
 *
 * ```ts
 * import { Agent, routeAgentRequest } from "agents";
 * import { withAGUI } from "@ag-ui/cloudflare-agents";
 *
 * export class Assistant extends withAGUI(Agent<Env, State>) {
 *   onAGUIRun(run: AGUIRun<State>) {
 *     return streamText({
 *       model: openai("gpt-5-mini"),
 *       instructions: run.instructions("You are a helpful assistant."),
 *       messages: run.messages,
 *       tools: { ...run.clientTools, ...this.tools() },
 *       abortSignal: run.abortSignal,
 *     });
 *   }
 * }
 *
 * export default {
 *   fetch: async (request, env) =>
 *     (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 }),
 * };
 * ```
 *
 * The agent then serves AG-UI at `/agents/<agent>/<threadId>`:
 * - over HTTP: a POST that accepts `text/event-stream` (`HttpAgent`, or
 *   `CloudflareAgentsHttpAgent`, which adds the thread id to the URL), and
 * - over its WebSocket (`CloudflareAgentsClient`), next to the Agents SDK's
 *   own protocol.
 *
 * Tool calls paused for approval are recorded in the agent's storage, so a
 * resume can only approve a call the model actually made.
 *
 * Every other request and message goes to the base class, so an existing
 * `AIChatAgent` keeps serving its own clients. If you override `onRequest`,
 * `onMessage`, `onClose` or `setState`, call `super`.
 */
export function withAGUI<TBase extends AgentClass>(Base: TBase) {
  type State = InstanceType<TBase>["state"];

  abstract class AGUIAgent extends Base {
    /** Runs one AG-UI request. Return the result of `streamText`. */
    abstract onAGUIRun(run: AGUIRun<State>): StreamTextLike | Promise<StreamTextLike>;

    async onRequest(request: Request): Promise<Response> {
      if (isAGUIRequest(request)) return this.handleAGUIRequest(request);
      return super.onRequest(request);
    }

    /** Serves an AG-UI run over HTTP (SSE). Call it from your own `onRequest`. */
    async handleAGUIRequest(request: Request): Promise<Response> {
      let input: RunAgentInput;
      try {
        input = parseRunAgentInput(await request.json());
      } catch (error) {
        return new Response(error instanceof Error ? error.message : "Invalid request body", {
          status: 400,
        });
      }
      const controller = new AbortController();
      request.signal?.addEventListener("abort", () => controller.abort(), { once: true });
      return eventStreamResponse(this.aguiEvents(input, controller.signal), {
        onCancel: () => controller.abort(),
      });
    }

    async onMessage(connection: AGUIConnection, message: unknown): Promise<void> {
      const frame = parseFrame(message);
      if (!frame) return super.onMessage(connection, message);
      const runs = internals(this).socketRuns;

      if (frame.type === ABORT_FRAME && typeof frame.runId === "string") {
        const run = runs.get(frame.runId);
        if (run?.connectionId === connection.id) run.controller.abort();
        return;
      }
      if (frame.type !== RUN_FRAME) return;

      const runId = (frame.input as { runId?: unknown } | undefined)?.runId;
      let input: RunAgentInput;
      try {
        input = parseRunAgentInput(frame.input);
      } catch (error) {
        if (typeof runId === "string") send(connection, runId, runErrorEvent(error, "INVALID_INPUT"));
        return;
      }

      const controller = new AbortController();
      runs.set(input.runId, { connectionId: connection.id, controller });
      let ended = false;
      try {
        for await (const event of this.aguiEvents(input, controller.signal)) {
          if (!send(connection, input.runId, event)) {
            controller.abort();
            break;
          }
          if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) ended = true;
        }
      } catch (error) {
        // The client waits for a terminal event; never leave it hanging.
        if (!ended) send(connection, input.runId, runErrorEvent(error, "INTERNAL_ERROR"));
      } finally {
        runs.delete(input.runId);
      }
    }

    async onClose(connection: AGUIConnection, code: number, reason: string, wasClean: boolean) {
      for (const run of internals(this).socketRuns.values()) {
        if (run.connectionId === connection.id) run.controller.abort();
      }
      return super.onClose?.(connection, code, reason, wasClean);
    }

    setState(state: State): void {
      super.setState(state);
      for (const listener of internals(this).stateListeners) listener(state);
    }

    /** The AG-UI events of one run, with this agent's state as the shared state. */
    async *aguiEvents(input: RunAgentInput, signal: AbortSignal): AsyncGenerator<BaseEvent> {
      const release = await keepAlive(this);
      try {
        yield* runAGUI<State>(input, (run) => this.onAGUIRun(run), {
          signal,
          state: agentStateStore<State>(this),
          approvals: agentApprovalStore(this),
        });
      } finally {
        release?.();
      }
    }
  }

  return AGUIAgent;
}

/** Keeps the Durable Object resident while the model streams, where the Agents SDK offers it. */
async function keepAlive(agent: object): Promise<(() => void) | undefined> {
  const keepAlive = (agent as { keepAlive?: () => Promise<() => void> }).keepAlive;
  if (typeof keepAlive !== "function") return undefined;
  try {
    return await keepAlive.call(agent);
  } catch {
    // An optimisation only: the run works without it.
    return undefined;
  }
}

/** `this.ctx.storage` of a Durable Object, or an in-memory stand-in. */
function storageOf(agent: object): KeyValueStorage {
  const storage = (agent as { ctx?: { storage?: Partial<KeyValueStorage> } }).ctx?.storage;
  if (storage && typeof storage.get === "function" && typeof storage.put === "function") {
    return storage as KeyValueStorage;
  }
  const memory = internals(agent).memory;
  return {
    get: async <T>(key: string) => memory.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => void memory.set(key, value),
  };
}

function agentStateStore<State>(agent: AgentLike<State>): StateStore<State> {
  const listeners = internals(agent).stateListeners;
  const storage = storageOf(agent);
  return {
    get: () => agent.state,
    set: (state) => agent.setState(state),
    subscribe(listener) {
      const wrapped = listener as (state: unknown) => void;
      listeners.add(wrapped);
      return () => listeners.delete(wrapped);
    },
    synced: () => storage.get(SYNCED_STATE_KEY),
    markSynced: (state) => storage.put(SYNCED_STATE_KEY, state),
  };
}

function agentApprovalStore(agent: object): ApprovalStore {
  const storage = storageOf(agent);
  return {
    load: async () => (await storage.get<PendingApproval[]>(PENDING_APPROVALS_KEY)) ?? [],
    save: (approvals) => storage.put(PENDING_APPROVALS_KEY, approvals),
  };
}

function runErrorEvent(error: unknown, code: string): BaseEvent {
  return {
    type: EventType.RUN_ERROR,
    message: error instanceof Error ? error.message : String(error),
    code,
  } as BaseEvent;
}

/** Sends one event frame; false when the socket is gone. */
function send(connection: AGUIConnection, runId: string, event: BaseEvent): boolean {
  const frame: EventFrame = { type: EVENT_FRAME, runId, event };
  try {
    connection.send(JSON.stringify(frame));
    return true;
  } catch {
    return false;
  }
}
