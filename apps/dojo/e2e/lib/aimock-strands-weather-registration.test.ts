import assert from "node:assert/strict";
import test from "node:test";
import {
  LLMock,
  matchFixture,
  type ChatCompletionRequest,
  type ChatMessage,
} from "@copilotkit/aimock";
import { registerLLMockFixtures } from "../aimock-setup";

const mockServer = new LLMock();
registerLLMockFixtures(mockServer);

async function composedResponse(input: ChatCompletionRequest) {
  const fixture = matchFixture([...mockServer.getFixtures()], input);
  assert.ok(fixture, "Expected a registered fixture to match");
  return typeof fixture.response === "function"
    ? await fixture.response(input)
    : fixture.response;
}

const system =
  "You are a helpful assistant with backend tool rendering capabilities. You can get weather information and render charts.";
function request(
  messages: ChatMessage[],
  systemPrompt = system,
): ChatCompletionRequest {
  return {
    model: "gpt-4o",
    messages: [{ role: "system", content: systemPrompt }, ...messages],
  };
}
function user(city: string): ChatMessage {
  return {
    role: "user",
    content: [{ type: "text", text: `What's the weather in ${city}?` }],
  };
}
function toolResult(id: string): ChatMessage {
  return {
    role: "tool",
    tool_call_id: id,
    content: JSON.stringify({ temperature: 72, conditions: "sunny" }),
  };
}
async function callFor(messages: ChatMessage[], city: string) {
  const response = await composedResponse(request(messages));
  assert.ok("toolCalls" in response && response.toolCalls);
  assert.equal(response.toolCalls.length, 1);
  assert.equal(response.toolCalls[0].name, "get_weather");
  assert.deepEqual(JSON.parse(response.toolCalls[0].arguments), {
    location: city,
  });
  const call = response.toolCalls[0];
  assert.ok(call.id, "Expected a deterministic tool call ID");
  return { ...call, id: call.id };
}

test("uses the latest city and a fresh ID across the full SF then NY conversation", async () => {
  const history: ChatMessage[] = [user("San Francisco")];
  const sf = await callFor(history, "San Francisco");
  history.push(
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: sf.id,
          type: "function",
          function: { name: sf.name, arguments: sf.arguments },
        },
      ],
    },
    toolResult(sf.id),
  );
  assert.deepEqual(await composedResponse(request(history)), {
    content:
      "The weather in San Francisco is sunny, with a temperature of 72 degrees.",
  });
  history.push(
    { role: "assistant", content: "San Francisco is sunny." },
    user("New York"),
  );
  const ny = await callFor(history, "New York");
  assert.notEqual(ny.id, sf.id);
  history.push(
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: ny.id,
          type: "function",
          function: { name: ny.name, arguments: ny.arguments },
        },
      ],
    },
    toolResult(ny.id),
  );
  assert.deepEqual(await composedResponse(request(history)), {
    content:
      "The weather in New York is sunny, with a temperature of 72 degrees.",
  });
});

test("composed fixtures preserve generic tool-result fallback outside Strands weather", async () => {
  assert.deepEqual(
    await composedResponse(
      request(
        [user("New York"), toolResult("other-call")],
        "You are a weather assistant.",
      ),
    ),
    { content: "Done! I've completed that for you." },
  );
});
