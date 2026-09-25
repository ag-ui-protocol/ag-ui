import { afterEach, describe, expect, it, vi } from "vitest";
import { LangGraphAgent } from "./agent";

class TraceAgent extends LangGraphAgent {
  attempt() {
    return this.shouldAttemptV3();
  }
  subscriptionFailed(error: Error) {
    this.handleV3SubscriptionFailure("thread", error);
  }
  source(transformer: boolean) {
    this.verifyTestEventSource(transformer);
  }
}
const agent = () =>
  new TraceAgent({ deploymentUrl: "http://localhost:2024", graphId: "chat" });
afterEach(() => vi.unstubAllEnvs());

describe("explicit event-trace lanes", () => {
  it("requires V3 when only an event source is specified", () => {
    vi.stubEnv("LANGGRAPH_STREAM_PROTOCOL_FOR_TESTS", undefined);
    vi.stubEnv("LANGGRAPH_EVENT_SOURCE_FOR_TESTS", "transformer");
    expect(agent().attempt()).toBe(true);
    expect(() =>
      agent().subscriptionFailed(new Error("protocol request failed: 404")),
    ).toThrow("Forced V3");
    vi.stubEnv("LANGGRAPH_STREAM_PROTOCOL_FOR_TESTS", "v2");
    expect(() => agent().attempt()).toThrow("cannot be combined");
  });
  it("forces V2 without attempting an automatic V3 upgrade", () => {
    vi.stubEnv("LANGGRAPH_STREAM_PROTOCOL_FOR_TESTS", "v2");
    expect(agent().attempt()).toBe(false);
  });
  it("fails forced V3 instead of silently accepting a V2 fallback", () => {
    vi.stubEnv("LANGGRAPH_STREAM_PROTOCOL_FOR_TESTS", "v3");
    expect(() =>
      agent().subscriptionFailed(new Error("protocol request failed: 404")),
    ).toThrow("Forced V3");
  });
  it.each(["raw", "transformer"])(
    "verifies the actual %s event owner",
    (source) => {
      vi.stubEnv("LANGGRAPH_EVENT_SOURCE_FOR_TESTS", source);
      const current = agent();
      expect(() => current.source(source === "transformer")).not.toThrow();
      expect(() => current.source(source !== "transformer")).toThrow(
        "event-trace source",
      );
    },
  );
  it("retains automatic fallback when no lane is requested", () => {
    vi.stubEnv("LANGGRAPH_STREAM_PROTOCOL_FOR_TESTS", undefined);
    const current = agent();
    expect(current.attempt()).toBe(true);
    expect(() =>
      current.subscriptionFailed(new Error("protocol request failed: 404")),
    ).not.toThrow();
    expect(current.attempt()).toBe(false);
  });
});
