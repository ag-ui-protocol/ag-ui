import { describe, expect, it } from "vitest";
import { EventType, PROTOCOL_VERSION, type BaseEvent } from "@ag-ui/core";
import { ADKAgent } from "../index";

// ADKAgent is a thin HttpAgent client: RUN_STARTED is emitted by the Python
// ag_ui_adk server, not by this package. This pins that the protocolVersion the
// server declares reaches subscribers intact.
describe("ADKAgent RUN_STARTED protocolVersion", () => {
  it("surfaces the server's protocolVersion on RUN_STARTED", async () => {
    const wire = [
      {
        type: EventType.RUN_STARTED,
        threadId: "t1",
        runId: "r1",
        protocolVersion: PROTOCOL_VERSION,
      },
      { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
    ];
    const agent = new ADKAgent({
      threadId: "t1",
      url: "https://adk.example.test/agent",
      fetch: async () =>
        new Response(wire.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "Content-Type": "text/event-stream" },
        }),
    });
    const seen: BaseEvent[] = [];
    agent.subscribe({
      onEvent: ({ event }) => {
        seen.push(event);
      },
    });

    await agent.runAgent({ runId: "r1" });

    const started = seen.filter((event) => event.type === EventType.RUN_STARTED);
    expect(PROTOCOL_VERSION).toBe("1.0");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ protocolVersion: PROTOCOL_VERSION });
  });
});
