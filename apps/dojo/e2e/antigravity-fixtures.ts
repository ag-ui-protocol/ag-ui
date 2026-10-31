/**
 * aimock fixtures for the Google Antigravity dojo demos.
 *
 * The Antigravity Go harness makes the model call itself, and it never sends a
 * `role: "tool"` message: after a tool round trip the next request just carries
 * two more assistant messages. So the shared fixtures, which answer the tool
 * call and rely on a generic "after a tool result" catch-all for the text,
 * replay the same tool call forever here. These fixtures stage each leg on
 * `turnIndex` instead (assistant messages so far: +2 per tool round trip, +1
 * per text answer; the highest `turnIndex` not above the count wins).
 *
 * They are scoped to `context: "antigravity"`, the `X-AIMock-Context` header
 * the example server stamps on its Gemini endpoint (see AIMOCK_CONTEXT in
 * scripts/run-dojo-everything.js), so no other integration can match them.
 * Register them before the shared fixtures: a context match at the same
 * position must win.
 *
 * The tool-call legs reuse the shared fixtures' responses, so the demos render
 * exactly what the other integrations render.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { LLMock } from "@copilotkit/aimock";

const CONTEXT = "antigravity";
const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures", "openai");

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

export function registerAntigravityFixtures(mockServer: LLMock): void {
  // Agentic chat: blue on a fresh thread (0/2), then pink after it (3/5).
  toolThenText(
    mockServer,
    "background color to blue",
    sharedResponse("agentic-chat", "background color to blue"),
    "Done — the background is now blue.",
    0,
  );
  toolThenText(
    mockServer,
    "background color to pink",
    sharedResponse("agentic-chat", "background color to pink"),
    "Done — the background is now pink.",
    3,
  );

  // Backend tool rendering: a server tool, one round trip per pill. The pills
  // word their prompts differently ("What's the weather like in San
  // Francisco?", "Tell me about the weather in New York."), so match on the
  // city; New York follows San Francisco in the same thread (3/5).
  toolThenText(
    mockServer,
    "San Francisco",
    sharedResponse("backend-tool-rendering", "Weather in San Francisco"),
    "Here's the current weather in San Francisco.",
    0,
  );
  toolThenText(
    mockServer,
    "New York",
    sharedResponse("backend-tool-rendering", "Weather in New York"),
    "Here's the current weather in New York.",
    3,
  );

  // Human in the loop: the shared fixtures answer the opening "Hi" (count 1),
  // and the tool leg at 0 still qualifies there; the answer lands after the
  // round trip (count 3).
  toolThenText(
    mockServer,
    "one step with eggs",
    sharedResponse("human-in-the-loop", "one step with eggs"),
    "I've executed the steps you selected.",
    0,
  );
  toolThenText(
    mockServer,
    "Start The Planning",
    sharedResponse("human-in-the-loop", "Start The Planning"),
    "I've executed the steps you selected.",
    0,
  );

  // Shared state. The recipe is written by the agent's generate_recipe server
  // tool (set_state -> STATE_SNAPSHOT); reusing the shared recipe keeps the
  // page's assertions the same as for every other integration.
  const sharedRecipe = JSON.parse(
    (
      sharedResponse("shared-state", "pasta recipe").toolCalls as {
        arguments: string;
      }[]
    )[0].arguments,
  ).memory.recipe;
  toolThenText(
    mockServer,
    "pasta recipe",
    {
      toolCalls: [
        {
          name: "generate_recipe",
          arguments: JSON.stringify({ title: "Pasta al Pomodoro", ...sharedRecipe }),
        },
      ],
    },
    "Here's a simple pasta al pomodoro — it's in the recipe card now.",
    0,
  );
  // The answer lists what the user added in the UI, so the model reads the
  // state first through the adapter's built-in get_shared_state tool.
  toolThenText(
    mockServer,
    "the ingredients",
    { toolCalls: [{ name: "get_shared_state", arguments: "{}" }] },
    sharedResponse("shared-state", "the ingredients").content as string,
    0,
  );

  // Tool-based generative UI: two haikus in one thread (0/2, then 3/5).
  toolThenText(
    mockServer,
    "I will always win",
    sharedResponse("tool-based-gen-ui", "I will always win"),
    "Here is your haiku.",
    0,
  );
  toolThenText(
    mockServer,
    "moon shines bright",
    sharedResponse("tool-based-gen-ui", "moon shines bright"),
    "Here is your haiku.",
    3,
  );
}
