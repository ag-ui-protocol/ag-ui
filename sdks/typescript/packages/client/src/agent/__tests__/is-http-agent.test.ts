import { describe, it, expect, expectTypeOf } from "vitest";
import { EMPTY, Observable } from "rxjs";
import { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { AbstractAgent } from "../agent";
import { HttpAgent, isHttpAgent } from "../http";

const AGENT_URL = "https://example.com/agent";

class SubclassedHttpAgent extends HttpAgent {}

class LocalAgent extends AbstractAgent {
  run(_: RunAgentInput): Observable<BaseEvent> {
    return EMPTY;
  }
}

/**
 * The public fields of an `HttpAgent` built by another copy of `@ag-ui/client`.
 * `instanceof HttpAgent` is false for it.
 */
function createForeignHttpAgent() {
  return {
    url: AGENT_URL,
    headers: { Authorization: "Bearer token" },
    abortController: new AbortController(),
    runAgent: () => Promise.resolve({ result: undefined, newMessages: [] }),
  };
}

describe("isHttpAgent", () => {
  it("returns true for an HttpAgent", () => {
    expect(isHttpAgent(new HttpAgent({ url: AGENT_URL }))).toBe(true);
  });

  it("returns true for a subclass of HttpAgent", () => {
    expect(isHttpAgent(new SubclassedHttpAgent({ url: AGENT_URL }))).toBe(true);
  });

  it("returns true for an HttpAgent whose run was aborted", () => {
    const agent = new HttpAgent({ url: AGENT_URL });
    agent.abortRun();

    expect(agent.abortController.signal.aborted).toBe(true);
    expect(isHttpAgent(agent)).toBe(true);
  });

  it("returns true for an object with the HttpAgent shape from another package copy", () => {
    const foreignAgent = createForeignHttpAgent();

    expect(foreignAgent instanceof HttpAgent).toBe(false);
    expect(isHttpAgent(foreignAgent)).toBe(true);
  });

  it("returns false for an AbstractAgent subclass without a url", () => {
    expect(isHttpAgent(new LocalAgent())).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", AGENT_URL],
    ["a number", 42],
  ])("returns false for %s", (_label, value) => {
    expect(isHttpAgent(value)).toBe(false);
  });

  it("narrows the value to HttpAgent", () => {
    const value: unknown = new HttpAgent({ url: AGENT_URL });

    if (!isHttpAgent(value)) {
      throw new Error("expected value to be an HttpAgent");
    }

    expectTypeOf(value).toEqualTypeOf<HttpAgent>();
    expect(value.url).toBe(AGENT_URL);
  });
});
