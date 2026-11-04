import { vi } from "vitest";
import { AbstractAgent } from "../agent";
import { HttpAgent } from "../http";
import { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EMPTY, Observable } from "rxjs";

// Cloudflare workerd forbids crypto randomness during global-scope evaluation,
// so constructing an agent at module top level must not generate a UUID
// (issue #3197). Spy on uuid's v4 to observe exactly when one is generated.
const { v4Spy } = vi.hoisted(() => ({ v4Spy: vi.fn() }));
vi.mock("uuid", async (importOriginal) => {
  const actual = await importOriginal<typeof import("uuid")>();
  v4Spy.mockImplementation(actual.v4);
  return { ...actual, v4: v4Spy };
});

class TestAgent extends AbstractAgent {
  run(_: RunAgentInput): Observable<BaseEvent> {
    return EMPTY as Observable<BaseEvent>;
  }
}

describe("AbstractAgent lazy threadId", () => {
  beforeEach(() => {
    v4Spy.mockClear();
  });

  it("does not generate a UUID during construction", () => {
    new TestAgent();

    expect(v4Spy).not.toHaveBeenCalled();
  });

  it("constructs an HttpAgent without generating a UUID", () => {
    new HttpAgent({ url: "https://example.com/agent" });

    expect(v4Spy).not.toHaveBeenCalled();
  });

  it("generates the threadId on first read and keeps it stable", () => {
    const agent = new TestAgent();

    const first = agent.threadId;
    const second = agent.threadId;

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toBe(first);
    expect(v4Spy).toHaveBeenCalledTimes(1);
  });

  it("uses an explicit threadId without generating one", () => {
    const agent = new TestAgent({ threadId: "thread-explicit" });

    expect(agent.threadId).toBe("thread-explicit");
    expect(v4Spy).not.toHaveBeenCalled();
  });

  it("honors a threadId assigned after construction", () => {
    const agent = new TestAgent();

    agent.threadId = "thread-assigned";

    expect(agent.threadId).toBe("thread-assigned");
    expect(v4Spy).not.toHaveBeenCalled();
  });

  it("shares the lazily generated threadId with clones", () => {
    const agent = new TestAgent();

    const cloned = agent.clone();

    expect(cloned.threadId).toBe(agent.threadId);
  });
});
