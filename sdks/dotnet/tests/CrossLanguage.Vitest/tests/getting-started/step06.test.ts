import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { HttpAgent } from "@ag-ui/client";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { startStepServer, type StepServerHandle } from "../../helpers/step-server";

interface TextDeltaEvent extends BaseEvent {
  delta: string;
}

function collectText(events: BaseEvent[]): string {
  return events
    .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((e) => (e as TextDeltaEvent).delta)
    .join("");
}

let server: StepServerHandle;

beforeAll(async () => {
  // Step06 wires a TelemetryRawEventsChatClient that emits RAW events
  // alongside the chat output. The hosting layer translates each MEAI
  // ChatResponseUpdate whose RawRepresentation is a RawEvent into an
  // AG-UI RAW event on the wire — which is what we validate here.
  server = await startStepServer({
    step: 6,
    projectName: "RawEvents",
    port: 8106,
  });
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

describe("TS HttpAgent -> C# Step06_RawEvents.Server", () => {
  it("forwards RAW telemetry events alongside the streamed text", async () => {
    const agent = new HttpAgent({
      url: `${server.baseUrl}/`,
      threadId: "step06",
      agentId: "step06-cross-language",
    });
    agent.messages = [
      { id: "u1", role: "user", content: "Tell me about ag-ui raw events" },
    ];

    const events: BaseEvent[] = [];
    await agent.runAgent(
      {},
      {
        onEvent: ({ event }) => {
          events.push(event);
        },
      },
    );

    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_STARTED);
    expect(types).toContain(EventType.RUN_FINISHED);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types).toContain(EventType.RAW);

    expect(collectText(events)).toBe('(fake) You said: "Tell me about ag-ui raw events"');

    // Each RAW event in AG-UI carries a `source` and an `event` payload.
    // The Step06 server emits at least one telemetry RAW per turn; assert
    // both fields survive serialization across the language boundary.
    const raw = events.find((e) => e.type === EventType.RAW) as BaseEvent & {
      source?: string;
      event?: unknown;
    };
    expect(raw).toBeDefined();
    expect(raw.source).toBeTypeOf("string");
    expect(raw.event).toBeDefined();
  });
});
