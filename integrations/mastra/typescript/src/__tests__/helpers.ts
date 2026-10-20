import type {
  BaseEvent,
  Message,
  RunAgentInput,
  RunAgentParameters,
} from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { firstValueFrom, toArray } from "rxjs";
import { MastraAgent } from "../mastra";

// --- Fakes ---

export class FakeMemory {
  threads: Map<string, any> = new Map();
  workingMemoryValue: string | undefined = undefined;
  recallMessages: any[] = [];
  /** Records every updateWorkingMemory call (the input.state -> WM sync). */
  updateWorkingMemoryCalls: Array<{
    resourceId?: string;
    threadId?: string;
    workingMemory: string;
    memoryConfig?: any;
  }> = [];

  async getThreadById({ threadId }: { threadId: string }) {
    return this.threads.get(threadId) ?? null;
  }

  async saveThread({ thread }: { thread: any }) {
    this.threads.set(thread.id, thread);
  }

  /** Records every createThread call (the first-turn thread-scope sync). */
  createThreadCalls: Array<{ threadId?: string; resourceId: string }> = [];

  async createThread(args: { threadId?: string; resourceId: string }) {
    this.createThreadCalls.push(args);
    const thread = { id: args.threadId, resourceId: args.resourceId };
    this.threads.set(thread.id!, thread);
    return thread;
  }

  async getWorkingMemory(_opts: any): Promise<string | undefined> {
    return this.workingMemoryValue;
  }

  // Mirrors Mastra's resource-scoped working-memory store: the input.state
  // sync writes HERE (not thread.metadata), and a later getWorkingMemory
  // reflects it, so the round-trip the agent sees is faithful.
  async updateWorkingMemory(args: {
    resourceId?: string;
    threadId?: string;
    workingMemory: string;
    memoryConfig?: any;
  }): Promise<void> {
    this.updateWorkingMemoryCalls.push(args);
    this.workingMemoryValue = args.workingMemory;
  }

  async recall(_opts: any): Promise<{ messages: any[] }> {
    return { messages: this.recallMessages };
  }
}

export class FakeLocalAgent {
  memory: FakeMemory;
  streamChunks: any[];
  resumeChunks: any[] | undefined;
  // Execution traceId to expose on the stream response (Mastra observability
  // v-next). Left undefined by default so it doesn't affect tests that don't
  // opt into it. May be a plain string or a Promise (mirrors the real API).
  traceId: string | Promise<string> | undefined;
  // AI-SDK-style usage exposed on the stream response (a value or a promise).
  // Undefined by default so existing tests are unaffected.
  usage: any;
  // AI-SDK-style model instance (`{ provider, modelId }`) used by the bridge to
  // label token usage. Undefined by default.
  model: any;
  /** Messages passed to the most recent stream() call (post-diff-filter). */
  lastStreamMessages: any[] | null = null;
  /** Options passed to the most recent stream() call. */
  lastStreamOpts: any = null;
  /** Options passed to the most recent resumeStream() call. */
  lastResumeOpts: any = null;

  constructor(
    opts: {
      memory?: FakeMemory;
      streamChunks?: any[];
      resumeChunks?: any[];
      traceId?: string | Promise<string>;
      usage?: any;
      model?: any;
    } = {},
  ) {
    this.memory = opts.memory ?? new FakeMemory();
    this.streamChunks = opts.streamChunks ?? [];
    this.resumeChunks = opts.resumeChunks;
    this.traceId = opts.traceId;
    this.usage = opts.usage;
    this.model = opts.model;
  }

  async getMemory(_opts?: any) {
    return this.memory;
  }

  async stream(messages: any, opts?: any) {
    this.lastStreamMessages = messages;
    this.lastStreamOpts = opts;
    const chunks = this.streamChunks;
    return {
      ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      ...(this.usage !== undefined ? { usage: this.usage } : {}),
      fullStream: (async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })(),
    };
  }

  /** Records every approveToolCall / declineToolCall call. */
  toolApprovalCalls: Array<{ approved: boolean; opts: any }> = [];

  // Mirrors @mastra/core: both are resumeStream({ approved }) on the snapshot.
  async approveToolCall(opts: any) {
    this.toolApprovalCalls.push({ approved: true, opts });
    return this.resumeStream({ approved: true }, opts);
  }

  async declineToolCall(opts: any) {
    this.toolApprovalCalls.push({ approved: false, opts });
    return this.resumeStream({ approved: false }, opts);
  }

  async resumeStream(_resumeData: any, opts?: any) {
    this.lastResumeOpts = opts;
    const chunks = this.resumeChunks ?? [];
    return {
      // Mirror stream()'s optional traceId so resume-path traceId surfacing can
      // be exercised. Additive; undefined by default so existing tests are
      // unaffected.
      ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      // A resumed run makes its own model calls and reports its own usage, so
      // mirror stream()'s usage exposure here too.
      ...(this.usage !== undefined ? { usage: this.usage } : {}),
      fullStream: (async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })(),
    };
  }
}

export class FakeRemoteAgent {
  streamChunks: any[];
  lastStreamMessages: any[] | null = null;
  // Chunks replayed by resumeStream's processDataStream.
  resumeChunks: any[] | undefined;
  // Execution traceId to expose on the stream response. Undefined by default.
  traceId: string | Promise<string> | undefined;
  // Records every resumeStream(resumeData, opts) call for assertions.
  resumeCalls: Array<{ resumeData: any; opts: any }> = [];

  constructor(
    opts: {
      streamChunks?: any[];
      resumeChunks?: any[];
      traceId?: string | Promise<string>;
    } = {},
  ) {
    this.streamChunks = opts.streamChunks ?? [];
    this.resumeChunks = opts.resumeChunks;
    this.traceId = opts.traceId;
  }

  /** Options passed to the most recent stream() call. */
  lastStreamOpts: any = null;

  async stream(messages: any, opts?: any) {
    this.lastStreamMessages = messages;
    this.lastStreamOpts = opts;
    const chunks = this.streamChunks;
    return {
      ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      processDataStream: async ({
        onChunk,
      }: {
        onChunk: (chunk: any) => Promise<void>;
      }) => {
        for (const chunk of chunks) {
          await onChunk(chunk);
        }
      },
    };
  }

  async resumeStream(resumeData: any, opts: any) {
    this.resumeCalls.push({ resumeData, opts });
    const chunks = this.resumeChunks ?? [];
    return {
      // Mirror stream()'s optional traceId so resume-path traceId surfacing can
      // be exercised. Additive; undefined by default so existing tests are
      // unaffected.
      ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      processDataStream: async ({
        onChunk,
      }: {
        onChunk: (chunk: any) => Promise<void>;
      }) => {
        for (const chunk of chunks) {
          await onChunk(chunk);
        }
      },
    };
  }
}

export function makeInput(
  overrides: Partial<RunAgentInput> = {},
): RunAgentInput {
  return {
    threadId: "thread-1",
    runId: "run-1",
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
    state: undefined,
    ...overrides,
  } as RunAgentInput;
}

export function collectEvents(
  agent: MastraAgent,
  input: RunAgentInput,
): Promise<BaseEvent[]> {
  return firstValueFrom(agent.run(input).pipe(toArray()));
}

/**
 * Runs `agent` from `history` through the real AG-UI client pipeline (chunk
 * expansion, verification, reducer) and returns the message list it ends with.
 */
export async function runThroughClient(
  agent: MastraAgent,
  history: Message[],
  params: RunAgentParameters,
): Promise<Message[]> {
  agent.threadId = "thread-1";
  agent.setMessages(history);
  await agent.runAgent(params);
  return agent.messages;
}

/**
 * Runs `input` to a failure: exactly one RUN_ERROR as the last event, then an
 * Observable error. Rejects if the run completes or errors without that event.
 */
export function collectRunError(
  agent: MastraAgent,
  input: RunAgentInput,
): Promise<{ error: Error; events: BaseEvent[] }> {
  const events: BaseEvent[] = [];
  return new Promise((resolve, reject) => {
    agent.run(input).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        const last = events[events.length - 1];
        const runErrors = events.filter((e) => e.type === EventType.RUN_ERROR);
        if (runErrors.length === 1 && last?.type === EventType.RUN_ERROR) {
          resolve({ error: err, events });
        } else {
          reject(
            new Error(
              `Expected one RUN_ERROR before the error, got: ${events.map((e) => e.type).join(", ")}`,
            ),
          );
        }
      },
      complete: () => reject(new Error("Expected error but completed")),
    });
  });
}

// --- Agent factories (centralizes the `as any` cast) ---

export function makeLocalMastraAgent(
  opts: {
    memory?: FakeMemory;
    streamChunks?: any[];
    resumeChunks?: any[];
    traceId?: string | Promise<string>;
    streamServerToolCalls?: boolean;
    observationalMemory?: boolean;
    usage?: any;
    model?: any;
    useProcessedFinalText?: boolean;
  } = {},
) {
  return new MastraAgent({
    agentId: "test-agent",
    agent: new FakeLocalAgent(opts) as any,
    resourceId: "resource-1",
    streamServerToolCalls: opts.streamServerToolCalls,
    observationalMemory: opts.observationalMemory,
    useProcessedFinalText: opts.useProcessedFinalText,
  });
}

export function makeRemoteMastraAgent(
  opts: {
    streamChunks?: any[];
    resumeChunks?: any[];
    traceId?: string | Promise<string>;
    streamServerToolCalls?: boolean;
    observationalMemory?: boolean;
    useProcessedFinalText?: boolean;
  } = {},
) {
  return new MastraAgent({
    agentId: "test-agent",
    agent: new FakeRemoteAgent(opts) as any,
    resourceId: "resource-1",
    streamServerToolCalls: opts.streamServerToolCalls,
    observationalMemory: opts.observationalMemory,
    useProcessedFinalText: opts.useProcessedFinalText,
  });
}

// --- Provider HTTP stubs (for real @mastra/core agents on router models) ---

type JsonObject = Record<string, unknown>;

/** A provider HTTP request as the stubbed fetch received it. */
export interface ProviderRequest {
  url: string;
  body: JsonObject;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonObjects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function sseResponse(events: JsonObject[], withEventLine: boolean): Response {
  const text = events
    .map(
      (event) =>
        (withEventLine ? `event: ${String(event.type)}\n` : "") +
        `data: ${JSON.stringify(event)}\n\n`,
    )
    .join("");
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** An Anthropic Messages stream: a call to `toolName`, or text when omitted. */
export function anthropicStream(toolName?: string): Response {
  const start = {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
  const blocks = toolName
    ? [
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_1",
            name: toolName,
            input: {},
          },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{}" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
      ]
    : [
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Seen it." },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
      ];
  return sseResponse([start, ...blocks, { type: "message_stop" }], true);
}

/** An OpenAI Responses stream: a call to `toolName`, or text when omitted. */
export function openaiResponsesStream(toolName?: string): Response {
  const response = (status: string) => ({
    id: "resp_1",
    object: "response",
    created_at: 1,
    model: "gpt-4o-mini",
    status,
    output: [],
    incomplete_details: null,
    usage:
      status === "completed"
        ? {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          }
        : null,
  });
  let sequence = 0;
  const event = (fields: JsonObject) => ({
    ...fields,
    sequence_number: sequence++,
  });
  const created = event({
    type: "response.created",
    response: response("in_progress"),
  });
  const items = toolName
    ? [
        event({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: toolName,
            arguments: "",
            status: "in_progress",
          },
        }),
        event({
          type: "response.function_call_arguments.delta",
          item_id: "fc_1",
          output_index: 0,
          delta: "{}",
        }),
        event({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: toolName,
            arguments: "{}",
            status: "completed",
          },
        }),
      ]
    : [
        event({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "in_progress",
            content: [],
          },
        }),
        event({
          type: "response.output_text.delta",
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: "Seen it.",
          logprobs: [],
        }),
        event({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "Seen it.",
                annotations: [],
                logprobs: [],
              },
            ],
          },
        }),
      ];
  return sseResponse(
    [
      created,
      ...items,
      event({ type: "response.completed", response: response("completed") }),
    ],
    false,
  );
}

function isAnthropic(request: ProviderRequest): boolean {
  return request.url.includes("anthropic");
}

/**
 * Each tool result's content as the provider request body holds it: the
 * `tool_result` block's content (Anthropic) or the `function_call_output`
 * item's output (OpenAI Responses).
 */
export function toolResultsInBody(request: ProviderRequest): unknown[] {
  if (isAnthropic(request)) {
    return jsonObjects(request.body.messages)
      .flatMap((message) => jsonObjects(message.content))
      .filter((block) => block.type === "tool_result")
      .map((block) => block.content);
  }
  return jsonObjects(request.body.input)
    .filter((item) => item.type === "function_call_output")
    .map((item) => item.output);
}

/**
 * A fetch that records each provider request and answers it with a valid SSE
 * stream: a call to `toolName` until the body holds a tool result, then text.
 * Any other URL gets a 400, so a request outside the two providers fails.
 */
export function makeProviderFetch(
  requests: ProviderRequest[],
  toolName: string,
): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const parsed: unknown =
      typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const request = { url, body: isJsonObject(parsed) ? parsed : {} };
    requests.push(request);
    const call = toolResultsInBody(request).length === 0 ? toolName : undefined;
    if (url.startsWith("https://api.anthropic.com/")) {
      return anthropicStream(call);
    }
    if (
      url.startsWith("https://api.openai.com/") &&
      url.endsWith("/responses")
    ) {
      return openaiResponsesStream(call);
    }
    return new Response(
      JSON.stringify({ error: { message: `unexpected url ${url}` } }),
      { status: 400 },
    );
  };
}
