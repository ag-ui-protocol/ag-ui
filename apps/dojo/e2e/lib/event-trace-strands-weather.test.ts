import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ChatCompletionRequest, ChatMessage } from "@copilotkit/aimock";
import { expectStrandsWeatherTurns } from "../featurePages/StrandsWeatherPage";
import { strandsWeatherResponse } from "../strands-weather-fixtures";

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
function callFor(messages: ChatMessage[], city: string) {
  const response = strandsWeatherResponse(request(messages));
  assert.ok(response?.toolCalls);
  assert.equal(response.toolCalls.length, 1);
  assert.equal(response.toolCalls[0].name, "get_weather");
  assert.deepEqual(JSON.parse(response.toolCalls[0].arguments), {
    location: city,
  });
  return response.toolCalls[0];
}

test("uses the latest city and a fresh ID across the full SF then NY conversation", () => {
  const history: ChatMessage[] = [user("San Francisco")];
  const sf = callFor(history, "San Francisco");
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
  assert.deepEqual(strandsWeatherResponse(request(history)), {
    content:
      "The weather in San Francisco is sunny, with a temperature of 72 degrees.",
  });
  history.push(
    { role: "assistant", content: "San Francisco is sunny." },
    user("New York"),
  );
  const ny = callFor(history, "New York");
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
  assert.deepEqual(strandsWeatherResponse(request(history)), {
    content:
      "The weather in New York is sunny, with a temperature of 72 degrees.",
  });
});

test("does not intercept another integration's weather request", () => {
  assert.equal(
    strandsWeatherResponse(
      request([user("New York")], "You are a weather assistant."),
    ),
    undefined,
  );
});

test("gives repeated requests for the same city a fresh deterministic ID", () => {
  const first = callFor([user("San Francisco")], "San Francisco");
  const history = [
    user("San Francisco"),
    toolResult(first.id),
    user("San Francisco"),
  ];
  const second = callFor(history, "San Francisco");
  assert.notEqual(first.id, second.id);
  assert.equal(second.id, callFor(history, "San Francisco").id);
});

function weatherEvents(secondId: string, secondCity: string) {
  return [
    {
      type: "TOOL_CALL_START",
      toolCallName: "get_weather",
      toolCallId: "sf-call",
    },
    {
      type: "TOOL_CALL_ARGS",
      toolCallId: "sf-call",
      delta: JSON.stringify({ location: "San Francisco" }),
    },
    {
      type: "TOOL_CALL_START",
      toolCallName: "get_weather",
      toolCallId: secondId,
    },
    {
      type: "TOOL_CALL_ARGS",
      toolCallId: secondId,
      delta: JSON.stringify({ location: secondCity }),
    },
  ];
}

test("capture guard requires two actual cities with independent calls", () => {
  assert.doesNotThrow(() =>
    expectStrandsWeatherTurns(weatherEvents("ny-call", "New York")),
  );
  assert.throws(() =>
    expectStrandsWeatherTurns(weatherEvents("sf-call", "San Francisco")),
  );
  assert.throws(() =>
    expectStrandsWeatherTurns(weatherEvents("ny-call", "San Francisco")),
  );
});

// Run the real fixture-registration graph separately: the trace typecheck is
// intentionally scoped to trace code, not every integration's mock fixtures.
test("real fixture registration serves both Strands weather turns and preserves other integrations", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      "--test",
      fileURLToPath(
        new URL(
          "./aimock-strands-weather-registration.test.ts",
          import.meta.url,
        ),
      ),
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.match(output, /# tests 2\b/);
  assert.match(output, /# fail 0\b/);
});
