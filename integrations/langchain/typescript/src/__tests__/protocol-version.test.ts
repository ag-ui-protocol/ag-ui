import { describe, it, expect } from "vitest";
import { EventType } from "@ag-ui/client";
import type { RunAgentInput, RunStartedEvent } from "@ag-ui/client";
import { firstValueFrom, toArray } from "rxjs";
import { LangChainAgent } from "../agent";

const input: RunAgentInput = {
  threadId: "thread-1",
  runId: "run-1",
  messages: [{ id: "msg-1", role: "user", content: "hello" }],
  tools: [],
  context: [],
  forwardedProps: {},
};

describe("LangChainAgent RUN_STARTED", () => {
  it("declares the AG-UI protocol version it speaks", async () => {
    const agent = new LangChainAgent({ chainFn: async () => "hi" });

    const events = await firstValueFrom(agent.run(input).pipe(toArray()));

    const runStarted = events[0] as RunStartedEvent;
    expect(runStarted.type).toBe(EventType.RUN_STARTED);
    expect(runStarted.protocolVersion).toBe("1.0");
  });
});
