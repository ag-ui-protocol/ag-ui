/**
 * PNI-536: the Spring AI server (community Java SDK) models message content as
 * a plain string and rejects a 1.0 ContentPart[] body with HTTP 400. So
 * SpringAiAgent pins maxProtocolVersion to 0.0.39, the ceiling that turns on
 * the client's content-flattening shim. It uses the 1.0 name, not the
 * deprecated maxVersion.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import type { InputContent, Message, RunAgentInput } from "@ag-ui/core";
import { SpringAiAgent } from "../index";

const multimodalContent: InputContent[] = [
  { type: "text", text: "what is in " },
  {
    type: "image",
    source: { type: "data", value: "ZmFrZS1wbmc=", mimeType: "image/png" },
  },
  { type: "text", text: "this image?" },
];

function sseBody(threadId: string, runId: string) {
  return [
    { type: "RUN_STARTED", threadId, runId },
    { type: "RUN_FINISHED", threadId, runId },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function createRecordingAgent(initialMessages: Message[]) {
  const requests: RunAgentInput[] = [];
  const agent = new SpringAiAgent({
    url: "http://spring-ai.invalid/agent/agentic_chat",
    initialMessages,
    fetch: async (_url, requestInit) => {
      if (typeof requestInit.body !== "string") {
        throw new Error("expected a JSON string request body");
      }
      const input = JSON.parse(requestInit.body) as RunAgentInput;
      requests.push(input);
      return new Response(sseBody(input.threadId, input.runId), {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  return { agent, requests };
}

describe("SpringAiAgent protocol ceiling", () => {
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("pins maxProtocolVersion to 0.0.39 without the deprecated maxVersion override", () => {
    const { agent } = createRecordingAgent([]);
    expect(agent.maxProtocolVersion).toBe("0.0.39");
    expect(
      Object.getOwnPropertyDescriptor(SpringAiAgent.prototype, "maxVersion"),
    ).toBeUndefined();
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("maxVersion is deprecated"),
    );
  });

  it("flattens user ContentPart[] content to the text the server can parse", async () => {
    const { agent, requests } = createRecordingAgent([
      { id: "u1", role: "user", content: multimodalContent },
    ]);
    await agent.runAgent();

    expect(requests).toHaveLength(1);
    const [message] = requests[0]!.messages;
    expect(message).toMatchObject({
      role: "user",
      content: "what is in this image?",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("DROPS non-text parts (image)"),
    );
  });

  it("flattens tool-result content arrays to a string", async () => {
    const { agent, requests } = createRecordingAgent([
      { id: "u1", role: "user", content: "hi" },
      {
        id: "a1",
        role: "assistant",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          },
        ],
      },
      {
        id: "t1",
        role: "tool",
        toolCallId: "c1",
        content: [{ type: "text", text: "found it" }],
      } as unknown as Message,
    ]);
    await agent.runAgent();

    const tool = requests[0]!.messages.find((m) => m.role === "tool");
    expect(tool).toMatchObject({ toolCallId: "c1", content: "found it" });
  });

  it("does not declare protocolVersion on RunAgentInput", async () => {
    const { agent, requests } = createRecordingAgent([
      { id: "u1", role: "user", content: "hi" },
    ]);
    await agent.runAgent();

    expect(requests[0]).not.toHaveProperty("protocolVersion");
  });
});
