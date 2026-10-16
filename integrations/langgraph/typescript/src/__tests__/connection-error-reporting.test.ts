import { createServer } from "node:net";
import { describe, it, expect, vi } from "vitest";
import { EventType } from "@ag-ui/client";
import { LangGraphAgent } from "../agent";
import { describeErrorChain, withCauseInMessage } from "../utils";

/**
 * A LangGraph dev server that binds one address family while the runtime dials
 * the other (the usual Windows `localhost` -> `::1` case) makes undici throw
 * exactly this: a generic `fetch failed` whose real reason is only on `cause`.
 */
function fetchFailed(reason: string): TypeError {
  return new TypeError("fetch failed", { cause: new Error(reason) });
}

/** A LangGraphAgent whose client rejects every call with `error`. */
function agentWithFailingClient(error: unknown) {
  const agent = new LangGraphAgent({
    graphId: "sample_agent",
    deploymentUrl: "http://localhost:8123",
  });

  (agent as any).client = {
    assistants: { search: vi.fn().mockRejectedValue(error) },
    threads: {
      get: vi.fn().mockRejectedValue(error),
      create: vi.fn().mockRejectedValue(error),
    },
  };
  (agent as any).subscriber = { next: vi.fn(), error: vi.fn() };

  return agent;
}

describe("connection failures name their reason", () => {
  it("getAssistant reports the undici cause, the graph ID and the deployment URL", async () => {
    const agent = agentWithFailingClient(
      fetchFailed("connect ECONNREFUSED ::1:8123"),
    );

    await expect(agent.getAssistant()).rejects.toThrow(
      "Failed to retrieve assistant `sample_agent` from http://localhost:8123: fetch failed: connect ECONNREFUSED ::1:8123",
    );
  });

  it("getAssistant keeps the original error as the thrown error's cause", async () => {
    const original = fetchFailed("connect ECONNREFUSED ::1:8123");
    const agent = agentWithFailingClient(original);

    await expect(agent.getAssistant()).rejects.toMatchObject({
      cause: original,
    });
  });

  it("emits the same reason on the RUN_ERROR event the frontend renders", async () => {
    const agent = agentWithFailingClient(
      fetchFailed("connect ECONNREFUSED ::1:8123"),
    );
    const dispatched: any[] = [];
    (agent as any).dispatchEvent = (event: any) => {
      dispatched.push(event);
      return true;
    };

    await expect(agent.getAssistant()).rejects.toThrow();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].type).toBe(EventType.RUN_ERROR);
    expect(dispatched[0].message).toContain("connect ECONNREFUSED ::1:8123");
  });

  it("getOrCreateThread reports the undici cause and the deployment URL", async () => {
    const agent = agentWithFailingClient(
      fetchFailed("connect ECONNREFUSED ::1:8123"),
    );

    await expect(agent.getOrCreateThread("thread-1")).rejects.toThrow(
      "Failed to create thread on http://localhost:8123: fetch failed: connect ECONNREFUSED ::1:8123",
    );
  });

  it("reports the origin only, so a credential in the URL never reaches the browser", async () => {
    // The message below is put on RUN_ERROR, which the frontend renders.
    const agent = agentWithFailingClient(fetchFailed("connect ECONNREFUSED"));
    (agent as any).config = {
      graphId: "sample_agent",
      deploymentUrl: "https://user:s3cret@lg.example.com/base?api_key=s3cret",
    };

    const message = await agent.getAssistant().then(
      () => "",
      (error: Error) => error.message,
    );

    expect(message).toContain("from https://lg.example.com");
    expect(message).not.toContain("s3cret");
    expect(message).not.toContain("api_key");
  });

  it("names the deployment URL generically when it has no origin", async () => {
    // `new URL("localhost:8123")` parses, but its origin is the string "null".
    const agent = agentWithFailingClient(fetchFailed("connect ECONNREFUSED"));
    (agent as any).config = {
      graphId: "sample_agent",
      deploymentUrl: "localhost:8123",
    };

    await expect(agent.getAssistant()).rejects.toThrow(
      "from the configured deployment URL",
    );
  });

  it("names the deployment URL generically when the caller omitted it", async () => {
    const agent = agentWithFailingClient(fetchFailed("getaddrinfo ENOTFOUND"));
    (agent as any).config = { graphId: "sample_agent" };

    await expect(agent.getAssistant()).rejects.toThrow(
      "from the configured deployment URL",
    );
  });

  it("still reports a graph that the server does not know about", async () => {
    const agent = new LangGraphAgent({
      graphId: "sample_agent",
      deploymentUrl: "http://localhost:8123",
    });
    (agent as any).client = {
      assistants: {
        search: vi
          .fn()
          .mockResolvedValue([
            { graph_id: "other_agent", assistant_id: "asst-2" },
          ]),
      },
    };
    (agent as any).subscriber = { next: vi.fn(), error: vi.fn() };
    (agent as any).dispatchEvent = () => true;
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(agent.getAssistant()).rejects.toThrow(
      "No agent found with graph ID `sample_agent` on http://localhost:8123. The server returned: [other_agent (ID: asst-2)]",
    );
  });
  it("does not promise a list of available agents when the search came back empty", async () => {
    // The search is filtered by graphId, so a miss usually returns nothing at
    // all. The old message printed "These are the available agents: []".
    const agent = new LangGraphAgent({
      graphId: "sample_agent",
      deploymentUrl: "http://localhost:8123",
    });
    (agent as any).client = {
      assistants: { search: vi.fn().mockResolvedValue([]) },
    };
    (agent as any).subscriber = { next: vi.fn(), error: vi.fn() };
    (agent as any).dispatchEvent = () => true;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const message = await agent.getAssistant().then(
      () => "",
      (error: Error) => error.message,
    );

    expect(message).toBe(
      "No agent found with graph ID `sample_agent` on http://localhost:8123.",
    );
    expect(message).not.toContain("available agents");
  });

  it("does not prefix a not-found message with the wrapper", async () => {
    const agent = new LangGraphAgent({
      graphId: "sample_agent",
      deploymentUrl: "http://localhost:8123",
    });
    (agent as any).client = {
      assistants: { search: vi.fn().mockResolvedValue([]) },
    };
    (agent as any).subscriber = { next: vi.fn(), error: vi.fn() };
    (agent as any).dispatchEvent = () => true;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const message = await agent.getAssistant().then(
      () => "",
      (error: Error) => error.message,
    );

    expect(message).not.toContain("Failed to retrieve assistant");
  });
});

describe("describeErrorChain", () => {
  it("joins every link of the cause chain", () => {
    const error = new Error("outer", {
      cause: new Error("middle", { cause: new Error("inner") }),
    });

    expect(describeErrorChain(error)).toBe("outer: middle: inner");
  });

  it("returns the message unchanged when there is no cause", () => {
    expect(describeErrorChain(new Error("plain"))).toBe("plain");
  });

  it("terminates on a cyclic cause chain", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as any).cause = b;

    expect(describeErrorChain(a)).toBe("a: b");
  });

  it("stringifies a thrown non-Error", () => {
    expect(describeErrorChain("boom")).toBe("boom");
    expect(describeErrorChain({ code: 500 })).toBe("[object Object]");
  });
});

describe("describeErrorChain follows an aggregate", () => {
  it("reports both address families of a dual-stack refusal", () => {
    // What Node produces for `localhost` when neither ::1 nor 127.0.0.1
    // accepts the connection: the AggregateError's own message is empty and
    // the two real failures are on `errors`.
    const aggregate = new AggregateError([
      new Error("connect ECONNREFUSED ::1:8123"),
      new Error("connect ECONNREFUSED 127.0.0.1:8123"),
    ]);
    const error = new TypeError("fetch failed", { cause: aggregate });

    expect(describeErrorChain(error)).toBe(
      "fetch failed: connect ECONNREFUSED ::1:8123, connect ECONNREFUSED 127.0.0.1:8123",
    );
  });

  it("keeps an aggregate's own message when it has one", () => {
    const aggregate = new AggregateError(
      [new Error("first"), new Error("second")],
      "all attempts failed",
    );

    expect(describeErrorChain(aggregate)).toBe(
      "all attempts failed: first, second",
    );
  });

  it("terminates when an aggregated error points back at the aggregate", () => {
    const inner = new Error("inner");
    const aggregate = new AggregateError([inner]);
    (inner as any).cause = aggregate;

    expect(describeErrorChain(aggregate)).toBe("inner");
  });
});

describe("withCauseInMessage", () => {
  it("folds the cause into the message a transport failure carries", async () => {
    const failing = withCauseInMessage(async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("connect ECONNREFUSED ::1:8123"),
      });
    });

    await expect(failing("http://localhost:8123")).rejects.toThrow(
      "fetch failed: connect ECONNREFUSED ::1:8123",
    );
  });

  it("keeps the SDK's own classification working", async () => {
    // The SDK decides a failure is a connection failure by looking for
    // "fetch failed" in the message, so the rewritten message must still
    // contain it.
    const failing = withCauseInMessage(async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("connect ECONNREFUSED ::1:8123"),
      });
    });

    const error = await failing("http://localhost:8123").catch(
      (thrown: Error) => thrown,
    );

    expect((error as Error).message).toContain("fetch failed");
    expect((error as Error).name).toBe("TypeError");
  });

  it("passes a successful response straight through", async () => {
    const response = new Response("ok");
    const wrapped = withCauseInMessage(async () => response);

    await expect(wrapped("http://localhost:8123")).resolves.toBe(response);
  });

  it("rethrows an error that has nothing to add", async () => {
    const plain = new Error("AbortError");
    const wrapped = withCauseInMessage(async () => {
      throw plain;
    });

    await expect(wrapped("http://localhost:8123")).rejects.toBe(plain);
  });
});

/**
 * The tests above drive the agent through a stubbed client. These drive the
 * real `@langchain/langgraph-sdk` against a port nothing is listening on,
 * because the SDK is exactly where the reason used to be lost: it replaces
 * every transport failure with a fresh ConnectionError built from
 * `error.message` alone, and undici's message is the generic "fetch failed".
 */
describe("against the real SDK", () => {
  /** A localhost port that was bound and then released, so nothing answers. */
  async function closedPort(): Promise<number> {
    const server = createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as { port: number }).port);
      });
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  it("names the refused connection when the deployment is not listening", async () => {
    const port = await closedPort();
    const agent = new LangGraphAgent({
      graphId: "sample_agent",
      deploymentUrl: `http://127.0.0.1:${port}`,
    });
    (agent as any).subscriber = { next: vi.fn(), error: vi.fn() };
    (agent as any).dispatchEvent = () => true;

    const message = await agent.getAssistant().then(
      () => "",
      (error: Error) => error.message,
    );

    expect(message).toContain(`from http://127.0.0.1:${port}`);
    expect(message).toContain("ECONNREFUSED");
  }, 20000);

  it("puts the same reason on the RUN_ERROR event the frontend renders", async () => {
    const port = await closedPort();
    const agent = new LangGraphAgent({
      graphId: "sample_agent",
      deploymentUrl: `http://127.0.0.1:${port}`,
    });
    (agent as any).subscriber = { next: vi.fn(), error: vi.fn() };
    const dispatched: any[] = [];
    (agent as any).dispatchEvent = (event: any) => {
      dispatched.push(event);
      return true;
    };

    await expect(agent.getAssistant()).rejects.toThrow();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].type).toBe(EventType.RUN_ERROR);
    expect(dispatched[0].message).toContain("ECONNREFUSED");
  }, 20000);

  it("names the refused connection when the thread lookup fails", async () => {
    const port = await closedPort();
    const agent = new LangGraphAgent({
      graphId: "sample_agent",
      deploymentUrl: `http://127.0.0.1:${port}`,
    });
    (agent as any).subscriber = { next: vi.fn(), error: vi.fn() };
    (agent as any).dispatchEvent = () => true;

    const message = await agent.getOrCreateThread("thread-1").then(
      () => "",
      (error: Error) => error.message,
    );

    expect(message).toContain(`on http://127.0.0.1:${port}`);
    expect(message).toContain("ECONNREFUSED");
  }, 20000);
});
