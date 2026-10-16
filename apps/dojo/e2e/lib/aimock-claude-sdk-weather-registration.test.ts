import assert from "node:assert/strict";
import test from "node:test";
import {
  LLMock,
  matchFixture,
  type ChatCompletionRequest,
  type ChatMessage,
} from "@copilotkit/aimock";
import { registerLLMockFixtures } from "../aimock-setup";

const server = new LLMock();
registerLLMockFixtures(server);
async function response(
  messages: ChatMessage[],
  name = "mcp__weather__get_weather",
) {
  const request: ChatCompletionRequest = {
    model: "claude-haiku-4-5",
    messages,
    tools: [
      {
        type: "function",
        function: {
          name,
          parameters: {
            type: "object",
            properties: { location: { type: "string" } },
          },
        },
      },
    ],
  };
  const fixture = matchFixture([...server.getFixtures()], request);
  assert.ok(fixture);
  return typeof fixture.response === "function"
    ? await fixture.response(request)
    : fixture.response;
}
test("SDK weather calls retain the advertised MCP name across cities and result turns", async () => {
  const messages: ChatMessage[] = [];
  const ids = new Set();
  for (const city of ["San Francisco", "New York", "Tokyo"]) {
    messages.push({
      role: "user",
      content: `Tell me about the weather in ${city}.`,
    });
    const result = await response(messages);
    assert.ok("toolCalls" in result && result.toolCalls);
    assert.equal(result.toolCalls[0].name, "mcp__weather__get_weather");
    assert.deepEqual(JSON.parse(result.toolCalls[0].arguments), {
      location: city,
    });
    assert.ok(!ids.has(result.toolCalls[0].id));
    ids.add(result.toolCalls[0].id);
    messages.push({
      role: "tool",
      tool_call_id: result.toolCalls[0].id,
      content: '{"temperature":20,"humidity":50}',
    });
    assert.ok(
      !("toolCalls" in (await response(messages))),
      "Tool results must finish, not call weather again",
    );
  }
});
test("other integrations keep the shared bare weather fixture", async () => {
  const result = await response(
    [{ role: "user", content: "Weather in San Francisco" }],
    "get_weather",
  );
  assert.ok("toolCalls" in result && result.toolCalls);
  assert.equal(result.toolCalls[0].name, "get_weather");
});
