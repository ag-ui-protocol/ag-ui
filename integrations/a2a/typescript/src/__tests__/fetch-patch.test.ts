let A2AAgent: typeof import("../agent.js").A2AAgent;

/** A client whose stream parks until its gate is released. */
const gatedClient = () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = {
    sendMessageStream: async function* () {
      await gate;
      yield { kind: "message", messageId: "m", role: "agent", parts: [] };
    },
    sendMessage: async () => ({ jsonrpc: "2.0", id: 1, result: {} }),
    isErrorResponse: () => false,
  };
  return { client, release };
};

const drain = async (iterator: AsyncGenerator<unknown>) => {
  for await (const _ of iterator) {
    // consume
  }
};

describe("A2AAgent A2UI extension fetch patch", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    ({ A2AAgent } = await import("../agent.js"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    // A failed assertion may leave streams parked and the module's depth nonzero.
    // Reimport a fresh module in the next test rather than exporting test-only state.
    vi.resetModules();
  });
  // Guards against a permanently hijacked global fetch: each stream saved
  // "whatever fetch is now" and put it back when it ended, so two overlapping
  // runs restored each other's wrapper and every later fetch in the process
  // carried the X-A2A-Extensions header.
  it("restores the original global fetch after overlapping streams", async () => {
    const originalFetch = globalThis.fetch;
    const a = gatedClient();
    const b = gatedClient();
    new A2AAgent({ a2aClient: a.client as any });
    new A2AAgent({ a2aClient: b.client as any });

    const streamA = (a.client.sendMessageStream as any)({});
    const pendingA = drain(streamA);
    const streamB = (b.client.sendMessageStream as any)({});
    const pendingB = drain(streamB);

    a.release();
    await pendingA;
    b.release();
    await pendingB;

    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("adds the extension header while a stream is in flight", async () => {
    const originalFetch = globalThis.fetch;
    const seen: Headers[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response("{}");
    }) as typeof fetch;
    try {
      const a = gatedClient();
      new A2AAgent({ a2aClient: a.client as any });
      const pending = drain((a.client.sendMessageStream as any)({}));
      await globalThis.fetch("https://agent.example/");
      a.release();
      await pending;
      expect(seen[0].get("X-A2A-Extensions")).toContain("a2ui");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
