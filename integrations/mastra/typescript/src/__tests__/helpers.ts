import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
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
    } = {},
  ) {
    this.memory = opts.memory ?? new FakeMemory();
    this.streamChunks = opts.streamChunks ?? [];
    this.resumeChunks = opts.resumeChunks;
  }

  async getMemory(_opts?: any) {
    return this.memory;
  }

  async stream(messages: any, opts?: any) {
    this.lastStreamMessages = messages;
    this.lastStreamOpts = opts;
    const chunks = this.streamChunks;
    return {
      fullStream: (async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })(),
    };
  }

  async resumeStream(_resumeData: any, opts?: any) {
    this.lastResumeOpts = opts;
    const chunks = this.resumeChunks ?? [];
    return {
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
  // Chunks replayed by resumeStream's processDataStream. When undefined, the
  // remote agent has no resume capability (mirrors older @mastra/client-js).
  resumeChunks: any[] | undefined;
  // Records every resumeStream(resumeData, opts) call for assertions.
  resumeCalls: Array<{ resumeData: any; opts: any }> = [];

  constructor(opts: { streamChunks?: any[]; resumeChunks?: any[] } = {}) {
    this.streamChunks = opts.streamChunks ?? [];
    this.resumeChunks = opts.resumeChunks;
  }

  /** Options passed to the most recent stream() call. */
  lastStreamOpts: any = null;

  async stream(messages: any, opts?: any) {
    this.lastStreamMessages = messages;
    this.lastStreamOpts = opts;
    const chunks = this.streamChunks;
    return {
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

export function collectError(
  agent: MastraAgent,
  input: RunAgentInput,
): Promise<{ error: Error; events: BaseEvent[] }> {
  const events: BaseEvent[] = [];
  return new Promise((resolve, reject) => {
    agent.run(input).subscribe({
      next: (event) => events.push(event),
      error: (err) => resolve({ error: err, events }),
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
    emitInterruptOutcome?: boolean;
  } = {},
) {
  return new MastraAgent({
    agentId: "test-agent",
    agent: new FakeLocalAgent(opts) as any,
    resourceId: "resource-1",
    emitInterruptOutcome: opts.emitInterruptOutcome,
  });
}

export function makeRemoteMastraAgent(
  opts: {
    streamChunks?: any[];
    resumeChunks?: any[];
    emitInterruptOutcome?: boolean;
  } = {},
) {
  return new MastraAgent({
    agentId: "test-agent",
    agent: new FakeRemoteAgent(opts) as any,
    resourceId: "resource-1",
    emitInterruptOutcome: opts.emitInterruptOutcome,
  });
}
