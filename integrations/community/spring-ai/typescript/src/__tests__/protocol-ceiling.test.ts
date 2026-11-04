// The Spring AI server (community Java SDK) rejects 1.0 ContentPart[] content
// with HTTP 400, so SpringAiAgent pins maxProtocolVersion to 0.0.39 and the
// client flattens user and tool content to strings before sending.
import { expect, it, vi } from "vitest";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { SpringAiAgent } from "../index";

it("sends user and tool content as the strings the Spring AI server can parse", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const requests: RunAgentInput[] = [];
  const agent = new SpringAiAgent({
    url: "http://spring-ai.invalid/agent/agentic_chat",
    initialMessages: [
      {
        id: "u1",
        role: "user",
        content: [
          { type: "text", text: "what is in " },
          { type: "image", source: { type: "data", value: "ZmFrZS1wbmc=", mimeType: "image/png" } },
          { type: "text", text: "this image?" },
        ],
      },
      {
        id: "a1",
        role: "assistant",
        toolCalls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: "{}" } }],
      },
      {
        id: "t1",
        role: "tool",
        toolCallId: "c1",
        content: [{ type: "text", text: "found it" }],
      } as unknown as Message,
    ],
    fetch: async (_url, init) => {
      const input = JSON.parse(String(init.body)) as RunAgentInput;
      requests.push(input);
      const events = [
        { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
        { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
      ];
      return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  await agent.runAgent();

  const [user, , tool] = requests[0]!.messages;
  expect(user).toMatchObject({ role: "user", content: "what is in this image?" });
  expect(tool).toMatchObject({ role: "tool", toolCallId: "c1", content: "found it" });
});
