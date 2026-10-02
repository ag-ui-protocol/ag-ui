import assert from "node:assert/strict";
import test from "node:test";
import {
  LLMock,
  matchFixture,
  type ChatCompletionRequest,
  type ChatMessage,
} from "@copilotkit/aimock";
import { registerLLMockFixtures } from "../aimock-setup";
import {
  ANTIGRAVITY_BOOK_REQUEST,
  ANTIGRAVITY_BOOKED_SLOT,
  ANTIGRAVITY_CANCEL_REQUEST,
  ANTIGRAVITY_TRIP_REQUESTS,
  ANTIGRAVITY_TRIP_SUMMARY,
  registerAntigravityInterruptFixtures,
} from "../antigravity-interrupt-fixtures";

// The order aimock-setup.ts is meant to use: these first, then everything
// else. Registering the whole shared set behind them is what exercises the
// precedence the fixture module depends on.
const mockServer = new LLMock();
registerAntigravityInterruptFixtures(mockServer);
registerLLMockFixtures(mockServer);

type Tool = NonNullable<ChatCompletionRequest["tools"]>[number];
const tool = (name: string): Tool => ({
  type: "function",
  function: { name, parameters: { type: "object", properties: {} } },
});
const INTERRUPT_TOOLS = [tool("schedule_meeting")];
const SUBGRAPH_TOOLS = [
  tool("flights_agent"),
  tool("hotels_agent"),
  tool("experiences_agent"),
];

// Antigravity's harness sends no role:"tool" messages: a tool round trip shows
// up as two more assistant messages, which is what `turnIndex` counts.
function request(
  messages: ChatMessage[],
  tools: Tool[],
  context: string | null = "antigravity",
): ChatCompletionRequest & { _context?: string } {
  return {
    model: "gemini-2.5-flash",
    messages,
    tools,
    _context: context ?? undefined,
  };
}

const user = (text: string): ChatMessage => ({ role: "user", content: text });
const assistant = (text: string): ChatMessage => ({
  role: "assistant",
  content: text,
});
const roundTrips = (n: number): ChatMessage[] =>
  Array.from({ length: n }, () => [
    assistant("(tool call)"),
    assistant("(tool result)"),
  ]).flat();

function responseFor(input: ChatCompletionRequest) {
  const fixture = matchFixture([...mockServer.getFixtures()], input);
  assert.ok(fixture, "Expected a registered fixture to match");
  return fixture.response as Record<string, unknown>;
}

function toolCalls(response: Record<string, unknown>) {
  const calls = response.toolCalls as
    | { name: string; arguments: string }[]
    | undefined;
  return (calls ?? []).map((call) => ({
    name: call.name,
    args: JSON.parse(call.arguments) as Record<string, unknown>,
  }));
}

test("the booking prompt pauses schedule_meeting, then confirms the picked slot", () => {
  const prompt = user(`<USER_REQUEST>\n${ANTIGRAVITY_BOOK_REQUEST}\n</USER_REQUEST>`);
  assert.deepEqual(toolCalls(responseFor(request([prompt], INTERRUPT_TOOLS))), [
    {
      name: "schedule_meeting",
      args: { topic: "Intro call to discuss pricing", attendee: "the sales team" },
    },
  ]);
  const reply = responseFor(
    request([prompt, ...roundTrips(1)], INTERRUPT_TOOLS),
  ).content as string;
  assert.match(reply, new RegExp(ANTIGRAVITY_BOOKED_SLOT));
});

test("the cancel prompt closes without claiming a booking", () => {
  const prompt = user(ANTIGRAVITY_CANCEL_REQUEST);
  assert.deepEqual(
    toolCalls(responseFor(request([prompt], INTERRUPT_TOOLS))).map((c) => c.name),
    ["schedule_meeting"],
  );
  const reply = responseFor(
    request([prompt, ...roundTrips(1)], INTERRUPT_TOOLS),
  ).content as string;
  assert.match(reply, /did not schedule/i);
  assert.doesNotMatch(reply, /scheduled for/i);
});

for (const prompt of ANTIGRAVITY_TRIP_REQUESTS) {
  test(`"${prompt}" delegates flights, hotels, experiences, then sums up`, () => {
    // Both prompts contain "San Francisco", which the backend-tool-rendering
    // legs also match at turnIndex 0 and 2; a get_weather call here would be an
    // unknown tool and abort the run.
    const order = ["flights_agent", "hotels_agent", "experiences_agent"];
    order.forEach((name, i) => {
      const response = responseFor(
        request([user(prompt), ...roundTrips(i)], SUBGRAPH_TOOLS),
      );
      assert.deepEqual(
        toolCalls(response).map((c) => c.name),
        [name],
      );
    });
    assert.equal(
      responseFor(request([user(prompt), ...roundTrips(3)], SUBGRAPH_TOOLS))
        .content,
      ANTIGRAVITY_TRIP_SUMMARY,
    );
  });
}

test("the fixtures stay out of other demos' requests", () => {
  // No subgraphs tools: the weather demo keeps its get_weather leg.
  const weather = responseFor(
    request([user("What's the weather like in San Francisco?")], [tool("get_weather")]),
  );
  assert.deepEqual(
    toolCalls(weather).map((c) => c.name),
    ["get_weather"],
  );
  // Another integration, same prompt: not these fixtures.
  const other = matchFixture(
    [...mockServer.getFixtures()],
    request([user(ANTIGRAVITY_TRIP_REQUESTS[0])], SUBGRAPH_TOOLS, null),
  );
  assert.ok(
    !other || other.match.context !== "antigravity",
    "an Antigravity fixture answered a request without the Antigravity context",
  );
});
