import type OpenAI from "openai";
import type { BaseEvent, Interrupt, ResumeEntry, State } from "@ag-ui/core";

/** Agent settings for a session, as accepted by `sessions.create({ agent })`. */
export type SessionAgentConfig =
  OpenAI.Beta.Agents.Sessions.SessionCreateParams.Agent;

/** An execution environment, as accepted by `sessions.create({ environment })`. */
export type EnvironmentConfig = OpenAI.Beta.Agents.EnvironmentParam;

/** A tool definition as accepted by the Agents API. */
export type AgentToolParam = OpenAI.Beta.Agents.AgentToolParam;

/** One event from a session's live stream. */
export type SessionEvent = OpenAI.Beta.Agents.AgentSessionEvent;

/** A session as returned by `sessions.retrieve`. */
export type AgentSession = OpenAI.Beta.Agents.AgentSession;

/** An input event accepted by `sessions.events.create`. */
export type SessionInputEvent = OpenAI.Beta.Agents.AgentSessionInputParam;

/** A content part of a session input message. */
export type InputContentPart = OpenAI.Beta.Agents.InputContentParam;

export type RequiredAction = AgentSession["required_actions"][number];
export type FunctionCallAction = Extract<
  RequiredAction,
  { type: "function_call" }
>;
export type ApprovalRequestAction = Extract<
  RequiredAction,
  { type: "computer_use_approval_request" }
>;

/**
 * What a backend tool raises to pause the run until the user answers.
 *
 * The OpenAI session stays parked on the tool call while the interrupt is
 * open, so the pause is durable on OpenAI's side: resuming only needs the tool
 * call id, which is also the interrupt id.
 */
export interface InterruptRequest {
  /** Why the run stopped. Defaults to `"openai_agents:tool_interrupt"`. */
  reason?: string;
  /** A human-readable prompt for whoever answers. */
  message?: string;
  /** Data the UI needs to render the question. Published as `metadata.payload`. */
  payload?: unknown;
  /** JSON Schema of the expected answer. */
  responseSchema?: Record<string, unknown>;
  /** Extra metadata merged into the interrupt's `metadata`. */
  metadata?: Record<string, unknown>;
}

/** Everything a backend tool handler can see and do. */
export interface BackendToolContext {
  readonly threadId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  /** The AG-UI state as of this call (includes earlier `setState` calls in the run). */
  readonly state: State;
  /** Replace the AG-UI state and publish it with STATE_SNAPSHOT. */
  setState(state: State): void;
  /** Emit any AG-UI event (STATE_DELTA, CUSTOM, ACTIVITY_SNAPSHOT, ...). */
  emit(event: BaseEvent): void;
  /**
   * Pause the run and ask the user. Never returns: the handler is invoked
   * again on the resuming run, with `resume` set to the user's answer.
   */
  interrupt(request?: InterruptRequest): never;
  /** The answer to this call's interrupt, when the handler is being resumed. */
  readonly resume?: ResumeEntry;
  /** Aborted when the run is cancelled or the client disconnects. */
  readonly signal: AbortSignal;
}

/**
 * A function tool that the adapter executes on the server. Its call and result
 * stream to the UI as TOOL_CALL_* / TOOL_CALL_RESULT, and the result is
 * returned to the agent.
 */
export interface BackendTool<TArgs = any> {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
  /** Return a string, or any JSON-serializable value. Throw to report failure to the agent. */
  handler: (
    args: TArgs,
    context: BackendToolContext,
  ) => unknown | Promise<unknown>;
  /**
   * Ask the user before running. The call is surfaced as an interrupt with
   * `reason: "tool_approval"`; approving runs the handler, rejecting returns an
   * error result to the agent without running it.
   */
  requiresApproval?: boolean | ((args: TArgs) => boolean);
  /** The prompt shown with an approval interrupt. */
  approvalMessage?: (args: TArgs) => string;
}

/**
 * Publishes a tool argument as predicted state (the `PredictState` custom
 * event) so the UI can show a state change before the tool result lands.
 */
export interface PredictStateConfig {
  /** The state key the argument updates. */
  stateKey: string;
  /** The tool whose call carries the value. */
  tool: string;
  /** The argument holding the value. */
  toolArgument: string;
}

/** What the adapter remembers about an AG-UI thread between runs. */
export interface SessionRecord {
  /** The OpenAI session behind the thread. */
  sessionId: string;
  /** Fingerprint of the function tools last installed on the session. */
  toolsFingerprint: string;
  /** AG-UI user message ids already forwarded to the session. */
  deliveredMessageIds: string[];
  /** OpenAI item ids already surfaced to the client (used to drop stream replays). */
  surfacedItemIds: string[];
  /** Frontend tool calls handed to the client and not answered yet. */
  clientToolCallIds: string[];
  /** Function calls this adapter has submitted a result for. */
  answeredCallIds: string[];
  /** Interrupts the client has been asked to answer, by interrupt id. */
  openInterrupts: Record<string, OpenInterrupt>;
  /** When a cancel was last sent for this session (epoch ms). */
  cancelRequestedAt?: number;
}

/** An interrupt waiting for the client, and what answering it means. */
export interface OpenInterrupt {
  /**
   * `approval`: a backend tool waiting for approval. `tool`: a backend tool
   * that called `context.interrupt()`. `computer_use`: a native computer-use
   * approval request.
   */
  kind: "approval" | "tool" | "computer_use";
  interrupt: Interrupt;
}

/** Thread ↔ session persistence. Implement it to survive restarts or scale out. */
export interface SessionStore {
  get(
    key: string,
  ): SessionRecord | undefined | Promise<SessionRecord | undefined>;
  set(key: string, record: SessionRecord): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

export interface OpenAIAgentsAgentConfig {
  /** Bring your own client. Defaults to `new OpenAI()` (reads `OPENAI_API_KEY`). */
  client?: OpenAI;
  /**
   * Inline agent settings: `model`, `instructions`, built-in `tools`
   * (web_search, mcp, ...), `reasoning`, `text`, ... Required unless
   * `savedAgentId` is set; with it, these override the saved agent.
   */
  agent?: SessionAgentConfig;
  /** A saved agent (`client.beta.agents.create`) to run, by its `agent_...` id. */
  savedAgentId?: string;
  /** Execution environment for new sessions. Defaults to `{ type: "none" }`. */
  environment?: EnvironmentConfig;
  /** Tools executed by this server. */
  backendTools?: BackendTool[];
  /** Publish tool arguments as predicted state. */
  predictState?: PredictStateConfig[];
  /**
   * Attach the links in each answer as `metadata.citations` on its
   * TEXT_MESSAGE_END. The Agents API returns web search sources as markdown
   * links in the text. Default `false`.
   */
  extractLinkCitations?: boolean;
  /**
   * Forward `RunAgentInput.state` to the agent with each message, so it can
   * read (and, through backend tools, write) shared state. Default `true`.
   */
  forwardState?: boolean;
  /** Thread ↔ session mapping. Defaults to a bounded in-memory store. */
  sessionStore?: SessionStore;
  /** Metadata attached to sessions this adapter creates. */
  sessionMetadata?: Record<string, string>;
  /** Vaults with credentials the session may use. */
  vaultIds?: string[];
  /**
   * How long the session must stay parked on client-side work (frontend tool
   * calls, interrupts) before the run ends. The Agents API reports parallel
   * calls one at a time, so a short pause lets several arrive in one run.
   * Calls that arrive later are surfaced on the next run. Default 1000 ms.
   */
  clientToolSettleMs?: number;
  /** Maximum duration of one run before the turn is cancelled. Default 10 minutes. */
  runTimeoutMs?: number;
  /** Notified about failures the adapter recovers from (e.g. a failed cancel). */
  onError?: (error: unknown, context: string) => void;
}
