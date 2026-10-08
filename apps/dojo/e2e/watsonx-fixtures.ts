/**
 * Deterministic fixtures for the in-process IBM watsonx orchestrate Dojo agent.
 *
 * watsonx orchestrate exposes an OpenAI-compatible chat endpoint at
 * `<instance>/v1/orchestrate/<agent>/chat/completions`; aimock normalizes any
 * path ending in `/chat/completions` to `/v1/chat/completions`, so keyless runs
 * point the agent's `baseUrl` at aimock (scripts/run-dojo-everything.js) and
 * these fixtures answer it. The request carries no model or system prompt to
 * scope on, so every prompt in the watsonx suite names "watsonx" and each
 * predicate requires it on the last user message.
 */
import type { ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { textOf } from "./lib/fixture-message-text";

export const WATSONX_PROMPTS = {
  greeting: "Hi watsonx, I am Ada",
  recallName: "watsonx, what is my name?",
  backgroundBlue: "watsonx, change the background color to blue",
  backgroundPink: "watsonx, change the background color to pink",
} as const;

export const WATSONX_REPLIES = {
  greeting: "Hello Ada! Your watsonx orchestrate agent is ready.",
  recallName: "Your name is Ada.",
  backgroundChanged: "watsonx changed the background for you.",
} as const;

const lastUserText = (request: ChatCompletionRequest): string =>
  textOf(request.messages.filter((m) => m.role === "user").pop()?.content);

const isWatsonxTurn = (request: ChatCompletionRequest): boolean =>
  /\bwatsonx\b/i.test(lastUserText(request));

// The current turn is a tool-result turn only when the conversation ends with a
// tool message; earlier tool calls in the transcript must not misroute it.
const isToolResultTurn = (request: ChatCompletionRequest): boolean =>
  request.messages[request.messages.length - 1]?.role === "tool";

const hasChangeBackgroundTool = (request: ChatCompletionRequest): boolean =>
  request.tools?.some((t) => t.function.name === "change_background") ?? false;

/** The watsonx closing turn after a frontend tool ran; answered here, not by the generic catch-all. */
export function isWatsonxToolResultTurn(
  request: ChatCompletionRequest,
): boolean {
  return isWatsonxTurn(request) && isToolResultTurn(request);
}

export function registerWatsonxFixtures(mockServer: LLMock): void {
  mockServer.addFixture({
    match: {
      endpoint: "chat",
      predicate: (request: ChatCompletionRequest) =>
        isWatsonxTurn(request) &&
        !isToolResultTurn(request) &&
        lastUserText(request).includes(WATSONX_PROMPTS.greeting),
    },
    response: { content: WATSONX_REPLIES.greeting },
  });

  // Answers from the transcript the adapter forwarded, so the reply only
  // matches when the earlier user turn reached watsonx as plain text.
  mockServer.addFixture({
    match: {
      endpoint: "chat",
      predicate: (request: ChatCompletionRequest) =>
        isWatsonxTurn(request) &&
        !isToolResultTurn(request) &&
        lastUserText(request).includes(WATSONX_PROMPTS.recallName) &&
        request.messages.some(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.includes("I am Ada"),
        ),
    },
    response: { content: WATSONX_REPLIES.recallName },
  });

  for (const color of ["blue", "pink"] as const) {
    mockServer.addFixture({
      match: {
        endpoint: "chat",
        predicate: (request: ChatCompletionRequest) =>
          isWatsonxTurn(request) &&
          !isToolResultTurn(request) &&
          hasChangeBackgroundTool(request) &&
          lastUserText(request).includes(`background color to ${color}`),
      },
      response: {
        toolCalls: [
          {
            name: "change_background",
            arguments: JSON.stringify({ background: color }),
            id: `call_watsonx_change_background_${color}`,
          },
        ],
      },
    });
  }

  mockServer.addFixture({
    match: {
      endpoint: "chat",
      predicate: isWatsonxToolResultTurn,
    },
    response: { content: WATSONX_REPLIES.backgroundChanged },
  });
}
