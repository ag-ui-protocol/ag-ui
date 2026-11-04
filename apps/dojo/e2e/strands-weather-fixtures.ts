import type { ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { textOf } from "./lib/fixture-message-text";

const STRANDS_WEATHER_PROMPT =
  "backend tool rendering capabilities. You can get weather information and render charts.";

export function strandsWeatherResponse(request: ChatCompletionRequest) {
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => textOf(message.content))
    .join("\n");
  if (!system.includes(STRANDS_WEATHER_PROMPT)) return undefined;
  const users = request.messages.filter((message) => message.role === "user");
  const lastUser = users.at(-1);
  const city =
    lastUser &&
    /\b(San Francisco|New York)\b/i.exec(textOf(lastUser.content))?.[1];
  if (!city) return undefined;
  const location =
    city.toLowerCase() === "san francisco" ? "San Francisco" : "New York";
  if (request.messages.at(-1)?.role === "tool") {
    return {
      content: `The weather in ${location} is sunny, with a temperature of 72 degrees.`,
    };
  }
  return {
    toolCalls: [
      {
        name: "get_weather",
        arguments: JSON.stringify({ location }),
        id: `call_strands_weather_${users.length}_${location.toLowerCase().replaceAll(" ", "_")}`,
      },
    ],
  };
}

export function registerStrandsWeatherFixtures(mockServer: LLMock) {
  mockServer.addFixture({
    match: {
      predicate: (request) => strandsWeatherResponse(request) !== undefined,
    },
    response: (request) => {
      const response = strandsWeatherResponse(request);
      if (!response)
        throw new Error("Strands weather fixture did not match this request");
      return response;
    },
  });
}
