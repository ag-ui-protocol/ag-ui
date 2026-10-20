/**
 * aimock fixtures for the Google Antigravity chat-variant dojo demos:
 * agentic_chat_multimodal, agentic_chat_reasoning and agentic_generative_ui.
 * (v1_agentic_chat reuses the agentic_chat agent, and the shared "Hi" fixture
 * answers it.)
 *
 * Same scheme as antigravity-fixtures.ts: the Antigravity harness never sends
 * `role: "tool"`, so a tool leg and its closing text are staged on `turnIndex`
 * (assistant messages so far: +2 per tool round trip, +1 per text answer; the
 * highest `turnIndex` not above the count wins), and every fixture is scoped to
 * `context: "antigravity"`, the `X-AIMock-Context` header the example server
 * stamps on its Gemini endpoint. Register them before the shared fixtures.
 *
 * Responses are reused from the shared fixtures wherever the page asserts the
 * same thing for every integration.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatMessage, LLMock } from "@copilotkit/aimock";

const CONTEXT = "antigravity";
const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures", "openai");

/**
 * The multimodal answer. The spec asserts this wording, which no shared
 * fixture uses, so it only passes when the image actually reached the model.
 */
export const ANTIGRAVITY_IMAGE_SEEN =
  "I can see the image you attached: it arrived as an inline image, so I can describe its visual content for you.";

/** The agentic generative UI answer once the plan's steps are done. */
export const ANTIGRAVITY_PLAN_DONE =
  "Done! I've completed every step of the plan.";

type SharedFixture = {
  match: { userMessage?: string };
  response: Record<string, unknown>;
};

function sharedResponse(file: string, userMessage: string) {
  const raw = JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, `${file}.json`), "utf8"),
  );
  const fixtures: SharedFixture[] = Array.isArray(raw) ? raw : raw.fixtures;
  const found = fixtures.find((f) => f.match.userMessage === userMessage);
  if (!found) {
    throw new Error(`No shared fixture for "${userMessage}" in ${file}.json`);
  }
  return found.response;
}

/** A tool leg at `at` and its closing text two assistant messages later. */
function toolThenText(
  mockServer: LLMock,
  userMessage: string,
  toolResponse: Record<string, unknown>,
  text: string,
  at: number,
): void {
  mockServer.addFixture({
    match: { userMessage, turnIndex: at, context: CONTEXT },
    response: toolResponse,
  });
  mockServer.addFixture({
    match: { userMessage, turnIndex: at + 2, context: CONTEXT },
    response: { content: text },
  });
}

function lastUserText(messages: ChatMessage[]): string {
  const content = messages.filter((m) => m.role === "user").pop()?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
      .join("");
  }
  return "";
}

export function registerAntigravityChatFixtures(mockServer: LLMock): void {
  // Multimodal. aimock's Gemini handler drops inline media from the request it
  // matches on, so a fixture cannot see the image itself. The adapter, though,
  // replaces any attachment it cannot forward with an "[Attached image ...]"
  // note in the prompt, so the absence of that note means the image went to
  // the model as media. A dropped image falls through to the shared fixture,
  // whose wording the spec does not accept.
  mockServer.addFixture({
    match: {
      userMessage: "what do you see in this image",
      turnIndex: 0,
      context: CONTEXT,
      predicate: (req) => !lastUserText(req.messages).includes("[Attached "),
    },
    response: { content: ANTIGRAVITY_IMAGE_SEEN },
  });

  // Reasoning: the shared response carries a `reasoning` channel, which aimock
  // streams as Gemini thought parts and the adapter turns into REASONING_*.
  mockServer.addFixture({
    match: { userMessage: "best car to buy", turnIndex: 0, context: CONTEXT },
    response: sharedResponse("agentic-chat-reasoning", "best car to buy"),
  });

  // Agentic generative UI: the shared generate_task_steps_generative_ui call,
  // which the agent runs as a server tool that streams the plan's progress as
  // STATE_SNAPSHOTs. The specs say "Hi" first (count 1), and the tool leg at 0
  // still qualifies there; the answer lands after the round trip (count 3).
  toolThenText(
    mockServer,
    "plan to make brownies",
    sharedResponse("agentic-gen-ui", "plan to make brownies"),
    ANTIGRAVITY_PLAN_DONE,
    0,
  );
  toolThenText(
    mockServer,
    "Go to Mars",
    sharedResponse("agentic-gen-ui", "Go to Mars"),
    ANTIGRAVITY_PLAN_DONE,
    0,
  );
}
