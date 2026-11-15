import assert from "node:assert/strict";
import test from "node:test";
import {
  LLMock,
  matchFixture,
  type ChatCompletionRequest,
  type ChatMessage,
} from "@copilotkit/aimock";
import {
  ANTIGRAVITY_A2UI_PROMPTS,
  registerAntigravityA2UIFixtures,
} from "../antigravity-a2ui-fixtures";
import { registerLLMockFixtures } from "../aimock-setup";

// The intended order: the Antigravity A2UI fixtures ahead of every shared
// fixture, several of which match the same requests as fallbacks.
const mockServer = new LLMock();
registerAntigravityA2UIFixtures(mockServer);
registerLLMockFixtures(mockServer);

type Request = ChatCompletionRequest & { _context?: string };

// Antigravity's harness sends no role:"tool" messages: a tool round trip shows
// up as two more assistant messages, which is what `turnIndex` counts.
function request(
  messages: ChatMessage[],
  tools: string[],
  // null: a request from any other integration (no X-AIMock-Context).
  context: string | null = "antigravity",
): Request {
  return {
    model: "gemini-3.6-flash",
    messages,
    tools: tools.map((name) => ({
      type: "function" as const,
      function: { name, parameters: { type: "object" } },
    })),
    _context: context ?? undefined,
  };
}

const user = (text: string): ChatMessage => ({ role: "user", content: text });
const system = (text: string): ChatMessage => ({
  role: "system",
  content: text,
});
const assistant = (text: string): ChatMessage => ({
  role: "assistant",
  content: text,
});
const roundTrip = [assistant("(tool call)"), assistant("(tool result)")];

function responseFor(input: Request) {
  const fixture = matchFixture([...mockServer.getFixtures()], input);
  assert.ok(fixture, "Expected a registered fixture to match");
  return fixture.response as Record<string, unknown>;
}

type Call = { name: string; arguments: string };
function calls(response: Record<string, unknown>): Call[] {
  return (response.toolCalls as Call[] | undefined) ?? [];
}
function onlyCall(response: Record<string, unknown>): {
  name: string;
  args: Record<string, unknown>;
} {
  const all = calls(response);
  assert.equal(all.length, 1, `Expected one tool call, got ${JSON.stringify(response)}`);
  return { name: all[0].name, args: JSON.parse(all[0].arguments) };
}

/** The inner render_a2ui call's parsed components/data (JSON strings). */
function rendered(response: Record<string, unknown>) {
  const { name, args } = onlyCall(response);
  assert.equal(name, "render_a2ui");
  return {
    surfaceId: args.surfaceId,
    components: JSON.parse(args.components as string) as { id: string }[],
    data: JSON.parse(args.data as string) as { items: { name: string }[] },
  };
}

const TOOLKIT_PROMPT = "## Available Components\n...";
const RETRY_PROMPT = `${TOOLKIT_PROMPT}\n\n## Previous attempt was invalid — fix these and regenerate:\n- [x] y: z`;

test("fixed schema: flights call search_flights once, then answer", () => {
  const prompt = user("Find flights from SFO to JFK for next Tuesday.");
  const tools = ["search_flights", "search_hotels"];
  const first = onlyCall(responseFor(request([prompt], tools)));
  assert.equal(first.name, "search_flights");
  const flights = first.args.flights as { flightNumber: string; price: string }[];
  assert.deepEqual(
    flights.map((f) => [f.flightNumber, f.price]),
    [
      ["UA 123", "$289"],
      ["DL 456", "$315"],
    ],
  );
  const after = responseFor(request([prompt, ...roundTrip], tools));
  assert.equal(calls(after).length, 0);
  assert.equal(typeof after.content, "string");
});

test("fixed schema: hotels after flights in one thread are staged after them", () => {
  const tools = ["search_flights", "search_hotels"];
  const history = [
    user("Find flights from SFO to JFK."),
    ...roundTrip,
    assistant("Here are some flights."),
    user("Find hotels in downtown Manhattan."),
  ];
  const leg = onlyCall(responseFor(request(history, tools)));
  assert.equal(leg.name, "search_hotels");
  assert.deepEqual(
    (leg.args.hotels as { name: string }[]).map((h) => h.name),
    ["The Manhattan Grand", "Downtown Boutique Hotel"],
  );
  const after = responseFor(request([...history, ...roundTrip], tools));
  assert.equal(calls(after).length, 0);
});

for (const [label, prompt, surfaceId, first] of [
  [
    "dynamic schema",
    "Use the generate_a2ui tool to create a comparison of 3 hotels with name, location, price per night, and a star rating.",
    "hotel-comparison",
    "The Ritz",
  ],
  [
    "advanced",
    "Use the generate_a2ui tool to create a team directory with 4 people showing name, role, department, and a Contact button.",
    "team-roster",
    "Alice Chen",
  ],
] as const) {
  test(`${label}: outer generate_a2ui, inner valid render, then text`, () => {
    const outer = onlyCall(responseFor(request([user(prompt)], ["generate_a2ui"])));
    assert.equal(outer.name, "generate_a2ui");
    const innerRequest = request(
      [system(TOOLKIT_PROMPT), user(outer.args.request as string)],
      ["render_a2ui"],
    );
    const surface = rendered(responseFor(innerRequest));
    assert.equal(surface.surfaceId, surfaceId);
    assert.deepEqual(
      surface.components.map((c) => c.id),
      ["root", "card"],
    );
    assert.equal(surface.data.items[0].name, first);
    const after = responseFor(
      request([user(prompt), ...roundTrip], ["generate_a2ui"]),
    );
    assert.equal(calls(after).length, 0);
  });
}

test("recovery: the first render is invalid, the retry is valid", () => {
  const request_ = ANTIGRAVITY_A2UI_PROMPTS.recover;
  const firstTry = rendered(
    responseFor(
      request([system(TOOLKIT_PROMPT), user(request_)], ["render_a2ui"]),
    ),
  );
  assert.deepEqual(
    firstTry.components.map((c) => c.id),
    ["root"],
  );
  const retry = rendered(
    responseFor(request([system(RETRY_PROMPT), user(request_)], ["render_a2ui"])),
  );
  assert.deepEqual(
    retry.components.map((c) => c.id),
    ["root", "card"],
  );
});

test("recovery: the exhaust render is invalid on every attempt", () => {
  const request_ = ANTIGRAVITY_A2UI_PROMPTS.exhaust;
  for (const prompt of [TOOLKIT_PROMPT, RETRY_PROMPT]) {
    const attempt = rendered(
      responseFor(request([system(prompt), user(request_)], ["render_a2ui"])),
    );
    assert.deepEqual(
      attempt.components.map((c) => c.id),
      ["root"],
    );
  }
});

test("recovery: the chat still answers after the hard failure", () => {
  const history = [
    user("Compare 3 broken hotels with ratings and prices."),
    ...roundTrip,
    assistant("Sorry, I couldn't generate that UI."),
    user("Thanks anyway."),
  ];
  const response = responseFor(request(history, ["generate_a2ui"]));
  assert.equal(calls(response).length, 0);
  assert.equal(typeof response.content, "string");
});

test("other integrations never see these fixtures", () => {
  // The same prompts without the Antigravity context keep answering from the
  // shared fixtures, exactly as before.
  const ours = new Set(
    (() => {
      const only = new LLMock();
      registerAntigravityA2UIFixtures(only);
      return only.getFixtures().map((f) => JSON.stringify(f.match));
    })(),
  );
  for (const [prompt, tools] of [
    ["Find flights from SFO to JFK for next Tuesday.", ["search_flights", "search_hotels"]],
    ["Compare 3 broken hotels with ratings and prices.", ["generate_a2ui"]],
  ] as const) {
    const fixture = matchFixture(
      [...mockServer.getFixtures()],
      request([user(prompt)], [...tools], null),
    );
    assert.ok(fixture, `Expected a shared fixture for "${prompt}"`);
    assert.ok(
      !ours.has(JSON.stringify(fixture.match)),
      `"${prompt}" matched an Antigravity A2UI fixture without its context`,
    );
  }
});
