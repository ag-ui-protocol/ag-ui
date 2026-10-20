/**
 * Deterministic model fixtures for the Cloudflare Agents Dojo Worker
 * (integrations/community/cloudflare-agents/typescript/examples). Each
 * predicate is scoped to a phrase unique to that Worker's system prompts, so
 * these responses cannot intercept another integration.
 */
import type {
  ChatCompletionRequest,
  ChatMessage,
  LLMock,
} from "@copilotkit/aimock";

const CHAT_PROMPT = /Cloudflare Agents Dojo assistant/i;
const WEATHER_PROMPT = /Cloudflare Agents Dojo forecaster/i;

const textOf = (content: ChatMessage["content"] | undefined): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text!)
      .join("");
  }
  return "";
};

const systemText = (request: ChatCompletionRequest): string =>
  request.messages
    .filter((message) => message.role === "system")
    .map((message) => textOf(message.content))
    .join("\n");

const lastUserText = (request: ChatCompletionRequest): string =>
  textOf(request.messages.filter((m) => m.role === "user").pop()?.content);

// Only the conversation's final message decides a tool-result turn; one tool
// call earlier in history must not reroute later user turns.
// Tool-call ids must differ per turn: a client treats a repeated TOOL_CALL_START
// id as a replay and appends the new arguments to the earlier call.
const userTurn = (request: ChatCompletionRequest): number =>
  request.messages.filter((m) => m.role === "user").length;

const isToolResultTurn = (request: ChatCompletionRequest): boolean =>
  request.messages[request.messages.length - 1]?.role === "tool";

const hasTool = (request: ChatCompletionRequest, name: string): boolean =>
  !!request.tools?.some((t) => t.function.name === name);

/** True for a Cloudflare Agents tool-result turn these fixtures answer. */
export function isCloudflareAgentsToolResultTurn(
  request: ChatCompletionRequest,
): boolean {
  const system = systemText(request);
  return (
    isToolResultTurn(request) &&
    (CHAT_PROMPT.test(system) || WEATHER_PROMPT.test(system))
  );
}

export function registerCloudflareAgentsFixtures(mockServer: LLMock): void {
  // Agentic chat: frontend tool call (change_background) on request.
  mockServer.addFixture({
    match: {
      endpoint: "chat",
      predicate: (request) =>
        CHAT_PROMPT.test(systemText(request)) &&
        !isToolResultTurn(request) &&
        hasTool(request, "change_background") &&
        /background/i.test(lastUserText(request)),
    },
    response: (request) => {
      const color = /pink/i.test(lastUserText(request)) ? "pink" : "blue";
      return {
        toolCalls: [
          {
            id: `call_cf_change_background_${color}_${userTurn(request)}`,
            name: "change_background",
            arguments: JSON.stringify({ background: color }),
          },
        ],
      };
    },
  });

  // Agentic chat: plain greeting, echoing the user's name.
  mockServer.addFixture({
    match: {
      endpoint: "chat",
      predicate: (request) =>
        CHAT_PROMPT.test(systemText(request)) && !isToolResultTurn(request),
    },
    response: (request) => {
      const name = /\bI am (\w+)/i.exec(lastUserText(request))?.[1];
      return {
        content: name
          ? `Hello ${name}! I'm a Cloudflare Agent. How can I help?`
          : "Hello from a Cloudflare Agent! How can I help?",
      };
    },
  });

  // Agentic chat: reply after the frontend tool result comes back.
  mockServer.addFixture({
    match: {
      endpoint: "chat",
      predicate: (request) =>
        CHAT_PROMPT.test(systemText(request)) && isToolResultTurn(request),
    },
    response: { content: "Done, the background is updated." },
  });

  // Backend tool rendering: call the Worker's own get_weather tool.
  mockServer.addFixture({
    match: {
      endpoint: "chat",
      predicate: (request) =>
        WEATHER_PROMPT.test(systemText(request)) && !isToolResultTurn(request),
    },
    response: (request) => {
      const location = /new york/i.test(lastUserText(request))
        ? "New York"
        : "San Francisco";
      return {
        toolCalls: [
          {
            id: `call_cf_get_weather_${userTurn(request)}`,
            name: "get_weather",
            arguments: JSON.stringify({ location }),
          },
        ],
      };
    },
  });

  // Backend tool rendering: summary turn, if a client re-runs after the result.
  mockServer.addFixture({
    match: {
      endpoint: "chat",
      predicate: (request) =>
        WEATHER_PROMPT.test(systemText(request)) && isToolResultTurn(request),
    },
    response: { content: "It is sunny and 20°C." },
  });
}
