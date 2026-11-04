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

// Antigravity's harness sends no role:"tool" messages: a tool round trip shows
// up as two more assistant messages, which is what `turnIndex` counts.
function request(
  messages: ChatMessage[],
  context?: string,
): ChatCompletionRequest & { _context?: string } {
  return { model: "gemini-2.5-flash", messages, _context: context };
}

const user = (text: string): ChatMessage => ({ role: "user", content: text });
const assistant = (text: string): ChatMessage => ({
  role: "assistant",
  content: text,
});

function responseFor(input: ChatCompletionRequest) {
  const fixture = matchFixture([...mockServer.getFixtures()], input);
  assert.ok(fixture, "Expected a registered fixture to match");
  return fixture.response as Record<string, unknown>;
}

function toolNames(response: Record<string, unknown>): string[] {
  const calls = response.toolCalls as { name: string }[] | undefined;
  return (calls ?? []).map((call) => call.name);
}

test("an Antigravity tool turn calls the tool once, then answers", () => {
  const prompt = user("Hi change the background color to blue");
  assert.deepEqual(
    toolNames(responseFor(request([prompt], "antigravity"))),
    ["change_background"],
  );
  const afterRoundTrip = request(
    [prompt, assistant("(tool call)"), assistant("(tool result)")],
    "antigravity",
  );
  assert.equal(
    responseFor(afterRoundTrip).content,
    "Done — the background is now blue.",
  );
});

test("a second tool turn in the same thread is staged after the first", () => {
  const history = [
    user("Hi change the background color to blue"),
    assistant("(tool call)"),
    assistant("(tool result)"),
    assistant("Done — the background is now blue."),
    user("Hi change the background color to pink"),
  ];
  assert.deepEqual(toolNames(responseFor(request(history, "antigravity"))), [
    "change_background",
  ]);
});

test("other integrations still get the shared fixtures", () => {
  const response = responseFor(
    request([
      user("Hi change the background color to blue"),
      assistant("(tool call)"),
      assistant("(tool result)"),
    ]),
  );
  // Without the Antigravity context the shared tool leg still answers,
  // exactly as before these fixtures existed.
  assert.deepEqual(toolNames(response), ["change_background"]);
});
