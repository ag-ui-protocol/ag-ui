import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { firstValueFrom, toArray } from "rxjs";
import { MastraAgent } from "../mastra";

// --- Fakes ---

export class FakeMemory {
  threads: Map<string, any> = new Map();
  workingMemoryValue: string | undefined = undefined;
  recallMessages: any[] = [];

  async getThreadById({ threadId }: { threadId: string }) {
    return this.threads.get(threadId) ?? null;
  }

  async saveThread({ thread }: { thread: any }) {
    this.threads.set(thread.id, thread);
  }

  async getWorkingMemory(_opts: any): Promise<string | undefined> {
    return this.workingMemoryValue;
  }

  async recall(_opts: any): Promise<{ messages: any[] }> {
    return { messages: this.recallMessages };
  }
}

export class FakeLocalAgent {
  memory: FakeMemory;
  streamChunks: any[];

  constructor(opts: { memory?: FakeMemory; streamChunks?: any[] } = {}) {
    this.memory = opts.memory ?? new FakeMemory();
    this.streamChunks = opts.streamChunks ?? [];
  }

  async getMemory(_opts?: any) {
    return this.memory;
  }

  async stream(_messages: any, _opts?: any) {
    const chunks = this.streamChunks;
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

  constructor(opts: { streamChunks?: any[] } = {}) {
    this.streamChunks = opts.streamChunks ?? [];
  }

  async stream(_messages: any, _opts?: any) {
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
  opts: { memory?: FakeMemory; streamChunks?: any[] } = {},
) {
  return new MastraAgent({
    agentId: "test-agent",
    agent: new FakeLocalAgent(opts) as any,
    resourceId: "resource-1",
  });
}

export function makeRemoteMastraAgent(
  opts: { streamChunks?: any[] } = {},
) {
  return new MastraAgent({
    agentId: "test-agent",
    agent: new FakeRemoteAgent(opts) as any,
    resourceId: "resource-1",
  });
}
