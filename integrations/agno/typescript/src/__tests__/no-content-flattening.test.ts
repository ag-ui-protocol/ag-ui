/**
 * PNI-220: AgnoAgent must not have a protocol version ceiling, and the
 * backward-compat middlewares must stay off its path. AgnoAgent inherits
 * maxProtocolVersion (and the deprecated maxVersion alias) from
 * @ag-ui/client, which sits above every compat threshold, so structured
 * message content has to reach the wire intact instead of being flattened
 * to a text-only string — the agentic_chat_multimodal Dojo lane depends on it.
 */
import { describe, it, expect } from "vitest";
import type { InputContent, RunAgentInput } from "@ag-ui/core";
import { AgnoAgent } from "../index";

const multimodalContent: InputContent[] = [
  { type: "text", text: "what is in this image?" },
  {
    type: "image",
    source: { type: "data", value: "ZmFrZS1wbmc=", mimeType: "image/png" },
  },
];

function sseBody(threadId: string, runId: string) {
  return [
    { type: "RUN_STARTED", threadId, runId },
    { type: "RUN_FINISHED", threadId, runId },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function createRecordingAgent() {
  const requests: RunAgentInput[] = [];
  const agent = new AgnoAgent({
    url: "http://agno.invalid/agentic_chat_multimodal/agui",
    initialMessages: [{ id: "u1", role: "user", content: multimodalContent }],
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

describe("AgnoAgent content flattening", () => {
  it("sends structured message content to the server un-flattened", async () => {
    const { agent, requests } = createRecordingAgent();
    await agent.runAgent();

    expect(requests).toHaveLength(1);
    const [message] = requests[0]!.messages;
    if (message?.role !== "user") {
      throw new Error("expected the user message to reach the server");
    }
    expect(message.content).toEqual(multimodalContent);
  });

  it.each(["maxVersion", "maxProtocolVersion"])(
    "does not pin %s on AgnoAgent or an instance",
    (name) => {
      expect(
        Object.getOwnPropertyDescriptor(AgnoAgent.prototype, name),
      ).toBeUndefined();
      const { agent } = createRecordingAgent();
      expect(Object.getOwnPropertyDescriptor(agent, name)).toBeUndefined();
    },
  );
});
