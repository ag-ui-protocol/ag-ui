import type { ContentBlockData } from "@strands-agents/sdk";

export type StreamInput = string | ContentBlockData[];
export type StreamFactory = (input: StreamInput) => AsyncIterable<unknown>;

jest.mock("crypto", () => ({
  randomUUID: jest.fn(),
}));

const uuidMock = jest.requireMock("crypto")
  .randomUUID as jest.Mock<string, []>;

type StreamEntry =
  | { kind: "async"; factory: StreamFactory }
  | { kind: "sync"; factory: StreamFactory }
  | { kind: "none" };

const streamFactories: StreamEntry[] = [];

const emptyStream = async function* (): AsyncGenerator<never, void, unknown> {
  return;
};

interface AgentOptions {
  model?: unknown;
  systemPrompt?: unknown;
  tools?: Iterable<unknown>;
}

class MockAgent {
  model?: unknown;
  systemPrompt?: unknown;
  tools?: Iterable<unknown>;
  streamAsync: (input: StreamInput) => AsyncIterable<unknown>;
  stream?: (input: StreamInput) => AsyncIterable<unknown>;

  constructor(options?: AgentOptions) {
    this.model = options?.model;
    this.systemPrompt = options?.systemPrompt;
    this.tools = options?.tools;
    const entry = streamFactories.shift() ?? {
      kind: "async",
      factory: () => emptyStream(),
    };
    if (entry.kind === "async") {
      this.streamAsync = (input: StreamInput) => entry.factory(input);
    } else if (entry.kind === "sync") {
      this.stream = (input: StreamInput) => entry.factory(input);
      this.streamAsync = undefined as unknown as typeof this.streamAsync;
    } else {
      this.streamAsync = undefined as unknown as typeof this.streamAsync;
    }
  }

  static __pushStreamFactory(entry: StreamEntry) {
    streamFactories.push(entry);
  }

  static __reset() {
    streamFactories.length = 0;
  }
}

jest.mock("@strands-agents/sdk", () => ({
  Agent: MockAgent,
}));

const mockSdk = jest.requireMock("@strands-agents/sdk") as {
  Agent: typeof MockAgent;
};

export const pushStreamFactory = (factory: StreamFactory) => {
  mockSdk.Agent.__pushStreamFactory({ kind: "async", factory });
};

export const pushLegacyStreamFactory = (factory: StreamFactory) => {
  mockSdk.Agent.__pushStreamFactory({ kind: "sync", factory });
};

export const pushUnsupportedStream = () => {
  mockSdk.Agent.__pushStreamFactory({ kind: "none" });
};

export const resetStreamFactories = () => {
  mockSdk.Agent.__reset();
};

export function setupUuidMockSequence() {
  let counter = 0;
  uuidMock.mockImplementation(() => {
    counter += 1;
    return `uuid-${counter}`;
  });
}

export function createStream(events: unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    for (const event of events) {
      yield event;
    }
  })();
}

export { uuidMock };
