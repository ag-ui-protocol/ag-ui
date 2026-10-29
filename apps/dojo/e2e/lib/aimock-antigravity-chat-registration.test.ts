import assert from "node:assert/strict";
import test from "node:test";
import {
  LLMock,
  matchFixture,
  type ChatCompletionRequest,
  type ChatMessage,
} from "@copilotkit/aimock";
import {
  ANTIGRAVITY_IMAGE_SEEN,
  ANTIGRAVITY_PLAN_DONE,
  registerAntigravityChatFixtures,
} from "../antigravity-chat-fixtures";
import { registerLLMockFixtures } from "../aimock-setup";

// The chat fixtures first, then everything the dojo registers, so precedence
// over the shared fixtures for the same prompts is exercised too.
const mockServer = new LLMock();
registerAntigravityChatFixtures(mockServer);
registerLLMockFixtures(mockServer);

// Antigravity's harness sends no role:"tool" messages: a tool round trip shows
// up as two more assistant messages, which is what `turnIndex` counts.
function request(
  messages: ChatMessage[],
  context?: string,
): ChatCompletionRequest & { _context?: string } {
  return { model: "gemini-3.6-flash", messages, _context: context };
}

const user = (text: string): ChatMessage => ({ role: "user", content: text });
const assistant = (text: string): ChatMessage => ({
  role: "assistant",
  content: text,
});
const roundTrip = [assistant("(tool call)"), assistant("(tool result)")];

function responseFor(input: ChatCompletionRequest) {
  const fixture = matchFixture([...mockServer.getFixtures()], input);
  assert.ok(fixture, "Expected a registered fixture to match");
  return fixture.response as Record<string, unknown>;
}

function toolNames(response: Record<string, unknown>): string[] {
  const calls = response.toolCalls as { name: string }[] | undefined;
  return (calls ?? []).map((call) => call.name);
}

test("the opening Hi of the v1 and generative UI specs gets the shared greeting", () => {
  assert.match(
    String(responseFor(request([user("Hi")], "antigravity")).content),
    /Hello/,
  );
});

test("an image that reached the model gets the image answer", () => {
  const prompt = user("Tell me what do you see in this image");
  assert.equal(
    responseFor(request([prompt], "antigravity")).content,
    ANTIGRAVITY_IMAGE_SEEN,
  );
});

test("an image the adapter could not forward does not get the image answer", () => {
  const prompt = user(
    "Tell me what do you see in this image\n[Attached image 'test-image.png' was not forwarded: only inline attachments reach this agent.]",
  );
  assert.notEqual(
    responseFor(request([prompt], "antigravity")).content,
    ANTIGRAVITY_IMAGE_SEEN,
  );
});

test("the reasoning prompt streams a reasoning channel before the answer", () => {
  const response = responseFor(
    request([user("What is the best car to buy?")], "antigravity"),
  );
  assert.ok(
    typeof response.reasoning === "string" && response.reasoning.length > 0,
  );
  assert.match(String(response.content), /Toyota|Honda|Mazda/);
});

for (const prompt of ["Give me a plan to make brownies", "Go to Mars"]) {
  test(`"${prompt}" after the greeting calls the plan tool once, then answers`, () => {
    const history = [user("Hi"), assistant("Hello!"), user(prompt)];
    assert.deepEqual(toolNames(responseFor(request(history, "antigravity"))), [
      "generate_task_steps_generative_ui",
    ]);
    assert.equal(
      responseFor(request([...history, ...roundTrip], "antigravity")).content,
      ANTIGRAVITY_PLAN_DONE,
    );
  });

  test(`"${prompt}" on a fresh thread calls the plan tool once, then answers`, () => {
    assert.deepEqual(
      toolNames(responseFor(request([user(prompt)], "antigravity"))),
      ["generate_task_steps_generative_ui"],
    );
    assert.equal(
      responseFor(request([user(prompt), ...roundTrip], "antigravity")).content,
      ANTIGRAVITY_PLAN_DONE,
    );
  });
}

test("other integrations still get the shared fixtures for the same prompts", () => {
  assert.notEqual(
    responseFor(request([user("Tell me what do you see in this image")]))
      .content,
    ANTIGRAVITY_IMAGE_SEEN,
  );
  assert.notEqual(
    responseFor(
      request([user("Give me a plan to make brownies"), ...roundTrip]),
    ).content,
    ANTIGRAVITY_PLAN_DONE,
  );
});
